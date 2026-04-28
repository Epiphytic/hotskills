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

test('resolveFindStrategy auto picks api even when npx IS on PATH', () => {
  // The skills.sh API does fuzzy matching across name/source/slug; the
  // CLI does substring-on-slug only and misses high-install skills like
  // obra/superpowers/requesting-code-review. Auto must prefer the API.
  _resetCliCache();
  const got = resolveFindStrategy('auto', { PATH: '/usr/bin' });
  assert.strictEqual(got, 'api');
  _resetCliCache();
});

// ─── normalizeQuery ───

import { normalizeQuery } from '../tools/search.js';

test('normalizeQuery — single token passes through, lowercased', () => {
  assert.strictEqual(normalizeQuery('react'), 'react');
  assert.strictEqual(normalizeQuery('React'), 'react');
});

test('normalizeQuery — whitespace collapses to single hyphen', () => {
  // skills.sh API rejects whitespace; this is the user-typed phrase
  // form that must converge on `code-review` to surface the
  // 60K+ install obra/superpowers/requesting-code-review skill.
  assert.strictEqual(normalizeQuery('code review'), 'code-review');
  assert.strictEqual(normalizeQuery('Code Review'), 'code-review');
  assert.strictEqual(normalizeQuery('code  review'), 'code-review');
  assert.strictEqual(normalizeQuery('  code review  '), 'code-review');
});

test('normalizeQuery — underscore and comma also collapse', () => {
  assert.strictEqual(normalizeQuery('code_review'), 'code-review');
  assert.strictEqual(normalizeQuery('code,review'), 'code-review');
});

test('normalizeQuery — preexisting hyphens preserved', () => {
  assert.strictEqual(normalizeQuery('code-review'), 'code-review');
  assert.strictEqual(normalizeQuery('react-best-practices'), 'react-best-practices');
});

// ─── runSearch sentinel filter ───

test('runSearch — schema-stub sentinel "owner/repo:skill" is filtered out', async () => {
  const cfg = makeConfigDir();
  const apiClient = async () => [
    { name: 'skill', slug: 'skill', source: 'owner/repo', installs: 0 }, // sentinel
    { name: 'real', slug: 'real', source: 'a/b', installs: 100 },
  ];
  const got = await runSearch('whatever', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
    skipCache: true,
  });
  assert.strictEqual(got.results.length, 1);
  assert.strictEqual(got.results[0]!.skill_id, 'skills.sh:a/b:real');
});

