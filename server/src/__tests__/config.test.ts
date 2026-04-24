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
import {
  ConfigSchemaError,
  ConfigUpgradeRequiredError,
  CONFIG_TARGET_VERSION,
  mergeConfigs,
  patchGitignore,
  readGlobalConfig,
  readProjectConfig,
  readProjectState,
  writeGlobalConfig,
  writeProjectConfig,
  writeProjectState,
  type HotskillsConfig,
} from '../config.js';
import { _resetRegistry, registerMigration } from '../migrations/index.js';

function makeProjectCwd(): string {
  return mkdtempSync(join(tmpdir(), 'hotskills-config-test-proj-'));
}

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'hotskills-config-test-cfg-'));
}

test('readGlobalConfig — missing file returns defaults', async () => {
  const cfg = makeConfigDir();
  try {
    const got = await readGlobalConfig(cfg);
    assert.deepStrictEqual(got, { version: CONFIG_TARGET_VERSION });
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('readProjectConfig — missing file returns defaults', async () => {
  const proj = makeProjectCwd();
  try {
    const got = await readProjectConfig(proj);
    assert.deepStrictEqual(got, { version: CONFIG_TARGET_VERSION });
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('readProjectConfig — valid v1 config parses correctly', async () => {
  const proj = makeProjectCwd();
  try {
    mkdirSync(join(proj, '.hotskills'), { recursive: true, mode: 0o700 });
    const cfg: HotskillsConfig = {
      version: 1,
      mode: 'auto',
      activated: [
        { skill_id: 'skills.sh:o/r:x', activated_at: '2026-04-23T10:00:00Z' },
      ],
    };
    writeFileSync(join(proj, '.hotskills', 'config.json'), JSON.stringify(cfg));
    const got = await readProjectConfig(proj);
    assert.strictEqual(got.mode, 'auto');
    assert.strictEqual(got.activated?.length, 1);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('readProjectConfig — schema-invalid config throws ConfigSchemaError', async () => {
  const proj = makeProjectCwd();
  try {
    mkdirSync(join(proj, '.hotskills'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(proj, '.hotskills', 'config.json'),
      JSON.stringify({ version: 1, mode: 'unknown_mode' })
    );
    await assert.rejects(readProjectConfig(proj), ConfigSchemaError);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('readProjectConfig — JSON parse error throws ConfigSchemaError', async () => {
  const proj = makeProjectCwd();
  try {
    mkdirSync(join(proj, '.hotskills'), { recursive: true, mode: 0o700 });
    writeFileSync(join(proj, '.hotskills', 'config.json'), '{not json');
    await assert.rejects(readProjectConfig(proj), ConfigSchemaError);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('readProjectConfig — version 99 throws ConfigUpgradeRequiredError', async () => {
  const proj = makeProjectCwd();
  try {
    mkdirSync(join(proj, '.hotskills'), { recursive: true, mode: 0o700 });
    const path = join(proj, '.hotskills', 'config.json');
    writeFileSync(path, JSON.stringify({ version: 99 }));
    await assert.rejects(readProjectConfig(proj), ConfigUpgradeRequiredError);
    // Original file untouched.
    assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 99 });
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('readProjectConfig — registered v0->v1 migration upgrades and writes back', async () => {
  const proj = makeProjectCwd();
  try {
    _resetRegistry();
    registerMigration({
      from: 0,
      to: 1,
      apply: (raw) => ({ ...(raw as object), version: 1, mode: 'interactive' }),
    });
    mkdirSync(join(proj, '.hotskills'), { recursive: true, mode: 0o700 });
    const path = join(proj, '.hotskills', 'config.json');
    writeFileSync(path, JSON.stringify({ version: 0 }));

    const got = await readProjectConfig(proj);
    assert.strictEqual(got.version, 1);
    assert.strictEqual(got.mode, 'interactive');

    // Upgraded form was written back.
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(persisted.version, 1);
    assert.strictEqual(persisted.mode, 'interactive');
  } finally {
    rmSync(proj, { recursive: true, force: true });
    _resetRegistry();
  }
});

test('writeProjectConfig — auto-creates .hotskills/ with 0700 perms', async () => {
  const proj = makeProjectCwd();
  try {
    await writeProjectConfig(proj, { version: 1, mode: 'auto' });
    const stat = await import('node:fs').then((fs) =>
      fs.statSync(join(proj, '.hotskills'))
    );
    if (process.platform !== 'win32') {
      assert.strictEqual(stat.mode & 0o777, 0o700);
    }
    assert.ok(existsSync(join(proj, '.hotskills', 'config.json')));
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('writeProjectConfig — refuses invalid config', async () => {
  const proj = makeProjectCwd();
  try {
    await assert.rejects(
      // @ts-expect-error intentionally invalid mode
      writeProjectConfig(proj, { version: 1, mode: 'bad' }),
      ConfigSchemaError
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('writeGlobalConfig — round-trips with readGlobalConfig', async () => {
  const cfg = makeConfigDir();
  try {
    await writeGlobalConfig(cfg, { version: 1, mode: 'auto' });
    const got = await readGlobalConfig(cfg);
    assert.strictEqual(got.mode, 'auto');
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('readProjectState — missing file returns zero state', async () => {
  const proj = makeProjectCwd();
  try {
    const got = await readProjectState(proj);
    assert.deepStrictEqual(got, {
      version: 1,
      opportunistic_pending: false,
      session_id: '',
    });
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('writeProjectState — round-trips and patches .gitignore', async () => {
  const proj = makeProjectCwd();
  try {
    writeFileSync(join(proj, '.gitignore'), 'node_modules\n');
    await writeProjectState(proj, {
      version: 1,
      opportunistic_pending: true,
      session_id: 'abc-123',
    });
    const got = await readProjectState(proj);
    assert.strictEqual(got.opportunistic_pending, true);
    assert.strictEqual(got.session_id, 'abc-123');
    const gitignore = readFileSync(join(proj, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.hotskills/state.json'));
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('patchGitignore — no-op when entry already present', async () => {
  const proj = makeProjectCwd();
  try {
    writeFileSync(join(proj, '.gitignore'), '.hotskills/state.json\n');
    await patchGitignore(proj);
    await patchGitignore(proj);
    const body = readFileSync(join(proj, '.gitignore'), 'utf8');
    const occurrences = body.split('.hotskills/state.json').length - 1;
    assert.strictEqual(occurrences, 1, 'entry should appear exactly once');
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('patchGitignore — no-op when .gitignore missing (does not create one)', async () => {
  const proj = makeProjectCwd();
  try {
    await patchGitignore(proj);
    assert.ok(!existsSync(join(proj, '.gitignore')));
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('mergeConfigs — activated union dedup by skill_id, newer activated_at wins', () => {
  const merged = mergeConfigs(
    {
      version: 1,
      activated: [
        { skill_id: 'skills.sh:a/b:c', activated_at: '2026-04-22T00:00:00Z' },
        { skill_id: 'skills.sh:x/y:z', activated_at: '2026-04-21T00:00:00Z' },
      ],
    },
    {
      version: 1,
      activated: [
        { skill_id: 'skills.sh:a/b:c', activated_at: '2026-04-23T00:00:00Z' },
      ],
    }
  );
  const skillC = merged.activated!.find((a) => a.skill_id === 'skills.sh:a/b:c');
  assert.strictEqual(skillC?.activated_at, '2026-04-23T00:00:00Z');
  assert.strictEqual(merged.activated!.length, 2);
});

test('mergeConfigs — security.risk_max project wins', () => {
  const merged = mergeConfigs(
    { version: 1, security: { risk_max: 'low', min_installs: 5000 } },
    { version: 1, security: { risk_max: 'high' } }
  );
  assert.strictEqual(merged.security?.risk_max, 'high');
  // min_installs not set on project, so global value persists.
  assert.strictEqual(merged.security?.min_installs, 5000);
});

test('mergeConfigs — whitelist orgs union dedupe', () => {
  const merged = mergeConfigs(
    { version: 1, security: { whitelist: { orgs: ['anthropics', 'vercel-labs'] } } },
    { version: 1, security: { whitelist: { orgs: ['vercel-labs', 'microsoft'] } } }
  );
  const orgs = merged.security?.whitelist?.orgs ?? [];
  assert.deepStrictEqual(orgs.sort(), ['anthropics', 'microsoft', 'vercel-labs']);
});

test('mergeConfigs — preferred github source shadows global same owner/repo', () => {
  const merged = mergeConfigs(
    { version: 1, sources: [{ type: 'github', owner: 'o', repo: 'r' }] },
    {
      version: 1,
      sources: [{ type: 'github', owner: 'o', repo: 'r', preferred: true }],
    }
  );
  // Project preferred:true entry shadows the global one (only one entry).
  const entries = merged.sources!.filter((s) => s.owner === 'o' && s.repo === 'r');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0]!.preferred, true);
});

test('mergeConfigs — mode project wins when defined, else global', () => {
  const m1 = mergeConfigs(
    { version: 1, mode: 'auto' },
    { version: 1, mode: 'interactive' }
  );
  assert.strictEqual(m1.mode, 'interactive');
  const m2 = mergeConfigs({ version: 1, mode: 'auto' }, { version: 1 });
  assert.strictEqual(m2.mode, 'auto');
});

test('readProjectConfig — rejects relative projectCwd path', async () => {
  await assert.rejects(readProjectConfig('./foo'), /HOTSKILLS_PROJECT_CWD/);
});

test('readProjectConfig — rejects non-existent projectCwd', async () => {
  await assert.rejects(
    readProjectConfig('/tmp/hotskills-non-existent-' + Math.random()),
    /HOTSKILLS_PROJECT_CWD/
  );
});

test('readProjectConfig — rejects projectCwd that is a file, not a directory', async () => {
  const proj = makeProjectCwd();
  const file = join(proj, 'just-a-file');
  writeFileSync(file, '');
  try {
    await assert.rejects(readProjectConfig(file), /not a directory/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});
