import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, logPath } from '../logger.js';

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hotskills-logger-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('logger.logPath — returns canonical path per sink', () => {
  const sb = sandbox();
  try {
    assert.strictEqual(
      logPath('whitelist', { configDir: sb.dir }),
      join(sb.dir, 'logs', 'whitelist-activations.log')
    );
    assert.strictEqual(
      logPath('audit', { configDir: sb.dir }),
      join(sb.dir, 'logs', 'audit-errors.log')
    );
    assert.strictEqual(
      logPath('hook', { configDir: sb.dir }),
      join(sb.dir, 'logs', 'hook.log')
    );
  } finally {
    sb.cleanup();
  }
});

test('logger.logPath — throws when no config dir', () => {
  const prev = process.env['HOTSKILLS_CONFIG_DIR'];
  delete process.env['HOTSKILLS_CONFIG_DIR'];
  try {
    assert.throws(() => logPath('whitelist'), /HOTSKILLS_CONFIG_DIR is not set/);
  } finally {
    if (prev !== undefined) process.env['HOTSKILLS_CONFIG_DIR'] = prev;
  }
});

test('logger.log — writes a JSON line with ts/level/event prefix and extra fields', async () => {
  const sb = sandbox();
  try {
    await log('whitelist', 'info', 'sample_event', { a: 1, b: 'x' }, { configDir: sb.dir });
    const raw = readFileSync(join(sb.dir, 'logs', 'whitelist-activations.log'), 'utf8');
    assert.strictEqual(raw.split('\n').filter(Boolean).length, 1);
    const parsed = JSON.parse(raw.trimEnd());
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.event, 'sample_event');
    assert.strictEqual(parsed.a, 1);
    assert.strictEqual(parsed.b, 'x');
  } finally {
    sb.cleanup();
  }
});

test('logger.log — debug entries are silenced unless HOTSKILLS_DEBUG=true', async () => {
  const sb = sandbox();
  const prev = process.env['HOTSKILLS_DEBUG'];
  try {
    delete process.env['HOTSKILLS_DEBUG'];
    await log('hook', 'debug', 'silenced', {}, { configDir: sb.dir });
    assert.throws(() => readFileSync(join(sb.dir, 'logs', 'hook.log'), 'utf8'), { code: 'ENOENT' });

    process.env['HOTSKILLS_DEBUG'] = 'true';
    await log('hook', 'debug', 'audible', {}, { configDir: sb.dir });
    const raw = readFileSync(join(sb.dir, 'logs', 'hook.log'), 'utf8');
    assert.match(raw, /"event":"audible"/);
  } finally {
    if (prev === undefined) delete process.env['HOTSKILLS_DEBUG'];
    else process.env['HOTSKILLS_DEBUG'] = prev;
    sb.cleanup();
  }
});

test('logger.log — log dir is created with 0700 perms (POSIX)', async () => {
  const sb = sandbox();
  try {
    await log('audit', 'warn', 'mkdir_check', {}, { configDir: sb.dir });
    const stats = statSync(join(sb.dir, 'logs'));
    // On POSIX systems the mode bits include 0700 + dir bit. We only check
    // owner perms because umask interactions can mask group/other.
    assert.strictEqual((stats.mode & 0o700) >>> 0, 0o700);
  } finally {
    sb.cleanup();
  }
});

test('logger.log — fields cannot override ts/level/event prefix', async () => {
  const sb = sandbox();
  try {
    await log(
      'audit',
      'error',
      'real_event',
      { ts: 'fake', level: 'fake', event: 'fake', extra: 'kept' },
      { configDir: sb.dir }
    );
    const raw = readFileSync(join(sb.dir, 'logs', 'audit-errors.log'), 'utf8');
    const parsed = JSON.parse(raw.trimEnd());
    assert.notStrictEqual(parsed.ts, 'fake');
    assert.strictEqual(parsed.level, 'error');
    assert.strictEqual(parsed.event, 'real_event');
    assert.strictEqual(parsed.extra, 'kept');
  } finally {
    sb.cleanup();
  }
});

test('logger.log — silently swallows when HOTSKILLS_CONFIG_DIR unset', async () => {
  const prev = process.env['HOTSKILLS_CONFIG_DIR'];
  delete process.env['HOTSKILLS_CONFIG_DIR'];
  try {
    // must not throw
    await log('hook', 'warn', 'no_sink_event', { x: 1 });
  } finally {
    if (prev !== undefined) process.env['HOTSKILLS_CONFIG_DIR'] = prev;
  }
});

test('logger.log — circular field is dropped without throwing', async () => {
  const sb = sandbox();
  try {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    await log('hook', 'warn', 'circular_test', obj, { configDir: sb.dir });
    // No log file should be written because JSON.stringify threw.
    assert.throws(
      () => readFileSync(join(sb.dir, 'logs', 'hook.log'), 'utf8'),
      { code: 'ENOENT' }
    );
  } finally {
    sb.cleanup();
  }
});