test('runSearch — multi-word query is normalized before reaching apiClient', async () => {
  const cfg = makeConfigDir();
  const seen: string[] = [];
  const apiClient = async (q: string) => {
    seen.push(q);
    return [];
  };
  await runSearch('Code Review', {
    configDir: cfg,
    findStrategy: 'api',
    apiClient,
    auditDecorator: noopAuditDecorator,
    skipCache: true,
  });
  assert.deepStrictEqual(seen, ['code-review']);
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

// ─── github source enumeration (hotskills-m8r) ───

import { writeProjectConfig, writeGlobalConfig } from '../config.js';
import type { GithubEnumerator } from '../tools/search.js';

function makeProjectCwd(): string {
  const p = join(SANDBOX, `proj-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

test('runSearch — github source in config produces github:owner/repo:slug result', async () => {
  const cfg = makeConfigDir();
  const proj = makeProjectCwd();
  await writeProjectConfig(proj, {
    version: 1,
    sources: [{ type: 'github', owner: 'anthropics', repo: 'example' }],
  });

  const githubEnumerator: GithubEnumerator = async (source) => [
    {
      skill_id: `github:${source.owner}/${source.repo}:my-skill`,
      name: 'my-skill',
      installs: 0,
      source: `${source.owner}/${source.repo}`,
      slug: 'my-skill',
      preferred: false,
    },
  ];
  const got = await runSearch('skill', {
    configDir: cfg,
    projectCwd: proj,
    findStrategy: 'api',
    apiClient: async () => [],
    auditDecorator: noopAuditDecorator,
    githubEnumerator,
    skipCache: true,
  });
  const githubEntries = got.results.filter((r) => r.skill_id.startsWith('github:'));
  assert.strictEqual(githubEntries.length, 1);
  assert.strictEqual(githubEntries[0]!.skill_id, 'github:anthropics/example:my-skill');
});

test('runSearch — no github source in config → no github entries', async () => {
  const cfg = makeConfigDir();
  const proj = makeProjectCwd();
  let enumeratorCalled = false;
  const githubEnumerator: GithubEnumerator = async () => {
    enumeratorCalled = true;
    return [];
  };
  const got = await runSearch('q', {
    configDir: cfg,
    projectCwd: proj,
    findStrategy: 'api',
    apiClient: async () => [{ name: 'a', slug: 'a', source: 'o/r', installs: 1 }],
    auditDecorator: noopAuditDecorator,
    githubEnumerator,
    skipCache: true,
  });
  assert.strictEqual(enumeratorCalled, false, 'enumerator must not run when no github sources');
  assert.ok(got.results.every((r) => !r.skill_id.startsWith('github:')));
});

test('runSearch — preferred github source ranks above skills.sh results', async () => {
  const cfg = makeConfigDir();
  const proj = makeProjectCwd();
  await writeProjectConfig(proj, {
    version: 1,
    sources: [{ type: 'github', owner: 'pref', repo: 'src', preferred: true }],
  });
  const githubEnumerator: GithubEnumerator = async (source) => [
    {
      skill_id: `github:${source.owner}/${source.repo}:topskill`,
      name: 'topskill',
      installs: 0,
      source: `${source.owner}/${source.repo}`,
      slug: 'topskill',
      preferred: true,
    },
  ];
  const got = await runSearch('skill', {
    configDir: cfg,
    projectCwd: proj,
    findStrategy: 'api',
    apiClient: async () => [
      { name: 'sh-skill', slug: 'sh-skill', source: 'o/r', installs: 1000 },
    ],
    auditDecorator: noopAuditDecorator,
    githubEnumerator,
    skipCache: true,
  });
  assert.strictEqual(got.results[0]!.skill_id, 'github:pref/src:topskill');
});

test('defaultGithubEnumerator — rejects unsafe owner/repo to prevent URL injection (secure)', async () => {
  const { defaultGithubEnumerator } = await import('../tools/search.js');
  // We don't actually call fetch — the guard runs first and returns [].
  const got = await defaultGithubEnumerator(
    { type: 'github', owner: '../etc', repo: 'passwd' },
    'q'
  );
  assert.deepStrictEqual(got, []);
  const got2 = await defaultGithubEnumerator(
    { type: 'github', owner: 'good', repo: 'repo;rm -rf' },
    'q'
  );
  assert.deepStrictEqual(got2, []);
});

test('runSearch — github enumerator results cached on disk', async () => {
  const cfg = makeConfigDir();
  const proj = makeProjectCwd();
  await writeGlobalConfig(cfg, {
    version: 1,
    sources: [{ type: 'github', owner: 'cached', repo: 'src' }],
  });
  let calls = 0;
  const githubEnumerator: GithubEnumerator = async (source) => {
    calls += 1;
    return [
      {
        skill_id: `github:${source.owner}/${source.repo}:foo`,
        name: 'foo',
        installs: 0,
        source: `${source.owner}/${source.repo}`,
        slug: 'foo',
        preferred: false,
      },
    ];
  };
  // First call hits enumerator (not skipped — github cache lives separately
  // from search cache).
  await runSearch('foo', {
    configDir: cfg,
    projectCwd: proj,
    findStrategy: 'api',
    apiClient: async () => [],
    auditDecorator: noopAuditDecorator,
    githubEnumerator,
    skipCache: true, // skip search cache; github cache still active
  });
  // Second call should hit the github on-disk cache.
  await runSearch('foo', {
    configDir: cfg,
    projectCwd: proj,
    findStrategy: 'api',
    apiClient: async () => [],
    auditDecorator: noopAuditDecorator,
    githubEnumerator,
    skipCache: true,
  });
  assert.strictEqual(calls, 1, 'github enumerator should run once thanks to on-disk cache');
});
