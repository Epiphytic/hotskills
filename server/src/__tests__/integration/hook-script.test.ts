import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Plan-Phase 6 §6.2 (e): drive the real inject-reminders.sh script from
 * TypeScript with 1, 20, and 25 activated skills, asserting:
 *   - 20-skill allow-list emits all 20 entries, no overflow line.
 *   - 25-skill allow-list emits 20 entries (recency-sorted) plus the
 *     "... and 5 more" overflow line.
 *   - 0-skill allow-list emits no <system-reminder>.
 *
 * Complements the bash-driven tests in scripts/tests/inject-reminders.test.sh
 * by validating the script behaves identically when invoked from a Node
 * test runner (as future CI components will).
 */

// dist/__tests__/integration/<file> — go up 4 to reach the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const HOOK = join(repoRoot, 'scripts', 'inject-reminders.sh');

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-hook-int-'));
  const configDir = join(root, '.config', 'hotskills');
  const projectCwd = join(root, 'project');
  mkdirSync(join(projectCwd, '.hotskills'), { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return { root, configDir, projectCwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface ActivatedEntry {
  skill_id: string;
  activated_at: string;
  description: string;
}

function writeProjectConfig(projectCwd: string, activated: ActivatedEntry[]): void {
  const cfg = { version: 1, activated };
  writeFileSync(join(projectCwd, '.hotskills', 'config.json'), JSON.stringify(cfg));
}

function makeEntries(n: number): ActivatedEntry[] {
  // Most recent has the largest index; older entries get earlier timestamps.
  // The hook sorts by activated_at desc and takes the first 20.
  return Array.from({ length: n }, (_, i) => ({
    skill_id: `skills.sh:fixture-org/fixture-repo:skill-${String(i).padStart(2, '0')}`,
    activated_at: `2026-04-${String(((i % 28) + 1)).padStart(2, '0')}T12:00:00Z`,
    description: `description for skill-${i}`,
  }));
}

function runHook(sb: { configDir: string; projectCwd: string }, event: string): { stdout: string; status: number } {
  const result = spawnSync('bash', [HOOK, `--event=${event}`], {
    env: {
      ...process.env,
      HOTSKILLS_CONFIG_DIR: sb.configDir,
      HOTSKILLS_PROJECT_CWD: sb.projectCwd,
      CLAUDE_PROJECT_DIR: sb.projectCwd,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stdout: result.stdout ?? '', status: result.status ?? -1 };
}

test('integration hook — 0-skill allow-list → no <system-reminder> output', () => {
  const sb = makeSandbox();
  try {
    writeProjectConfig(sb.projectCwd, []);
    const r = runHook(sb, 'UserPromptSubmit');
    assert.strictEqual(r.status, 0);
    assert.ok(!r.stdout.includes('<system-reminder>'), `unexpected reminder: ${r.stdout}`);
  } finally {
    sb.cleanup();
  }
});

test('integration hook — 20-skill allow-list → exactly 20 bullets, no overflow line', () => {
  const sb = makeSandbox();
  try {
    writeProjectConfig(sb.projectCwd, makeEntries(20));
    const r = runHook(sb, 'UserPromptSubmit');
    assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stdout}`);
    const bullets = r.stdout.split('\n').filter((l) => l.startsWith('- '));
    assert.strictEqual(bullets.length, 20, `expected 20 bullets, got ${bullets.length}`);
    assert.ok(!r.stdout.includes('and') || !/and \d+ more/.test(r.stdout));
  } finally {
    sb.cleanup();
  }
});

test('integration hook — 25-skill allow-list → 20 bullets + "and 5 more" overflow', () => {
  const sb = makeSandbox();
  try {
    writeProjectConfig(sb.projectCwd, makeEntries(25));
    const r = runHook(sb, 'UserPromptSubmit');
    assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stdout}`);
    const bullets = r.stdout.split('\n').filter((l) => l.startsWith('- '));
    assert.strictEqual(bullets.length, 20, `expected 20 bullets, got ${bullets.length}`);
    assert.match(r.stdout, /\.\.\. and 5 more — call hotskills\.list for the full list\./);
  } finally {
    sb.cleanup();
  }
});

test('integration hook — descriptions over 80 chars are truncated', () => {
  const sb = makeSandbox();
  try {
    const big = 'x'.repeat(200);
    writeProjectConfig(sb.projectCwd, [
      { skill_id: 'skills.sh:o/r:s', activated_at: '2026-04-28T00:00:00Z', description: big },
    ]);
    const r = runHook(sb, 'UserPromptSubmit');
    assert.strictEqual(r.status, 0);
    // The truncation marker is `…` (U+2026); the bullet line must be
    // shorter than the original description plus the bullet prefix.
    const bullet = r.stdout.split('\n').find((l) => l.startsWith('- '))!;
    assert.ok(bullet.length < big.length + 30, `bullet not truncated: len=${bullet.length}`);
    assert.ok(bullet.endsWith('…'));
  } finally {
    sb.cleanup();
  }
});
