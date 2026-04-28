import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuditTool } from '../../tools/audit.js';
import type { AuditLookupResult } from '../../audit.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';

function makeSandbox(): { configDir: string; projectCwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-audit-tool-test-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectCwd, { recursive: true, mode: 0o700 });
  return { configDir, projectCwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const VALID_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';
const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

function fakeLookup(audit: AuditLookupResult['audit'], cached: boolean) {
  return async (): Promise<AuditLookupResult> => ({ audit, cached });
}

test('runAuditTool — invalid skill_id returns structured error', async () => {
  const sb = makeSandbox();
  try {
    const out = await runAuditTool(
      { skill_id: 'totally bogus' },
      { configDir: sb.configDir, projectCwd: sb.projectCwd }
    );
    if (!('error' in out)) assert.fail('expected error');
    assert.strictEqual(out.error, 'invalid_skill_id');
    assert.ok(out.expected_format);
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — returns audit data with cached:false on first lookup', async () => {
  const sb = makeSandbox();
  try {
    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        projectCwd: sb.projectCwd,
        auditLookup: fakeLookup(
          { snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' } },
          false
        ),
      }
    );
    if ('error' in out) assert.fail(`unexpected: ${out.message}`);
    assert.strictEqual(out.cached, false);
    assert.ok(out.audit);
    assert.deepStrictEqual(out.audit, {
      snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
    });
    assert.ok(out.gate);
    assert.match(out.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — cached:true is propagated', async () => {
  const sb = makeSandbox();
  try {
    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        projectCwd: sb.projectCwd,
        auditLookup: fakeLookup(
          { snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' } },
          true
        ),
      }
    );
    if ('error' in out) assert.fail(`unexpected: ${out.message}`);
    assert.strictEqual(out.cached, true);
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — no audit data returns audit:null and gate decision', async () => {
  const sb = makeSandbox();
  try {
    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        projectCwd: sb.projectCwd,
        auditLookup: fakeLookup(null, false),
      }
    );
    if ('error' in out) assert.fail(`unexpected: ${out.message}`);
    assert.strictEqual(out.audit, null);
    // Default gate preview: no audit data, install gate would block (count=0,
    // owner=vercel-labs which is in built-in allowlist) → allow.
    assert.strictEqual(out.gate.decision, 'allow');
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — heuristic enabled + materialized → includes findings', async () => {
  const sb = makeSandbox();
  try {
    // Materialize a fake skill at the canonical cache path.
    const skillDir = cacheSkillPath(PARSED, sb.configDir);
    mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
allowed-tools: Bash(*)
---
`
    );

    // Project config enables heuristic.
    mkdirSync(join(sb.projectCwd, '.hotskills'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(sb.projectCwd, '.hotskills', 'config.json'),
      JSON.stringify({
        version: 1,
        security: { heuristic: { enabled: true } },
      })
    );

    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        projectCwd: sb.projectCwd,
        auditLookup: fakeLookup(null, false),
      }
    );
    if ('error' in out) assert.fail(`unexpected: ${out.message}`);
    assert.ok(out.heuristic, 'heuristic field present when enabled+materialized');
    assert.strictEqual(out.heuristic!.source, 'heuristic');
    assert.ok(out.heuristic!.findings.length >= 1);
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — heuristic enabled but skill not materialized → no heuristic field', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(join(sb.projectCwd, '.hotskills'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(sb.projectCwd, '.hotskills', 'config.json'),
      JSON.stringify({
        version: 1,
        security: { heuristic: { enabled: true } },
      })
    );

    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        projectCwd: sb.projectCwd,
        auditLookup: fakeLookup(null, false),
      }
    );
    if ('error' in out) assert.fail(`unexpected: ${out.message}`);
    assert.strictEqual(out.heuristic, undefined);
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — gate preview reflects audit decision (high risk → block)', async () => {
  const sb = makeSandbox();
  try {
    // Project config caps risk at medium.
    mkdirSync(join(sb.projectCwd, '.hotskills'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(sb.projectCwd, '.hotskills', 'config.json'),
      JSON.stringify({ version: 1, security: { risk_max: 'medium' } })
    );

    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        projectCwd: sb.projectCwd,
        auditLookup: fakeLookup(
          { snyk: { risk: 'high', analyzedAt: '2026-04-01T00:00:00Z' } },
          true
        ),
      }
    );
    if ('error' in out) assert.fail(`unexpected: ${out.message}`);
    assert.strictEqual(out.gate.decision, 'block');
    assert.match(out.gate.reason ?? '', /^audit:snyk:high$/);
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — config_error when global config is malformed', async () => {
  const sb = makeSandbox();
  try {
    writeFileSync(join(sb.configDir, 'config.json'), '{ bad json');
    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        projectCwd: sb.projectCwd,
        auditLookup: fakeLookup(null, false),
      }
    );
    if (!('error' in out)) assert.fail('expected error');
    assert.strictEqual(out.error, 'config_error');
  } finally {
    sb.cleanup();
  }
});

test('runAuditTool — projectCwd missing is OK (falls back to global only)', async () => {
  const sb = makeSandbox();
  try {
    const out = await runAuditTool(
      { skill_id: VALID_ID },
      {
        configDir: sb.configDir,
        // projectCwd intentionally omitted
        auditLookup: fakeLookup(
          { snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' } },
          false
        ),
      }
    );
    if ('error' in out) assert.fail(`unexpected: ${out.message}`);
    assert.ok(out.audit);
  } finally {
    sb.cleanup();
  }
});
