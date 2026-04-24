import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runActivate } from '../../tools/activate.js';
import { runDeactivate } from '../../tools/deactivate.js';
import { runInvoke } from '../../tools/invoke.js';
import { runList } from '../../tools/list.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';

/**
 * End-to-end round trip with all real modules wired up. Network calls
 * (audit + materialize) are stubbed at the seam, but everything else —
 * config IO, schema validation, allow-list dedupe, manifest writing,
 * ${SKILL_PATH} substitution — is the production path.
 */

const SKILL_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';
const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

interface SB {
  configDir: string;
  projectCwd: string;
  target: string;
  cleanup: () => void;
}

function makeSandbox(): SB {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-integration-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectCwd, { recursive: true, mode: 0o700 });
  return {
    configDir,
    projectCwd,
    target: cacheSkillPath(PARSED, configDir),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeMaterialize(target: string) {
  return async (_p: ParsedSkillId, _o: unknown) => {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(target, 'SKILL.md'),
      '# React\nUse ${SKILL_PATH}/scripts/run.sh to start.\n'
    );
    mkdirSync(join(target, 'scripts'), { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    return { path: target, sha: 'sha-int', reused: false };
  };
}

test('integration — activate → list → invoke → deactivate round-trip', async () => {
  const sb = makeSandbox();
  try {
    // 1. Activate
    const activateResult = await runActivate(
      { skill_id: SKILL_ID },
      {
        projectCwd: sb.projectCwd,
        configDir: sb.configDir,
        auditLookup: async () => ({ audit: null, cached: false }),
        activateOptions: {
          configDir: sb.configDir,
          materializeImpl: fakeMaterialize(sb.target),
        },
      }
    );
    if ('error' in activateResult) assert.fail(`activate failed: ${activateResult.message}`);
    assert.strictEqual(activateResult.skill_id, SKILL_ID);

    // 2. List shows it
    const listed = await runList(
      { scope: 'project' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    assert.strictEqual(listed.activated.length, 1);
    assert.strictEqual(listed.activated[0]!.skill_id, SKILL_ID);

    // 3. Invoke returns substituted body + scripts
    const invoked = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in invoked) assert.fail(`invoke failed: ${invoked.message}`);
    assert.ok(invoked.body.includes(`${sb.target}/scripts/run.sh`));
    assert.ok(!invoked.body.includes('${SKILL_PATH}'));
    assert.strictEqual(invoked.scripts.length, 1);
    assert.strictEqual(invoked.scripts[0]!.name, 'run.sh');

    // 4. Deactivate removes from allow-list (cache survives)
    const deactivated = await runDeactivate(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in deactivated) assert.fail(`deactivate failed: ${deactivated.message}`);
    assert.strictEqual(deactivated.removed, true);

    // 5. List is now empty
    const afterDeactivate = await runList(
      { scope: 'project' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    assert.strictEqual(afterDeactivate.activated.length, 0);

    // 6. Invoke after deactivate returns not_activated
    const reInvoked = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in reInvoked)) assert.fail('expected error after deactivate');
    assert.strictEqual(reInvoked.error, 'not_activated');
  } finally {
    sb.cleanup();
  }
});

test('integration — second activation of identical content is idempotent', async () => {
  const sb = makeSandbox();
  try {
    const deps = {
      projectCwd: sb.projectCwd,
      configDir: sb.configDir,
      auditLookup: async () => ({ audit: null, cached: false }),
      activateOptions: {
        configDir: sb.configDir,
        materializeImpl: fakeMaterialize(sb.target),
      },
    };
    const r1 = await runActivate({ skill_id: SKILL_ID }, deps);
    const r2 = await runActivate({ skill_id: SKILL_ID }, deps);
    if ('error' in r1 || 'error' in r2) assert.fail('unexpected error');
    assert.strictEqual(r2.reused, true);

    const listed = await runList(
      { scope: 'project' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    assert.strictEqual(listed.activated.length, 1, 'no duplicate allow-list entry');
  } finally {
    sb.cleanup();
  }
});

test('integration — invoke with stale allow-list (cache wiped) drops the entry', async () => {
  const sb = makeSandbox();
  try {
    // Activate normally.
    await runActivate(
      { skill_id: SKILL_ID },
      {
        projectCwd: sb.projectCwd,
        configDir: sb.configDir,
        auditLookup: async () => ({ audit: null, cached: false }),
        activateOptions: {
          configDir: sb.configDir,
          materializeImpl: fakeMaterialize(sb.target),
        },
      }
    );
    // Wipe cache directory simulating user `rm -rf ~/.config/hotskills/cache`.
    rmSync(sb.target, { recursive: true, force: true });

    const invoked = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in invoked)) assert.fail('expected cache_missing error');
    assert.strictEqual(invoked.error, 'cache_missing');

    const listed = await runList(
      { scope: 'project' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    assert.strictEqual(
      listed.activated.length,
      0,
      'invoke must drop the stale allow-list entry'
    );
  } finally {
    sb.cleanup();
  }
});
