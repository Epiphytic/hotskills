import { test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runActivate } from '../../tools/activate.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';
import { log } from '../../logger.js';

/**
 * Plan-Phase 6 §6.1 acceptance: after a whitelist activation,
 * whitelist-activations.log gets a JSON line; after an audit fetch
 * failure, audit-errors.log gets a JSON line; after a hook script
 * write attempt with HOTSKILLS_DEBUG, hook.log gets a JSON line.
 *
 * All three sinks share the canonical {ts, level, event, ...} prefix.
 */

// dist/__tests__/integration/<file> — go up 4 to reach the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const HOOK = join(repoRoot, 'scripts', 'inject-reminders.sh');

const VERCEL_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';
const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-logsinks-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectCwd, { recursive: true, mode: 0o700 });
  return { root, configDir, projectCwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('log-sinks — whitelist match writes structured JSON line', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(join(sb.projectCwd, '.hotskills'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(sb.projectCwd, '.hotskills', 'config.json'),
      JSON.stringify({ version: 1, security: { whitelist: { orgs: ['vercel-labs'] } } })
    );

    const target = cacheSkillPath(PARSED, sb.configDir);
    const fakeMaterialize = async () => {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      writeFileSync(join(target, 'SKILL.md'), '# x\n');
      return { path: target, sha: 's', reused: false };
    };

    const r = await runActivate(
      { skill_id: VERCEL_ID, install_count: 0 },
      {
        projectCwd: sb.projectCwd,
        configDir: sb.configDir,
        auditLookup: async () => ({ audit: null, cached: false }),
        activateOptions: {
          configDir: sb.configDir,
          materializeImpl: fakeMaterialize,
        },
      }
    );
    if ('error' in r) assert.fail(`activate: ${r.message}`);

    const path = join(sb.configDir, 'logs', 'whitelist-activations.log');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw.trimEnd());
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.event, 'whitelist_activation');
    assert.strictEqual(parsed.skill_id, VERCEL_ID);
    assert.strictEqual(parsed.scope, 'org');
    assert.strictEqual(parsed.matched_entry, 'vercel-labs');
  } finally {
    sb.cleanup();
  }
});

test('log-sinks — audit-errors.log shape matches the canonical sink format', async () => {
  // We exercise the canonical sink directly via the shared logger because
  // forcing the live audit client to fail deterministically requires
  // network mocking that's outside this test's scope (covered by
  // audit.test.ts at the seam). The point of this integration test is
  // that all three sinks write through the same code path and produce
  // the same line shape — verifying that here keeps Phase 6 §6.1's
  // acceptance criteria (canonical {ts, level, event, ...} JSON) honest
  // for all three files.
  const sb = makeSandbox();
  try {
    await log(
      'audit',
      'warn',
      'audit_error',
      { skill_id: VERCEL_ID, reason: 'no_data_from_api' },
      { configDir: sb.configDir }
    );
    const path = join(sb.configDir, 'logs', 'audit-errors.log');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw.trimEnd());
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.strictEqual(parsed.level, 'warn');
    assert.strictEqual(parsed.event, 'audit_error');
    assert.strictEqual(parsed.skill_id, VERCEL_ID);
    assert.strictEqual(parsed.reason, 'no_data_from_api');
  } finally {
    sb.cleanup();
  }
});

test('log-sinks — hook script logs unknown event arg as warn JSON', () => {
  const sb = makeSandbox();
  try {
    mkdirSync(join(sb.projectCwd, '.hotskills'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(sb.projectCwd, '.hotskills', 'config.json'),
      JSON.stringify({ version: 1, activated: [] })
    );
    spawnSync('bash', [HOOK, '--event=NotAnEvent'], {
      env: {
        ...process.env,
        HOTSKILLS_CONFIG_DIR: sb.configDir,
        HOTSKILLS_PROJECT_CWD: sb.projectCwd,
        CLAUDE_PROJECT_DIR: sb.projectCwd,
      },
      encoding: 'utf8',
      timeout: 5000,
    });

    const path = join(sb.configDir, 'logs', 'hook.log');
    assert.ok(existsSync(path), `expected hook log at ${path}`);
    const raw = readFileSync(path, 'utf8');
    const lines = raw.trimEnd().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const parsed = JSON.parse(lines[0]!);
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.strictEqual(parsed.level, 'warn');
    assert.strictEqual(parsed.event, 'unknown_event_arg');
    assert.strictEqual(parsed.got, 'NotAnEvent');
  } finally {
    sb.cleanup();
  }
});
