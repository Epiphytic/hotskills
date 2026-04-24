import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, getConfigDir, getProjectCwd, resolveEnv } from '../env.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hotskills-env-test-'));
}

// ─── getProjectCwd ───

test('getProjectCwd throws when HOTSKILLS_PROJECT_CWD is unset', () => {
  assert.throws(() => getProjectCwd({} as NodeJS.ProcessEnv), ConfigError);
});

test('getProjectCwd throws when HOTSKILLS_PROJECT_CWD is empty string', () => {
  assert.throws(() => getProjectCwd({ HOTSKILLS_PROJECT_CWD: '   ' }), ConfigError);
});

test('getProjectCwd throws when the path does not exist', () => {
  assert.throws(
    () => getProjectCwd({ HOTSKILLS_PROJECT_CWD: '/definitely/not/a/real/dir/xyz' }),
    ConfigError
  );
});

test('getProjectCwd throws when the path is a file, not a directory', () => {
  const dir = makeTempDir();
  try {
    const filePath = join(dir, 'notadir');
    writeFileSync(filePath, 'hi');
    assert.throws(() => getProjectCwd({ HOTSKILLS_PROJECT_CWD: filePath }), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getProjectCwd returns canonicalized path for a valid dir', () => {
  const dir = makeTempDir();
  try {
    const got = getProjectCwd({ HOTSKILLS_PROJECT_CWD: `${dir}/./` });
    assert.strictEqual(got, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── getConfigDir ───

test('getConfigDir defaults to ${HOME}/.config/hotskills when env var unset', () => {
  const home = makeTempDir();
  try {
    const got = getConfigDir({ HOME: home });
    assert.strictEqual(got, join(home, '.config', 'hotskills'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getConfigDir rejects paths outside the ${HOME}/.config sandbox', () => {
  const home = makeTempDir();
  try {
    assert.throws(
      () => getConfigDir({ HOME: home, HOTSKILLS_CONFIG_DIR: '/etc/hotskills' }),
      ConfigError
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getConfigDir rejects sibling paths that look similar to .config but arent', () => {
  // Defends the prefix check: "/home/u/.configX" must NOT be accepted because
  // "/home/u/.config" is the sandbox root.
  const home = makeTempDir();
  try {
    const sibling = join(home, '.configSQL', 'hotskills');
    assert.throws(
      () => getConfigDir({ HOME: home, HOTSKILLS_CONFIG_DIR: sibling }),
      ConfigError
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getConfigDir rejects path-traversal that would escape the sandbox after canonicalize', () => {
  const home = makeTempDir();
  try {
    const sneaky = join(home, '.config', 'hotskills', '..', '..', '..', '..', 'etc');
    assert.throws(
      () => getConfigDir({ HOME: home, HOTSKILLS_CONFIG_DIR: sneaky }),
      ConfigError
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('getConfigDir accepts paths under HOTSKILLS_DEV_OVERRIDE', () => {
  const home = makeTempDir();
  const dev = makeTempDir();
  try {
    const target = join(dev, 'nested', 'hotskills');
    const got = getConfigDir({
      HOME: home,
      HOTSKILLS_CONFIG_DIR: target,
      HOTSKILLS_DEV_OVERRIDE: dev,
    });
    assert.strictEqual(got, target);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dev, { recursive: true, force: true });
  }
});

test('getConfigDir creates the config dir if absent (mode 0700 on POSIX)', async () => {
  if (process.platform === 'win32') return;
  const home = makeTempDir();
  try {
    const target = join(home, '.config', 'hotskills', 'fresh');
    const got = getConfigDir({ HOME: home, HOTSKILLS_CONFIG_DIR: target });
    assert.strictEqual(got, target);
    const { statSync } = await import('node:fs');
    const mode = statSync(target).mode & 0o777;
    assert.strictEqual(mode, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─── resolveEnv ───

test('resolveEnv returns both validated paths and the optional dev override', () => {
  const home = makeTempDir();
  const project = makeTempDir();
  try {
    const got = resolveEnv({
      HOME: home,
      HOTSKILLS_PROJECT_CWD: project,
      HOTSKILLS_CONFIG_DIR: join(home, '.config', 'hotskills'),
    });
    assert.strictEqual(got.projectCwd, project);
    assert.strictEqual(got.configDir, join(home, '.config', 'hotskills'));
    assert.strictEqual(got.devOverride, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
