import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateSkill } from '../../activation.js';
import { cacheSkillPath, type ParsedSkillId } from '../../materialize.js';

/**
 * Plan-Phase 6 §6.2 (d): two concurrent activations of the same skill must
 * end up materializing exactly once. The second call observes the winner's
 * manifest and short-circuits with `reused: true`. The lock under
 * <target>.activate.lock is what makes this safe.
 */

const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'hotskills-concurrent-'));
  const configDir = join(root, '.config', 'hotskills');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return {
    configDir,
    target: cacheSkillPath(PARSED, configDir),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('integration — two concurrent activations of the same skill materialize once', async () => {
  const sb = makeSandbox();
  try {
    let materializeCallCount = 0;
    const fakeMaterialize = async () => {
      materializeCallCount += 1;
      // Simulate non-trivial work so the two callers actually overlap on
      // the lock — without a delay, the first call may finish before the
      // second one is dispatched, masking lock-correctness.
      await new Promise((r) => setTimeout(r, 50));
      mkdirSync(sb.target, { recursive: true, mode: 0o700 });
      writeFileSync(join(sb.target, 'SKILL.md'), '# x\n');
      return { path: sb.target, sha: 'concurrent-sha', reused: false };
    };

    const audit = { audit: null, cached_at: new Date().toISOString() };
    const opts = { configDir: sb.configDir, materializeImpl: fakeMaterialize };

    const [a, b] = await Promise.all([
      activateSkill(PARSED, audit, opts),
      activateSkill(PARSED, audit, opts),
    ]);

    // Materialize ran exactly once.
    assert.strictEqual(materializeCallCount, 1, 'materialize must run exactly once');
    // Exactly one of the two callers reports `reused: true`. The other is
    // the winner and reports `reused: false`. Order is non-deterministic.
    const reused = [a.reused, b.reused].sort();
    assert.deepStrictEqual(reused, [false, true]);
    // Both report the same path and content_sha256.
    assert.strictEqual(a.path, b.path);
    assert.strictEqual(a.manifest.content_sha256, b.manifest.content_sha256);
    // Both report the same activated_at, because the reused caller returns
    // the winner's manifest verbatim.
    assert.strictEqual(a.manifest.activated_at, b.manifest.activated_at);
  } finally {
    sb.cleanup();
  }
});

test('integration — five concurrent activations all converge on a single materialization', async () => {
  const sb = makeSandbox();
  try {
    let materializeCallCount = 0;
    const fakeMaterialize = async () => {
      materializeCallCount += 1;
      await new Promise((r) => setTimeout(r, 30));
      mkdirSync(sb.target, { recursive: true, mode: 0o700 });
      writeFileSync(join(sb.target, 'SKILL.md'), '# x\n');
      return { path: sb.target, sha: 'concurrent-sha', reused: false };
    };

    const audit = { audit: null, cached_at: new Date().toISOString() };
    const opts = { configDir: sb.configDir, materializeImpl: fakeMaterialize };
    const N = 5;

    const results = await Promise.all(
      Array.from({ length: N }, () => activateSkill(PARSED, audit, opts))
    );
    assert.strictEqual(materializeCallCount, 1, 'materialize must run exactly once across 5 callers');
    const reusedCount = results.filter((r) => r.reused).length;
    assert.strictEqual(reusedCount, N - 1, 'exactly N-1 callers must report reused=true');
    // All results share the same activated_at (winner's manifest).
    const distinctActivatedAt = new Set(results.map((r) => r.manifest.activated_at));
    assert.strictEqual(distinctActivatedAt.size, 1);
  } finally {
    sb.cleanup();
  }
});
