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
import { runDeactivate } from '../../tools/deactivate.js';
import { runInvoke } from '../../tools/invoke.js';
import { runList } from '../../tools/list.js';
import { runSearch } from '../../tools/search.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';
import type { SearchSkill } from '../../vendor/vercel-skills/find.js';

/**
 * Plan-Phase 6 §6.2 (a): full search → activate → invoke → deactivate
 * roundtrip with all real modules wired. Network is mocked at two seams
 * only (search apiClient, audit auditLookup). Materialization is also
 * stubbed because it would shell out to git.
 */

const SKILL_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';
const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-roundtrip-'));
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
  return async () => {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(target, 'SKILL.md'),
      '# React best practices\nRefs: ${SKILL_PATH}/references/style.md\n'
    );
    mkdirSync(join(target, 'references'), { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'references', 'style.md'), '# style guide\n');
    return { path: target, sha: 'sha-rt', reused: false };
  };
}

test('integration — search → activate → invoke → deactivate full roundtrip', async () => {
  const sb = makeSandbox();
  try {
    // Skip cache so we hit the mocked apiClient deterministically.
    const fakeApi = async (_q: string): Promise<SearchSkill[]> => [
      {
        name: 'react-best-practices',
        source: 'vercel-labs/agent-skills',
        slug: 'react-best-practices',
        installs: 5_000_000,
        description: 'React best practices',
      } as SearchSkill,
      {
        name: 'other-skill',
        source: 'rando-org/other',
        slug: 'other-skill',
        installs: 10,
        description: 'low installs',
      } as SearchSkill,
    ];

    // 1) Search
    const search = await runSearch('react', {
      configDir: sb.configDir,
      projectCwd: sb.projectCwd,
      findStrategy: 'api',
      apiClient: fakeApi,
      auditDecorator: async (seeds) => seeds.map((s) => ({ ...s, audit: null, gate_status: 'unknown' as const })),
      skipCache: true,
    });
    assert.strictEqual(search.results.length, 2);
    const top = search.results[0]!;
    assert.strictEqual(top.skill_id, SKILL_ID);

    // 2) Activate the top result
    const act = await runActivate(
      { skill_id: top.skill_id, install_count: top.installs },
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
    if ('error' in act) assert.fail(`activate failed: ${act.message}`);
    assert.strictEqual(act.skill_id, SKILL_ID);

    // 3) Invoke
    const inv = await runInvoke(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in inv) assert.fail(`invoke failed: ${inv.message}`);
    assert.ok(inv.body.includes(`${sb.target}/references/style.md`));
    assert.ok(!inv.body.includes('${SKILL_PATH}'));
    assert.strictEqual(inv.references.length, 1);
    assert.strictEqual(inv.references[0]!.name, 'style.md');

    // 4) Deactivate
    const deact = await runDeactivate(
      { skill_id: SKILL_ID },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    if ('error' in deact) assert.fail(`deactivate failed: ${deact.message}`);
    assert.strictEqual(deact.removed, true);

    // 5) List is empty
    const listed = await runList(
      { scope: 'project' },
      { projectCwd: sb.projectCwd, configDir: sb.configDir }
    );
    assert.strictEqual(listed.activated.length, 0);

    // 6) Cache directory NOT removed by deactivate
    const skillMd = readFileSync(join(sb.target, 'SKILL.md'), 'utf8');
    assert.match(skillMd, /React best practices/);
  } finally {
    sb.cleanup();
  }
});
