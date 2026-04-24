import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkWhitelist,
  matchWhitelist,
  whitelistLogPath,
} from '../../gate/whitelist.js';
import type { HotskillsConfig } from '../../config.js';
import type { ParsedSkillId } from '../../skill-id.js';

function makeSandbox(): { configDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-whitelist-test-'));
  return { configDir: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};
const SKILL_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';

test('matchWhitelist — skills entry exact-matches → allow with scope=skill', () => {
  const cfg: HotskillsConfig = {
    version: 1,
    security: { whitelist: { skills: [SKILL_ID] } },
  };
  const out = matchWhitelist(PARSED, cfg);
  assert.strictEqual(out.allow, true);
  if (out.allow) {
    assert.strictEqual(out.match.scope, 'skill');
    assert.strictEqual(out.match.matched_entry, SKILL_ID);
  }
});

test('matchWhitelist — repos entry (owner/repo) → allow with scope=repo', () => {
  const cfg: HotskillsConfig = {
    version: 1,
    security: { whitelist: { repos: ['vercel-labs/agent-skills'] } },
  };
  const out = matchWhitelist(PARSED, cfg);
  assert.strictEqual(out.allow, true);
  if (out.allow) {
    assert.strictEqual(out.match.scope, 'repo');
    assert.strictEqual(out.match.matched_entry, 'vercel-labs/agent-skills');
  }
});

test('matchWhitelist — orgs entry (owner) → allow with scope=org', () => {
  const cfg: HotskillsConfig = {
    version: 1,
    security: { whitelist: { orgs: ['vercel-labs'] } },
  };
  const out = matchWhitelist(PARSED, cfg);
  assert.strictEqual(out.allow, true);
  if (out.allow) {
    assert.strictEqual(out.match.scope, 'org');
    assert.strictEqual(out.match.matched_entry, 'vercel-labs');
  }
});

test('matchWhitelist — no match → allow=false', () => {
  const cfg: HotskillsConfig = {
    version: 1,
    security: { whitelist: { orgs: ['anthropics'], repos: ['microsoft/edge'] } },
  };
  const out = matchWhitelist(PARSED, cfg);
  assert.strictEqual(out.allow, false);
});

test('matchWhitelist — no whitelist at all → allow=false', () => {
  const cfg: HotskillsConfig = { version: 1 };
  const out = matchWhitelist(PARSED, cfg);
  assert.strictEqual(out.allow, false);
});

test('matchWhitelist — skill match takes priority over repo and org', () => {
  const cfg: HotskillsConfig = {
    version: 1,
    security: {
      whitelist: {
        skills: [SKILL_ID],
        repos: ['vercel-labs/agent-skills'],
        orgs: ['vercel-labs'],
      },
    },
  };
  const out = matchWhitelist(PARSED, cfg);
  assert.strictEqual(out.allow, true);
  if (out.allow) assert.strictEqual(out.match.scope, 'skill');
});

test('matchWhitelist — owner match alone does not satisfy repo whitelist', () => {
  const cfg: HotskillsConfig = {
    version: 1,
    security: { whitelist: { repos: ['vercel-labs'] } }, // missing /repo
  };
  const out = matchWhitelist(PARSED, cfg);
  assert.strictEqual(out.allow, false);
});

test('checkWhitelist — on match, writes JSON line to whitelist-activations.log', async () => {
  const sb = makeSandbox();
  try {
    const cfg: HotskillsConfig = {
      version: 1,
      security: { whitelist: { orgs: ['vercel-labs'] } },
    };
    const out = await checkWhitelist(PARSED, cfg, { configDir: sb.configDir });
    assert.strictEqual(out.allow, true);

    const log = readFileSync(whitelistLogPath(sb.configDir), 'utf8');
    const lines = log.trimEnd().split('\n');
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.strictEqual(parsed.skill_id, SKILL_ID);
    assert.strictEqual(parsed.scope, 'org');
    assert.strictEqual(parsed.matched_entry, 'vercel-labs');
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    sb.cleanup();
  }
});

test('checkWhitelist — no match, no log line written', async () => {
  const sb = makeSandbox();
  try {
    const cfg: HotskillsConfig = {
      version: 1,
      security: { whitelist: { orgs: ['someone-else'] } },
    };
    const out = await checkWhitelist(PARSED, cfg, { configDir: sb.configDir });
    assert.strictEqual(out.allow, false);

    // Log file should not exist.
    assert.throws(
      () => readFileSync(whitelistLogPath(sb.configDir), 'utf8'),
      { code: 'ENOENT' }
    );
  } finally {
    sb.cleanup();
  }
});

test('checkWhitelist — skipLog suppresses the log write', async () => {
  const sb = makeSandbox();
  try {
    const cfg: HotskillsConfig = {
      version: 1,
      security: { whitelist: { orgs: ['vercel-labs'] } },
    };
    const out = await checkWhitelist(PARSED, cfg, {
      configDir: sb.configDir,
      skipLog: true,
    });
    assert.strictEqual(out.allow, true);

    assert.throws(
      () => readFileSync(whitelistLogPath(sb.configDir), 'utf8'),
      { code: 'ENOENT' }
    );
  } finally {
    sb.cleanup();
  }
});

test('checkWhitelist — 5 concurrent activations produce 5 valid JSON lines (no corruption)', async () => {
  const sb = makeSandbox();
  try {
    const cfg: HotskillsConfig = {
      version: 1,
      security: { whitelist: { orgs: ['vercel-labs'] } },
    };
    const N = 5;
    const promises = Array.from({ length: N }, (_, i) =>
      checkWhitelist(
        { ...PARSED, slug: `skill-${i}` },
        cfg,
        { configDir: sb.configDir }
      )
    );
    const results = await Promise.all(promises);
    for (const r of results) assert.strictEqual(r.allow, true);

    const log = readFileSync(whitelistLogPath(sb.configDir), 'utf8');
    const lines = log.trimEnd().split('\n');
    assert.strictEqual(lines.length, N, `expected ${N} lines, got ${lines.length}`);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.strictEqual(parsed.scope, 'org');
      assert.match(parsed.skill_id, /^skills\.sh:vercel-labs\/agent-skills:skill-\d+$/);
    }
  } finally {
    sb.cleanup();
  }
});

test('checkWhitelist — overlong matched_entry is truncated', async () => {
  const sb = makeSandbox();
  try {
    const giant = 'x'.repeat(2000);
    const cfg: HotskillsConfig = {
      version: 1,
      security: { whitelist: { orgs: [giant] } },
    };
    // Use a parsed id whose owner matches the giant entry.
    const parsed: ParsedSkillId = { ...PARSED, owner: giant };
    const out = await checkWhitelist(parsed, cfg, { configDir: sb.configDir });
    assert.strictEqual(out.allow, true);

    const log = readFileSync(whitelistLogPath(sb.configDir), 'utf8');
    const parsedLog = JSON.parse(log.trimEnd());
    assert.ok(parsedLog.matched_entry.length < giant.length);
    assert.ok(parsedLog.matched_entry.endsWith('…'));
  } finally {
    sb.cleanup();
  }
});
