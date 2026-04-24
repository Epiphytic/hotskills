import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runActivate } from '../../tools/activate.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';

function makeSandbox(): { configDir: string; projectCwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-tool-activate-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectCwd, { recursive: true, mode: 0o700 });
  return {
    configDir,
    projectCwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeMaterialize(target: string) {
  return async (_p: ParsedSkillId, _o: unknown) => {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'SKILL.md'), '# Hi\n');
    return { path: target, sha: 'sha-test', reused: false };
  };
}

const VALID_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';
const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

test('runActivate — happy path returns manifest and updates allow-list', async () => {
  const sb = makeSandbox();
  try {
    const target = cacheSkillPath(PARSED, sb.configDir);
    const result = await runActivate(
      { skill_id: VALID_ID },
      {
        projectCwd: sb.projectCwd,
        configDir: sb.configDir,
        auditLookup: async () => ({ audit: null, cached: false }),
        activateOptions: {
          configDir: sb.configDir,
          materializeImpl: fakeMaterialize(target),
        },
      }
    );

    if ('error' in result) assert.fail(`unexpected error: ${result.message}`);
    assert.strictEqual(result.skill_id, VALID_ID);
    assert.strictEqual(result.path, target);
    assert.ok(result.manifest.content_sha256.length === 64);
    assert.strictEqual(result.gate.decision, 'allow');

    // Allow-list updated.
    const persisted = JSON.parse(
      readFileSync(join(sb.projectCwd, '.hotskills', 'config.json'), 'utf8')
    );
    assert.strictEqual(persisted.activated.length, 1);
    assert.strictEqual(persisted.activated[0].skill_id, VALID_ID);
  } finally {
    sb.cleanup();
  }
});

test('runActivate — malformed skill_id returns invalid_skill_id', async () => {
  const sb = makeSandbox();
  try {
    const result = await runActivate(
      { skill_id: 'not-a-valid-id' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'invalid_skill_id');
    assert.ok(result.expected_format);
    assert.ok(result.expected_format!.includes('<source>'));
  } finally {
    sb.cleanup();
  }
});

test('runActivate — second call with identical content is idempotent', async () => {
  const sb = makeSandbox();
  try {
    const target = cacheSkillPath(PARSED, sb.configDir);
    const impl = fakeMaterialize(target);
    const deps = {
      projectCwd: sb.projectCwd,
      configDir: sb.configDir,
      auditLookup: async () => ({ audit: null, cached: false }),
      activateOptions: { configDir: sb.configDir, materializeImpl: impl },
    };

    const r1 = await runActivate({ skill_id: VALID_ID }, deps);
    const r2 = await runActivate({ skill_id: VALID_ID }, deps);
    if ('error' in r1 || 'error' in r2) assert.fail('unexpected error');
    assert.strictEqual(r2.reused, true);

    const persisted = JSON.parse(
      readFileSync(join(sb.projectCwd, '.hotskills', 'config.json'), 'utf8')
    );
    // No duplicate.
    assert.strictEqual(persisted.activated.length, 1);
  } finally {
    sb.cleanup();
  }
});

test('runActivate — gate block returns gate_blocked with layers', async () => {
  const sb = makeSandbox();
  try {
    const result = await runActivate(
      { skill_id: VALID_ID },
      {
        projectCwd: sb.projectCwd,
        configDir: sb.configDir,
        gate: async () => ({
          decision: 'block',
          reason: 'audit:snyk:high',
          layers: { whitelist: 'no-match', audit: 'block', heuristic: 'skipped', install: 'skipped' },
        }),
      }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'gate_blocked');
    assert.strictEqual(result.message, 'audit:snyk:high');
    assert.deepStrictEqual(result.layers, {
      whitelist: 'no-match',
      audit: 'block',
      heuristic: 'skipped',
      install: 'skipped',
    });
  } finally {
    sb.cleanup();
  }
});

test('runActivate — force_whitelist appends to project whitelist before gate', async () => {
  const sb = makeSandbox();
  try {
    const target = cacheSkillPath(PARSED, sb.configDir);
    const result = await runActivate(
      { skill_id: VALID_ID, force_whitelist: true },
      {
        projectCwd: sb.projectCwd,
        configDir: sb.configDir,
        auditLookup: async () => ({ audit: null, cached: false }),
        activateOptions: { configDir: sb.configDir, materializeImpl: fakeMaterialize(target) },
      }
    );
    if ('error' in result) assert.fail(`unexpected error: ${result.message}`);

    const persisted = JSON.parse(
      readFileSync(join(sb.projectCwd, '.hotskills', 'config.json'), 'utf8')
    );
    assert.ok(persisted.security?.whitelist?.skills?.includes(VALID_ID));
  } finally {
    sb.cleanup();
  }
});

test('runActivate — materialization failure returns structured error', async () => {
  const sb = makeSandbox();
  try {
    const result = await runActivate(
      { skill_id: VALID_ID },
      {
        projectCwd: sb.projectCwd,
        configDir: sb.configDir,
        auditLookup: async () => ({ audit: null, cached: false }),
        activateOptions: {
          configDir: sb.configDir,
          materializeImpl: async () => {
            throw new Error('blob 404 not found');
          },
        },
      }
    );
    if (!('error' in result)) assert.fail('expected error');
    assert.strictEqual(result.error, 'materialization_failed');
    assert.ok(result.message.includes('blob 404'));
  } finally {
    sb.cleanup();
  }
});
