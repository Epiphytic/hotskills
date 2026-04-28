import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitVersionError,
  MaterializationError,
  UnsafeSkillIdError,
  assertSafeSkillId,
  cacheSkillPath,
  checkGitVersion,
  materializeSkill,
  type GitRunner,
  type ParsedSkillId,
} from '../materialize.js';

const SANDBOX = mkdtempSync(join(tmpdir(), 'hotskills-mat-test-'));
process.on('exit', () => rmSync(SANDBOX, { recursive: true, force: true }));

function makeConfigDir(): string {
  const p = join(SANDBOX, `cfg-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

// ─── Sanitization ───

test('assertSafeSkillId rejects shell metacharacters in owner/repo/slug', () => {
  for (const field of ['owner', 'repo', 'slug'] as const) {
    const parsed: ParsedSkillId = {
      source: 'github',
      owner: 'a',
      repo: 'b',
      slug: 'c',
    };
    parsed[field] = 'evil; rm -rf /';
    assert.throws(() => assertSafeSkillId(parsed), UnsafeSkillIdError);
  }
});

test('assertSafeSkillId rejects path-traversal in slug', () => {
  assert.throws(
    () => assertSafeSkillId({ source: 'github', owner: 'o', repo: 'r', slug: '../etc/passwd' }),
    UnsafeSkillIdError
  );
});

test('assertSafeSkillId accepts valid identifiers (hyphens, dots, underscores)', () => {
  assert.doesNotThrow(() =>
    assertSafeSkillId({ source: 'github', owner: 'vercel-labs', repo: 'agent.skills_v2', slug: 'react-best-practices' })
  );
});

// ─── Path computation ───

test('cacheSkillPath builds the documented layout', () => {
  const p = cacheSkillPath(
    { source: 'skills.sh', owner: 'vercel-labs', repo: 'agent-skills', slug: 'react' },
    '/tmp/cfg'
  );
  assert.strictEqual(p, '/tmp/cfg/cache/skills/skills.sh/vercel-labs/agent-skills/react');
});

test('cacheSkillPath rejects unsafe source values', () => {
  assert.throws(
    () =>
      cacheSkillPath(
        { source: '../evil', owner: 'o', repo: 'r', slug: 's' },
        '/tmp/cfg'
      ),
    MaterializationError
  );
});

// ─── git version check ───

test('checkGitVersion throws GitVersionError when git binary is missing', async () => {
  const fakeGit: GitRunner = async () => {
    throw new GitVersionError(null);
  };
  await assert.rejects(() => checkGitVersion(fakeGit), GitVersionError);
});

test('checkGitVersion throws GitVersionError when git is older than 2.25', async () => {
  const fakeGit: GitRunner = async () => 'git version 2.20.1\n';
  await assert.rejects(() => checkGitVersion(fakeGit), GitVersionError);
});

test('checkGitVersion accepts git >= 2.25 and returns the version string', async () => {
  const fakeGit: GitRunner = async () => 'git version 2.34.1\n';
  const v = await checkGitVersion(fakeGit);
  assert.strictEqual(v, '2.34.1');
});

test('checkGitVersion accepts git equal to the exact minimum 2.25.0', async () => {
  const fakeGit: GitRunner = async () => 'git version 2.25.0\n';
  const v = await checkGitVersion(fakeGit);
  assert.strictEqual(v, '2.25.0');
});

// ─── skills.sh path ───

test('materializeSkill skills.sh path writes blob files into the cache layout', async () => {
  const cfg = makeConfigDir();
  const parsed: ParsedSkillId = {
    source: 'skills.sh',
    owner: 'vercel-labs',
    repo: 'agent-skills',
    slug: 'react-best-practices',
  };

  const fakeBlob: typeof import('../vendor/vercel-skills/blob.js').tryBlobInstall = async () => ({
    skills: [
      {
        name: 'React Best Practices',
        description: 'desc',
        path: '',
        rawContent: '---\nname: React Best Practices\n---\nbody',
        files: [
          {
            path: 'skills/react-best-practices/SKILL.md',
            contents: '---\nname: React Best Practices\n---\nfull body',
          },
          {
            path: 'skills/react-best-practices/scripts/setup.sh',
            contents: '#!/bin/bash\necho hi',
          },
        ],
        snapshotHash: 'abc123',
        repoPath: 'skills/react-best-practices/SKILL.md',
      },
    ],
    tree: { sha: 'tree', branch: 'main', tree: [] },
  });

  const result = await materializeSkill(parsed, { configDir: cfg, blobInstall: fakeBlob });
  const expected = join(cfg, 'cache', 'skills', 'skills.sh', 'vercel-labs', 'agent-skills', 'react-best-practices');
  assert.strictEqual(result.path, expected);
  assert.strictEqual(result.sha, 'abc123');
  assert.ok(existsSync(join(expected, 'SKILL.md')));
  assert.ok(existsSync(join(expected, 'scripts', 'setup.sh')));
  assert.strictEqual(
    readFileSync(join(expected, 'SKILL.md'), 'utf8'),
    '---\nname: React Best Practices\n---\nfull body'
  );
});

test('materializeSkill skills.sh rejects blob results with path-traversal', async () => {
  const cfg = makeConfigDir();
  const parsed: ParsedSkillId = {
    source: 'skills.sh',
    owner: 'o',
    repo: 'r',
    slug: 's',
  };
  const fakeBlob: typeof import('../vendor/vercel-skills/blob.js').tryBlobInstall = async () => ({
    skills: [
      {
        name: 's',
        description: 'd',
        path: '',
        rawContent: '',
        files: [{ path: '../../../../etc/passwd', contents: 'evil' }],
        snapshotHash: 'x',
        repoPath: 'skills/s/SKILL.md',
      },
    ],
    tree: { sha: 't', branch: 'main', tree: [] },
  });
  await assert.rejects(
    () => materializeSkill(parsed, { configDir: cfg, blobInstall: fakeBlob }),
    MaterializationError
  );
});

test('materializeSkill skills.sh fails cleanly when blob install returns null', async () => {
  const cfg = makeConfigDir();
  const fakeBlob: typeof import('../vendor/vercel-skills/blob.js').tryBlobInstall = async () => null;
  await assert.rejects(
    () =>
      materializeSkill(
        { source: 'skills.sh', owner: 'o', repo: 'r', slug: 's' },
        { configDir: cfg, blobInstall: fakeBlob }
      ),
    MaterializationError
  );
});

// ─── github path ───

test('materializeSkill github path runs sparse-checkout and atomically swaps', async () => {
  const cfg = makeConfigDir();
  const parsed: ParsedSkillId = {
    source: 'github',
    owner: 'octo',
    repo: 'sample-skills',
    slug: 'demo',
  };

  // Track what `git` was called with so we can verify spawn args.
  const calls: string[][] = [];
  const fakeGit: GitRunner = async (args, opts) => {
    calls.push(args);
    if (args[0] === '--version') return 'git version 2.40.0\n';

    if (args[0] === 'clone') {
      // Last positional arg is target dir; pre-populate with the expected
      // checked-out tree.
      const target = args[args.length - 1]!;
      mkdirSync(target, { recursive: true });
      // sparse-checkout will be called next; we need the candidate dirs
      // to materialize on the 'set' call below, not here.
      return '';
    }

    if (args[0] === '-C' && args[2] === 'sparse-checkout' && args[3] === 'set') {
      const repoDir = args[1]!;
      // The first matching candidate per ADR-002 §7 is `slug` itself
      // (root-level), then `skills/<slug>`. We materialize `skills/demo/`.
      mkdirSync(join(repoDir, 'skills', 'demo'), { recursive: true });
      writeFileSync(
        join(repoDir, 'skills', 'demo', 'SKILL.md'),
        '---\nname: demo\n---\nbody'
      );
      return '';
    }

    if (args[0] === '-C' && args[2] === 'rev-parse') {
      return 'abc123def\n';
    }

    if (args[0] === '-C' && args[2] === 'sparse-checkout' && args[3] === 'init') {
      return '';
    }

    return '';
  };

  const result = await materializeSkill(parsed, { configDir: cfg, git: fakeGit });
  const expected = join(cfg, 'cache', 'skills', 'github', 'octo', 'sample-skills', 'demo');
  assert.strictEqual(result.path, expected);
  assert.strictEqual(result.sha, 'abc123def');
  assert.ok(existsSync(join(expected, 'SKILL.md')));
  assert.ok(existsSync(join(expected, '.hotskills-source.json')));

  // Verify clone command shape.
  const clone = calls.find((c) => c[0] === 'clone')!;
  assert.deepStrictEqual(clone.slice(0, 5), ['clone', '--depth', '1', '--filter=blob:none', '--sparse']);
  assert.strictEqual(clone[5], 'https://github.com/octo/sample-skills.git');
});

test('materializeSkill github path emits remediation when git is missing', async () => {
  const cfg = makeConfigDir();
  const fakeGit: GitRunner = async () => {
    throw new GitVersionError(null);
  };
  await assert.rejects(
    () =>
      materializeSkill(
        { source: 'github', owner: 'o', repo: 'r', slug: 's' },
        { configDir: cfg, git: fakeGit }
      ),
    GitVersionError
  );
});

test('materializeSkill github path rejects a clone containing symlinks (security)', async () => {
  const cfg = makeConfigDir();
  const parsed: ParsedSkillId = {
    source: 'github',
    owner: 'evil',
    repo: 'skills',
    slug: 'demo',
  };
  const fakeGit: GitRunner = async (args) => {
    if (args[0] === '--version') return 'git version 2.40.0\n';
    if (args[0] === 'clone') {
      const target = args[args.length - 1]!;
      mkdirSync(target, { recursive: true });
      return '';
    }
    if (args[0] === '-C' && args[2] === 'sparse-checkout' && args[3] === 'set') {
      const repoDir = args[1]!;
      const skillDir = join(repoDir, 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nbody');
      // Plant an evil symlink → /etc/passwd
      symlinkSync('/etc/passwd', join(skillDir, 'pwned'));
      return '';
    }
    if (args[0] === '-C' && args[2] === 'rev-parse') return 'abc\n';
    return '';
  };
  await assert.rejects(
    () => materializeSkill(parsed, { configDir: cfg, git: fakeGit }),
    /unsafe symlink/
  );
});

test('materializeSkill github path errors when no candidate skill subdir exists in repo', async () => {
  const cfg = makeConfigDir();
  const fakeGit: GitRunner = async (args) => {
    if (args[0] === '--version') return 'git version 2.40.0\n';
    if (args[0] === 'clone') {
      const target = args[args.length - 1]!;
      mkdirSync(target, { recursive: true });
      return '';
    }
    return '';
  };
  await assert.rejects(
    () =>
      materializeSkill(
        { source: 'github', owner: 'o', repo: 'r', slug: 'nope' },
        { configDir: cfg, git: fakeGit }
      ),
    MaterializationError
  );
});

// ─── Concurrency / lock ───

test('materializeSkill serializes concurrent activations of the same skill (lock)', async () => {
  const cfg = makeConfigDir();
  const parsed: ParsedSkillId = {
    source: 'skills.sh',
    owner: 'vercel-labs',
    repo: 'agent-skills',
    slug: 'react-best-practices',
  };

  let inFlight = 0;
  let maxInFlight = 0;
  const fakeBlob: typeof import('../vendor/vercel-skills/blob.js').tryBlobInstall = async () => {
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await new Promise((r) => setTimeout(r, 50));
    inFlight -= 1;
    return {
      skills: [
        {
          name: 'r',
          description: 'd',
          path: '',
          rawContent: '',
          files: [
            { path: 'skills/react-best-practices/SKILL.md', contents: 'body' },
          ],
          snapshotHash: 'sha',
          repoPath: 'skills/react-best-practices/SKILL.md',
        },
      ],
      tree: { sha: 't', branch: 'main', tree: [] },
    };
  };

  const [a, b] = await Promise.all([
    materializeSkill(parsed, { configDir: cfg, blobInstall: fakeBlob }),
    materializeSkill(parsed, { configDir: cfg, blobInstall: fakeBlob }),
  ]);
  assert.strictEqual(a.path, b.path);
  assert.strictEqual(maxInFlight, 1, `lock should serialize activations (saw ${maxInFlight} concurrent)`);
});

// ─── source dispatch ───

test('materializeSkill rejects unknown sources', async () => {
  const cfg = makeConfigDir();
  await assert.rejects(
    () =>
      materializeSkill(
        { source: 'somethingelse', owner: 'o', repo: 'r', slug: 's' },
        { configDir: cfg }
      ),
    MaterializationError
  );
});

test('materializeSkill rejects raw git sources in v0 with a clear message', async () => {
  const cfg = makeConfigDir();
  await assert.rejects(
    () =>
      materializeSkill(
        { source: 'git', owner: 'o', repo: 'r', slug: 's' },
        { configDir: cfg }
      ),
    /not yet supported in v0/
  );
});
