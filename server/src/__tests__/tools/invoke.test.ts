import { test } from 'node:test';
import assert from 'node:assert';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInvoke } from '../../tools/invoke.js';
import { writeProjectConfig } from '../../config.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';

const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};
const SKILL_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';

interface Sandbox {
  configDir: string;
  projectCwd: string;
  target: string;
  cleanup: () => void;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-tool-invoke-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectCwd, { recursive: true, mode: 0o700 });
  const target = cacheSkillPath(PARSED, configDir);
  return { configDir, projectCwd, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function activateInConfig(sb: Sandbox, skillId = SKILL_ID): Promise<void> {
  await writeProjectConfig(sb.projectCwd, {
    version: 1,
    activated: [{ skill_id: skillId, activated_at: '2026-04-23T10:00:00Z' }],
  });
}

function writeSkillTree(target: string, body: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, 'SKILL.md'), body);
}

test('runInvoke — happy path returns body, path, scripts, references with ${SKILL_PATH} substituted', async () => {
  const sb = makeSandbox();
  try {
    await activateInConfig(sb);
    writeSkillTree(sb.target, '# React\nrun ${SKILL_PATH}/scripts/x.sh and read ${SKILL_PATH}/references/y.md\n');

    mkdirSync(join(sb.target, 'scripts'), { recursive: true, mode: 0o700 });
    writeFileSync(join(sb.target, 'scripts', 'x.sh'), '#!/bin/sh\n');
    chmodSync(join(sb.target, 'scripts', 'x.sh'), 0o755);
    writeFileSync(join(sb.target, 'scripts', 'helper.txt'), 'not exec');

    mkdirSync(join(sb.target, 'references'), { recursive: true, mode: 0o700 });
    writeFileSync(join(sb.target, 'references', 'y.md'), '# Ref\n');
    writeFileSync(join(sb.target, 'references', 'note.txt'), 'not md');

    const result = await runInvoke(
      { skill_id: SKILL_ID, args: { foo: 1 } },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in result) assert.fail(`unexpected error: ${result.message}`);

    assert.strictEqual(result.path, sb.target);
    assert.ok(result.body.includes(`run ${sb.target}/scripts/x.sh`));
    assert.ok(result.body.includes(`read ${sb.target}/references/y.md`));
    assert.ok(!result.body.includes('${SKILL_PATH}'));

    assert.deepStrictEqual(
      result.scripts.map((s) => s.name).sort(),
      ['x.sh']  // helper.txt is not executable
    );
    assert.deepStrictEqual(
      result.references.map((r) => r.name).sort(),
      ['y.md']  // note.txt is not .md
    );
    assert.deepStrictEqual(result.args_passed, { foo: 1 });
  } finally {
    sb.cleanup();
  }
});

test('runInvoke — non-activated skill returns not_activated', async () => {
  const sb = makeSandbox();
  try {
    const result = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'not_activated');
    assert.ok(result.message.includes('hotskills.activate'));
  } finally {
    sb.cleanup();
  }
});

test('runInvoke — cache missing drops from allow-list and returns cache_missing', async () => {
  const sb = makeSandbox();
  try {
    await activateInConfig(sb);
    // Do NOT create the cache directory.
    const result = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'cache_missing');

    const persisted = JSON.parse(
      readFileSync(join(sb.projectCwd, '.hotskills', 'config.json'), 'utf8')
    );
    assert.strictEqual(persisted.activated.length, 0, 'allow-list entry removed');
  } finally {
    sb.cleanup();
  }
});

test('runInvoke — corrupted manifest returns manifest_corrupted', async () => {
  const sb = makeSandbox();
  try {
    await activateInConfig(sb);
    writeSkillTree(sb.target, '# Body\n');
    writeFileSync(join(sb.target, '.hotskills-manifest.json'), '{not json');

    const result = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'manifest_corrupted');
  } finally {
    sb.cleanup();
  }
});

test('runInvoke — malformed skill_id returns invalid_skill_id', async () => {
  const sb = makeSandbox();
  try {
    const result = await runInvoke(
      { skill_id: 'bad' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'invalid_skill_id');
  } finally {
    sb.cleanup();
  }
});

test('runInvoke — empty scripts/ and references/ return empty arrays', async () => {
  const sb = makeSandbox();
  try {
    await activateInConfig(sb);
    writeSkillTree(sb.target, '# No scripts here\n');
    const result = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in result) assert.fail('unexpected error');
    assert.deepStrictEqual(result.scripts, []);
    assert.deepStrictEqual(result.references, []);
  } finally {
    sb.cleanup();
  }
});

test('runInvoke — multiple ${SKILL_PATH} occurrences all replaced', async () => {
  const sb = makeSandbox();
  try {
    await activateInConfig(sb);
    writeSkillTree(sb.target, '${SKILL_PATH}/a then ${SKILL_PATH}/b and ${SKILL_PATH}/c');
    const result = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in result) assert.fail('unexpected error');
    const occurrences = result.body.split(sb.target).length - 1;
    assert.strictEqual(occurrences, 3);
    assert.ok(!result.body.includes('${SKILL_PATH}'));
  } finally {
    sb.cleanup();
  }
});

test('runInvoke — args defaults to empty object when omitted', async () => {
  const sb = makeSandbox();
  try {
    await activateInConfig(sb);
    writeSkillTree(sb.target, '# Body\n');
    const result = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in result) assert.fail('unexpected error');
    assert.deepStrictEqual(result.args_passed, {});
  } finally {
    sb.cleanup();
  }
});
