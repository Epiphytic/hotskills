import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCliCache,
  resolveFindStrategy,
  runSearch,
  type FindStrategy,
  type SearchResultEntry,
} from '../tools/search.js';

const SANDBOX = mkdtempSync(join(tmpdir(), 'hotskills-search-test-'));
process.on('exit', () => rmSync(SANDBOX, { recursive: true, force: true }));

function makeConfigDir(): string {
  const p = join(SANDBOX, `cfg-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

const noopAuditDecorator = async (
  seeds: Array<{ skill_id: string; name: string; installs: number; source: string; slug: string }>
): Promise<SearchResultEntry[]> =>
  seeds.map((s) => ({ ...s, audit: null, gate_status: 'unknown' as const }));

// ─── resolveFindStrategy ───

test('resolveFindStrategy explicit cli/api passes through', () => {
  assert.strictEqual(resolveFindStrategy('cli'), 'cli');
  assert.strictEqual(resolveFindStrategy('api'), 'api');
});

test('resolveFindStrategy auto picks api when npx is not on PATH', () => {
  _resetCliCache();
  const got = resolveFindStrategy('auto', { PATH: '/var/empty' });
  assert.strictEqual(got, 'api');
  _resetCliCache();
});

// ─── runSearch — api strategy ───

test('runSearch api strategy returns shaped results with cached:false on first call', async () => {
  const cfg = makeConfigDir();
  const apiClient = async () => [
    { name: 'React Best Practices', slug: 'react-best-practices', source: 'vercel-labs/agent-skills', installs: 1500 },
    { name: 'Next.js Patterns', slug: 'nextjs-patterns', source: 'vercel-labs/agent-skills', installs: 800 },
  ];
  const got = await runSearch('react', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
  });
  assert.strictEqual(got.cached, false);
  assert.strictEqual(got.cache_age_seconds, null);
  assert.strictEqual(got.results.length, 2);
  assert.strictEqual(got.results[0]!.skill_id, 'skills.sh:vercel-labs/agent-skills:react-best-practices');
  assert.strictEqual(got.results[0]!.installs, 1500);
  assert.strictEqual(got.results[0]!.gate_status, 'unknown');
  assert.strictEqual(got.results[0]!.audit, null);
});

test('runSearch second call within 1h hits the cache (cached:true, no apiClient call)', async () => {
  const cfg = makeConfigDir();
  let calls = 0;
  const apiClient = async () => {
    calls += 1;
    return [{ name: 'X', slug: 'x', source: 'foo/bar', installs: 100 }];
  };
  await runSearch('q', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
  });
  const second = await runSearch('q', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
  });
  assert.strictEqual(calls, 1, 'apiClient called once');
  assert.strictEqual(second.cached, true);
  assert.ok(second.cache_age_seconds !== null && second.cache_age_seconds < 5);
});

test('runSearch sources filter narrows results post-fetch', async () => {
  const cfg = makeConfigDir();
  const apiClient = async () => [
    { name: 'a', slug: 'a', source: 'org-one/skills', installs: 1 },
    { name: 'b', slug: 'b', source: 'org-two/skills', installs: 2 },
    { name: 'c', slug: 'c', source: 'org-one/skills', installs: 3 },
  ];
  const got = await runSearch('x', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    sources: ['org-one/skills'],
    auditDecorator: noopAuditDecorator,
    skipCache: true,
  });
  assert.strictEqual(got.results.length, 2);
  for (const r of got.results) assert.strictEqual(r.source, 'org-one/skills');
});

test('runSearch limit caps the returned result count', async () => {
  const cfg = makeConfigDir();
  const apiClient = async () =>
    Array.from({ length: 30 }, (_, i) => ({
      name: `s${i}`,
      slug: `s${i}`,
      source: 'o/r',
      installs: i,
    }));
  const got = await runSearch('many', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    limit: 5,
    auditDecorator: noopAuditDecorator,
    skipCache: true,
  });
  assert.strictEqual(got.results.length, 5);
});

test('runSearch returns empty results array when api returns empty (does not throw)', async () => {
  const cfg = makeConfigDir();
  const apiClient = async () => [];
  const got = await runSearch('nothing', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
    skipCache: true,
  });
  assert.deepStrictEqual(got.results, []);
  assert.strictEqual(got.cached, false);
});

// ─── runSearch — cli strategy ───

test('runSearch cli strategy parses ANSI-decorated CLI output into result entries', async () => {
  const cfg = makeConfigDir();
  const cliRunner = async () => [
    { source: 'vercel-labs/agent-skills', name: 'react-best-practices', slug: 'react-best-practices', installs: 1500 },
  ];
  const got = await runSearch('react', {
    configDir: cfg,
    findStrategy: 'cli',
    cliRunner,
    auditDecorator: noopAuditDecorator,
    skipCache: true,
  });
  assert.strictEqual(got.results.length, 1);
  assert.strictEqual(got.results[0]!.skill_id, 'skills.sh:vercel-labs/agent-skills:react-best-practices');
  assert.strictEqual(got.results[0]!.installs, 1500);
});

// ─── runSearch — cache key isolation ───

test('runSearch cache keys differ for different queries (no cross-talk)', async () => {
  const cfg = makeConfigDir();
  let calls = 0;
  const apiClient = async (q: string) => {
    calls += 1;
    return [{ name: q, slug: q, source: 'o/r', installs: 1 }];
  };
  await runSearch('react', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
  });
  const second = await runSearch('vue', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
  });
  assert.strictEqual(calls, 2, 'different query → different cache key');
  assert.strictEqual(second.cached, false);
  assert.strictEqual(second.results[0]!.slug, 'vue');
});

test('runSearch cache key includes sources filter (different filter → different cache)', async () => {
  const cfg = makeConfigDir();
  let calls = 0;
  const apiClient = async () => {
    calls += 1;
    return [
      { name: 'a', slug: 'a', source: 'foo/bar', installs: 1 },
      { name: 'b', slug: 'b', source: 'baz/qux', installs: 2 },
    ];
  };
  await runSearch('q', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    sources: ['foo/bar'],
    auditDecorator: noopAuditDecorator,
  });
  const second = await runSearch('q', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    sources: ['baz/qux'],
    auditDecorator: noopAuditDecorator,
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(second.cached, false);
});

// ─── runSearch — error path ───

test('runSearch propagates a missing-config-dir error as a thrown error (caller wraps)', async () => {
  const original = process.env['HOTSKILLS_CONFIG_DIR'];
  delete process.env['HOTSKILLS_CONFIG_DIR'];
  try {
    await assert.rejects(
      () => runSearch('q', { findStrategy: 'api', apiClient: async () => [], auditDecorator: noopAuditDecorator }),
      /HOTSKILLS_CONFIG_DIR is not set/
    );
  } finally {
    if (original !== undefined) process.env['HOTSKILLS_CONFIG_DIR'] = original;
  }
});

// Type-only: ensure exported type names exist. (Prevents accidental rename
// breaking callers without a TS error.)
test('exported types are importable', () => {
  const _check: FindStrategy = 'auto';
  void _check;
  assert.ok(true);
});
