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
import {
  ActivationError,
  activateSkill,
  computeContentSha,
  type AuditSnapshot,
} from '../activation.js';
import { cacheSkillPath, type ParsedSkillId } from '../materialize.js';

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'hotskills-activation-test-'));
}

const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

const AUDIT: AuditSnapshot = {
  audit: { snyk: { risk: 'safe', analyzedAt: '2026-04-23T00:00:00Z' } },
  cached_at: '2026-04-23T10:00:00Z',
};

/**
 * Build a fake materialize impl that writes a minimal SKILL.md tree to the
 * target dir and returns the standard shape.
 */
function fakeMaterialize(target: string, body = '# Hello\n', sha = 'abc123') {
  return async (_parsed: ParsedSkillId, _opts: unknown) => {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'SKILL.md'), body);
    mkdirSync(join(target, 'scripts'), { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    return { path: target, sha, reused: false };
  };
}

test('activateSkill — happy path writes manifest with all required fields', async () => {
  const cfg = makeConfigDir();
  try {
    const target = cacheSkillPath(PARSED, cfg);
    const outcome = await activateSkill(PARSED, AUDIT, {
      configDir: cfg,
      materializeImpl: fakeMaterialize(target),
    });

    assert.strictEqual(outcome.skill_id, 'skills.sh:vercel-labs/agent-skills:react-best-practices');
    assert.strictEqual(outcome.path, target);
    assert.strictEqual(outcome.reused, false);

    const m = outcome.manifest;
    assert.strictEqual(m.source, 'skills.sh');
    assert.strictEqual(m.owner, 'vercel-labs');
    assert.strictEqual(m.repo, 'agent-skills');
    assert.strictEqual(m.slug, 'react-best-practices');
    assert.strictEqual(m.version, 'abc123');
    assert.ok(m.content_sha256.length === 64, 'sha256 hex digest is 64 chars');
    assert.deepStrictEqual(m.audit_snapshot, AUDIT);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(m.activated_at));

    // Manifest is on disk.
    const onDisk = JSON.parse(
      readFileSync(join(target, '.hotskills-manifest.json'), 'utf8')
    );
    assert.strictEqual(onDisk.content_sha256, m.content_sha256);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('activateSkill — second call with identical content returns reused: true', async () => {
  const cfg = makeConfigDir();
  try {
    const target = cacheSkillPath(PARSED, cfg);
    const impl = fakeMaterialize(target, '# Body v1\n', 'sha-1');

    let materializeCalls = 0;
    const counted = async (...args: Parameters<typeof impl>) => {
      materializeCalls += 1;
      return impl(...args);
    };

    const first = await activateSkill(PARSED, AUDIT, {
      configDir: cfg,
      materializeImpl: counted,
    });
    assert.strictEqual(first.reused, false);
    assert.strictEqual(materializeCalls, 1);

    const second = await activateSkill(PARSED, AUDIT, {
      configDir: cfg,
      materializeImpl: counted,
    });
    assert.strictEqual(second.reused, true, 'second call must reuse');
    assert.strictEqual(materializeCalls, 1, 'materialize should NOT have been called twice');
    assert.strictEqual(second.manifest.content_sha256, first.manifest.content_sha256);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('activateSkill — content tamper triggers re-materialization', async () => {
  const cfg = makeConfigDir();
  try {
    const target = cacheSkillPath(PARSED, cfg);
    const impl = fakeMaterialize(target, '# Original\n', 'sha-orig');

    let materializeCalls = 0;
    const counted = async (...args: Parameters<typeof impl>) => {
      materializeCalls += 1;
      // Each call uses the latest impl which writes "# Original" — so the
      // tampered file gets reset on the second call.
      return impl(...args);
    };

    await activateSkill(PARSED, AUDIT, { configDir: cfg, materializeImpl: counted });
    assert.strictEqual(materializeCalls, 1);

    // Tamper with a file under cache.
    writeFileSync(join(target, 'SKILL.md'), '# Tampered\n');

    const second = await activateSkill(PARSED, AUDIT, {
      configDir: cfg,
      materializeImpl: counted,
    });
    assert.strictEqual(second.reused, false, 'tamper should force re-materialization');
    assert.strictEqual(materializeCalls, 2);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('activateSkill — missing SKILL.md after materialize throws ActivationError', async () => {
  const cfg = makeConfigDir();
  try {
    const target = cacheSkillPath(PARSED, cfg);
    const noSkillMd = async (_p: ParsedSkillId, _o: unknown) => {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      // intentionally do NOT write SKILL.md
      return { path: target, sha: 'x', reused: false };
    };
    await assert.rejects(
      activateSkill(PARSED, AUDIT, { configDir: cfg, materializeImpl: noSkillMd }),
      ActivationError
    );
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('computeContentSha — deterministic over identical trees', () => {
  const a = mkdtempSync(join(tmpdir(), 'hs-sha-a-'));
  const b = mkdtempSync(join(tmpdir(), 'hs-sha-b-'));
  try {
    for (const root of [a, b]) {
      writeFileSync(join(root, 'SKILL.md'), '# Hi\n');
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'x.sh'), '#!/bin/sh\necho 1\n');
    }
    assert.strictEqual(computeContentSha(a), computeContentSha(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('computeContentSha — excludes the manifest file from the digest', () => {
  const root = mkdtempSync(join(tmpdir(), 'hs-sha-mani-'));
  try {
    writeFileSync(join(root, 'SKILL.md'), 'x');
    const before = computeContentSha(root);
    writeFileSync(join(root, '.hotskills-manifest.json'), '{"any":"thing"}');
    const after = computeContentSha(root);
    assert.strictEqual(before, after, 'manifest file must not affect content sha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activateSkill — concurrent calls produce a single materialization (lock)', async () => {
  const cfg = makeConfigDir();
  try {
    const target = cacheSkillPath(PARSED, cfg);
    let materializeCalls = 0;
    const slow = async (_p: ParsedSkillId, _o: unknown) => {
      materializeCalls += 1;
      mkdirSync(target, { recursive: true, mode: 0o700 });
      writeFileSync(join(target, 'SKILL.md'), '# Race\n');
      await new Promise((r) => setTimeout(r, 50));
      return { path: target, sha: 'race', reused: false };
    };
    const [r1, r2] = await Promise.all([
      activateSkill(PARSED, AUDIT, { configDir: cfg, materializeImpl: slow }),
      activateSkill(PARSED, AUDIT, { configDir: cfg, materializeImpl: slow }),
    ]);
    // Per hotskills-w9g: the outer <target>.activate.lock now serializes
    // the full activation flow. The loser blocks on lock acquire, observes
    // the winner's manifest in the fast-path read, and short-circuits with
    // reused: true — exactly one materialize call.
    assert.strictEqual(materializeCalls, 1, 'outer activate-lock must serialize: only one materialize call');
    // Exactly one of (r1, r2) is the fresh writer; the other is the reuser.
    const reusedFlags = [r1.reused, r2.reused].sort();
    assert.deepStrictEqual(reusedFlags, [false, true], 'one reused, one fresh');
    // Both manifests share the same content_sha256.
    assert.strictEqual(r1.manifest.content_sha256, r2.manifest.content_sha256);
    // Manifest on disk matches.
    const onDisk = JSON.parse(
      readFileSync(join(target, '.hotskills-manifest.json'), 'utf8')
    );
    assert.strictEqual(onDisk.content_sha256, r1.manifest.content_sha256);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});
