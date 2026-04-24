import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LockTimeoutError,
  acquireLock,
  cacheAgeSeconds,
  cachePath,
  cacheRead,
  cacheWrite,
  releaseLock,
  withLock,
  _internals,
} from '../cache.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hotskills-cache-test-'));
}

const isPosix = process.platform !== 'win32';

test('cacheWrite + cacheRead round-trips JSON values', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'a.json');
    cacheWrite(path, { hello: 'world', n: 42 });
    const got = await cacheRead<{ hello: string; n: number }>(path, 60);
    assert.deepStrictEqual(got, { hello: 'world', n: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheRead returns null on missing file', async () => {
  const dir = makeTempDir();
  try {
    const got = await cacheRead(join(dir, 'missing.json'), 60);
    assert.strictEqual(got, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheRead returns null on corrupted JSON', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{not valid json');
    const got = await cacheRead(path, 60);
    assert.strictEqual(got, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheRead returns null when entry is older than ttl', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'stale.json');
    cacheWrite(path, { x: 1 });
    // Backdate mtime to 2h ago.
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(path, past, past);
    const got = await cacheRead(path, 3600); // ttl 1h
    assert.strictEqual(got, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheRead returns parsed value when within ttl', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'fresh.json');
    cacheWrite(path, { x: 1 });
    const got = await cacheRead<{ x: number }>(path, 3600);
    assert.deepStrictEqual(got, { x: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheRead returns null when file exceeds MAX_CACHE_BYTES (DoS guard)', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'huge.json');
    // Write 17 MiB (above the 16 MiB hard limit) of valid-looking JSON.
    // Use a single big string to keep the test fast.
    const big = '"' + 'a'.repeat(17 * 1024 * 1024) + '"';
    cacheWrite(path, big);
    const got = await cacheRead(path, 60);
    assert.strictEqual(got, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheRead returns null when validator throws (treated as schema-mismatch)', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'bad-shape.json');
    cacheWrite(path, { wrong: 'shape' });
    const got = await cacheRead(path, 60, (data) => {
      const d = data as Record<string, unknown>;
      if (typeof d.expected !== 'number') throw new Error('schema mismatch');
      return d as { expected: number };
    });
    assert.strictEqual(got, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheWrite writes files with 0600 permissions and dirs with 0700 (POSIX)', async () => {
  if (!isPosix) return; // Windows perms semantics differ; skip.
  const dir = makeTempDir();
  try {
    const path = join(dir, 'nested', 'perms.json');
    cacheWrite(path, { x: 1 });
    const fileMode = statSync(path).mode & 0o777;
    assert.strictEqual(fileMode, _internals.FILE_MODE, `file mode ${fileMode.toString(8)} != 0600`);
    const dirMode = statSync(join(dir, 'nested')).mode & 0o777;
    assert.strictEqual(dirMode, _internals.DIR_MODE, `dir mode ${dirMode.toString(8)} != 0700`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheWrite leaves no .tmp file behind on success', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'tmpcheck.json');
    cacheWrite(path, { ok: true });
    const entries = readFileSync(path, 'utf8');
    assert.strictEqual(JSON.parse(entries).ok, true);
    // No surviving .tmp.* sibling
    const fs = await import('node:fs');
    const siblings = fs.readdirSync(dir);
    const tmps = siblings.filter((f) => f.startsWith('tmpcheck.json.tmp'));
    assert.deepStrictEqual(tmps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheAgeSeconds returns null on missing file and a positive age otherwise', () => {
  const dir = makeTempDir();
  try {
    const missing = cacheAgeSeconds(join(dir, 'no-such.json'));
    assert.strictEqual(missing, null);

    const path = join(dir, 'age.json');
    cacheWrite(path, { x: 1 });
    const age = cacheAgeSeconds(path);
    assert.ok(age !== null && age >= 0 && age < 5, `age ${age} should be small and positive`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cachePath builds the documented layout', () => {
  const p = cachePath('/tmp/cfg', 'audit', 'vercel-labs-skills');
  assert.strictEqual(p, '/tmp/cfg/cache/audit/vercel-labs-skills.json');
});

// ─── Locking ───

test('acquireLock returns immediately when no contender, releaseLock removes the file', async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, 'item');
    await mkdir(target, { recursive: true });
    const handle = await acquireLock(target, 1000);
    assert.ok(_internals.pathExists(handle.path), 'lock file exists after acquire');
    releaseLock(handle);
    assert.ok(!_internals.pathExists(handle.path), 'lock file removed after release');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two concurrent acquireLock calls serialize: second waits for the first', async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, 'item');
    await mkdir(target, { recursive: true });

    const first = await acquireLock(target, 1000);
    const firstAcquiredAt = Date.now();

    let secondAcquiredAt = 0;
    const secondP = (async () => {
      const h = await acquireLock(target, 5000);
      secondAcquiredAt = Date.now();
      return h;
    })();

    // Hold lock for 200ms then release; second must wait.
    await new Promise((r) => setTimeout(r, 200));
    releaseLock(first);

    const second = await secondP;
    const waited = secondAcquiredAt - firstAcquiredAt;
    assert.ok(
      waited >= 150,
      `second acquire should wait >=150ms (waited ${waited}ms) for first to release`
    );
    releaseLock(second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock throws LockTimeoutError when contention persists past timeout', async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, 'item');
    await mkdir(target, { recursive: true });
    const first = await acquireLock(target, 1000);
    try {
      await assert.rejects(() => acquireLock(target, 200), LockTimeoutError);
    } finally {
      releaseLock(first);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseLock is idempotent (double-release does not throw)', async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, 'item');
    await mkdir(target, { recursive: true });
    const handle = await acquireLock(target, 1000);
    releaseLock(handle);
    releaseLock(handle); // no throw
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock releases the lock even when the inner function throws', async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, 'item');
    await mkdir(target, { recursive: true });
    await assert.rejects(
      () =>
        withLock(target, async () => {
          throw new Error('boom');
        }),
      /boom/
    );
    // Lock file must be gone — otherwise next acquire would block.
    assert.ok(!_internals.pathExists(`${target}.lock`), 'lock released after throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
