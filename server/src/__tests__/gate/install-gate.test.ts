import { test } from 'node:test';
import assert from 'node:assert';
import {
  AUDITED_AUTHORS_ALLOWLIST,
  checkInstallGate,
} from '../../gate/install-gate.js';
import type { ParsedSkillId } from '../../skill-id.js';

const PARSED = (owner: string): ParsedSkillId => ({
  source: 'skills.sh',
  owner,
  repo: 'agent-skills',
  slug: 'react-best-practices',
});

test('install gate — installs >= min_installs → allow (allowedBy: min_installs)', () => {
  const out = checkInstallGate(PARSED('myorg'), 1000, { min_installs: 1000 });
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.allowedBy, 'min_installs');
});

test('install gate — installs > min_installs → allow', () => {
  const out = checkInstallGate(PARSED('myorg'), 1001, { min_installs: 1000 });
  assert.strictEqual(out.decision, 'allow');
});

test('install gate — installs < min_installs without other allow → block with reason', () => {
  const out = checkInstallGate(PARSED('randomorg'), 500, { min_installs: 1000 });
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'install_threshold:500:1000');
});

test('install gate — installs < min_installs but owner in built-in allowlist → allow', () => {
  for (const owner of AUDITED_AUTHORS_ALLOWLIST) {
    const out = checkInstallGate(PARSED(owner), 500, { min_installs: 1000 });
    assert.strictEqual(out.decision, 'allow', `${owner} should be allowed by built-in allowlist`);
    assert.strictEqual(out.allowedBy, 'audited_authors_allowlist');
  }
});

test('install gate — installs < min_installs but owner in preferred_sources → allow', () => {
  const out = checkInstallGate(PARSED('myorg'), 500, {
    min_installs: 1000,
    preferred_sources: ['myorg'],
  });
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.allowedBy, 'preferred_sources');
});

test('install gate — owner in built-in allowlist takes priority when min satisfied (still allow)', () => {
  // Both rules pass; min_installs wins (checked first).
  const out = checkInstallGate(PARSED('vercel-labs'), 5000, { min_installs: 1000 });
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.allowedBy, 'min_installs');
});

test('install gate — defaults: min_installs=1000 when security undefined', () => {
  const out = checkInstallGate(PARSED('myorg'), 999, undefined);
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'install_threshold:999:1000');
});

test('install gate — github source with installs=0 and built-in author → allow', () => {
  const out = checkInstallGate(
    { source: 'github', owner: 'anthropics', repo: 'r', slug: 's' },
    0,
    {}
  );
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.allowedBy, 'audited_authors_allowlist');
});

test('install gate — github source with installs=0 and unknown owner → block', () => {
  const out = checkInstallGate(
    { source: 'github', owner: 'rando', repo: 'r', slug: 's' },
    0,
    {}
  );
  assert.strictEqual(out.decision, 'block');
});

test('install gate — preferred_sources empty array does not allow random owner', () => {
  const out = checkInstallGate(PARSED('myorg'), 0, {
    min_installs: 1000,
    preferred_sources: [],
  });
  assert.strictEqual(out.decision, 'block');
});

test('install gate — built-in allowlist includes the documented 5 vendors', () => {
  assert.deepStrictEqual(
    [...AUDITED_AUTHORS_ALLOWLIST].sort(),
    ['anthropics', 'mastra-ai', 'microsoft', 'remotion-dev', 'vercel-labs'].sort()
  );
});
