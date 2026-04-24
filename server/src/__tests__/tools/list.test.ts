import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runList } from '../../tools/list.js';
import { writeGlobalConfig, writeProjectConfig } from '../../config.js';

interface SB {
  configDir: string;
  projectCwd: string;
  cleanup: () => void;
}

function makeSandbox(): SB {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-tool-list-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectCwd, { recursive: true, mode: 0o700 });
  return { configDir, projectCwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('runList — empty configs return empty arrays for all scopes', async () => {
  const sb = makeSandbox();
  try {
    for (const scope of ['project', 'global', 'merged'] as const) {
      const r = await runList({ scope }, { projectCwd: sb.projectCwd, configDir: sb.configDir });
      assert.deepStrictEqual(r, { scope, activated: [] });
    }
  } finally {
    sb.cleanup();
  }
});

test('runList — scope=project returns only project entries', async () => {
  const sb = makeSandbox();
  try {
    await writeGlobalConfig(sb.configDir, {
      version: 1,
      activated: [{ skill_id: 'skills.sh:g/r:x', activated_at: '2026-04-22T00:00:00Z' }],
    });
    await writeProjectConfig(sb.projectCwd, {
      version: 1,
      activated: [{ skill_id: 'skills.sh:p/r:y', activated_at: '2026-04-23T00:00:00Z' }],
    });
    const r = await runList({ scope: 'project' }, { projectCwd: sb.projectCwd, configDir: sb.configDir });
    assert.strictEqual(r.activated.length, 1);
    assert.strictEqual(r.activated[0]!.skill_id, 'skills.sh:p/r:y');
  } finally {
    sb.cleanup();
  }
});

test('runList — scope=global returns only global entries', async () => {
  const sb = makeSandbox();
  try {
    await writeGlobalConfig(sb.configDir, {
      version: 1,
      activated: [{ skill_id: 'skills.sh:g/r:x', activated_at: '2026-04-22T00:00:00Z' }],
    });
    const r = await runList({ scope: 'global' }, { projectCwd: sb.projectCwd, configDir: sb.configDir });
    assert.strictEqual(r.activated.length, 1);
    assert.strictEqual(r.activated[0]!.skill_id, 'skills.sh:g/r:x');
  } finally {
    sb.cleanup();
  }
});

test('runList — scope=merged returns dedup union, newer activated_at wins on overlap', async () => {
  const sb = makeSandbox();
  try {
    await writeGlobalConfig(sb.configDir, {
      version: 1,
      activated: [
        { skill_id: 'skills.sh:o/r:c', activated_at: '2026-04-22T00:00:00Z' },
      ],
    });
    await writeProjectConfig(sb.projectCwd, {
      version: 1,
      activated: [
        { skill_id: 'skills.sh:o/r:c', activated_at: '2026-04-23T00:00:00Z' },
        { skill_id: 'skills.sh:o/r:d', activated_at: '2026-04-23T00:00:00Z' },
      ],
    });
    const r = await runList({ scope: 'merged' }, { projectCwd: sb.projectCwd, configDir: sb.configDir });
    assert.strictEqual(r.activated.length, 2);
    const c = r.activated.find((a) => a.skill_id === 'skills.sh:o/r:c');
    assert.strictEqual(c?.activated_at, '2026-04-23T00:00:00Z');
  } finally {
    sb.cleanup();
  }
});

test('runList — default scope is merged', async () => {
  const sb = makeSandbox();
  try {
    await writeProjectConfig(sb.projectCwd, {
      version: 1,
      activated: [{ skill_id: 'skills.sh:p/r:y', activated_at: '2026-04-23T00:00:00Z' }],
    });
    const r = await runList({}, { projectCwd: sb.projectCwd, configDir: sb.configDir });
    assert.strictEqual(r.scope, 'merged');
  } finally {
    sb.cleanup();
  }
});
