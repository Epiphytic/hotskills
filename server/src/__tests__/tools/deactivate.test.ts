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
import { join } from 'node:path';
import { runDeactivate } from '../../tools/deactivate.js';
import { writeGlobalConfig, writeProjectConfig } from '../../config.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';

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
  const root = mkdtempSync(join(tmpdir(), 'hotskills-tool-deactivate-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectCwd, { recursive: true, mode: 0o700 });
  const target = cacheSkillPath(PARSED, configDir);
  return { configDir, projectCwd, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('runDeactivate — happy path removes from project allow-list and preserves cache', async () => {
  const sb = makeSandbox();
  try {
    await writeProjectConfig(sb.projectCwd, {
      version: 1,
      activated: [{ skill_id: SKILL_ID, activated_at: '2026-04-23T00:00:00Z' }],
    });
    // Create cache dir to verify it survives.
    mkdirSync(sb.target, { recursive: true, mode: 0o700 });
    writeFileSync(join(sb.target, 'SKILL.md'), '# x\n');

    const result = await runDeactivate(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in result) assert.fail(`unexpected error: ${result.message}`);
    assert.strictEqual(result.removed, true);
    assert.strictEqual(result.cache_preserved_at, sb.target);

    const persisted = JSON.parse(
      readFileSync(join(sb.projectCwd, '.hotskills', 'config.json'), 'utf8')
    );
    assert.strictEqual(persisted.activated.length, 0);
    assert.ok(existsSync(join(sb.target, 'SKILL.md')), 'cache file must remain');
  } finally {
    sb.cleanup();
  }
});

test('runDeactivate — non-activated skill returns not_activated_in_project', async () => {
  const sb = makeSandbox();
  try {
    const result = await runDeactivate(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'not_activated_in_project');
  } finally {
    sb.cleanup();
  }
});

test('runDeactivate — malformed skill_id returns invalid_skill_id', async () => {
  const sb = makeSandbox();
  try {
    const result = await runDeactivate(
      { skill_id: 'bad' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'invalid_skill_id');
  } finally {
    sb.cleanup();
  }
});

test('runDeactivate — global allow-list unchanged after project deactivate', async () => {
  const sb = makeSandbox();
  try {
    await writeGlobalConfig(sb.configDir, {
      version: 1,
      activated: [{ skill_id: SKILL_ID, activated_at: '2026-04-22T00:00:00Z' }],
    });
    await writeProjectConfig(sb.projectCwd, {
      version: 1,
      activated: [{ skill_id: SKILL_ID, activated_at: '2026-04-23T00:00:00Z' }],
    });
    const result = await runDeactivate(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in result) assert.fail('unexpected error');
    const globalPersisted = JSON.parse(
      readFileSync(join(sb.configDir, 'config.json'), 'utf8')
    );
    assert.strictEqual(globalPersisted.activated.length, 1, 'global must be untouched');
  } finally {
    sb.cleanup();
  }
});
