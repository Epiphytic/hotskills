import { test } from 'node:test';
import assert from 'node:assert';
import { _internals, validateConfig, validateState } from '../schemas/index.js';

test('schema limits — MAX_PAYLOAD_DEPTH rejects pathologically nested config', () => {
  // Build a payload nested below the depth limit so we know our walker
  // exits cleanly when the structure is *just* legitimate.
  let nested: unknown = { x: 1 };
  for (let i = 0; i < _internals.MAX_PAYLOAD_DEPTH + 5; i++) {
    nested = { x: nested };
  }
  const result = validateConfig(nested);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /depth/.test(e)));
});

test('schema limits — MAX_PAYLOAD_NODES rejects fan-out attack', () => {
  const arr: unknown[] = [];
  for (let i = 0; i < _internals.MAX_PAYLOAD_NODES + 100; i++) {
    arr.push({ k: i });
  }
  const result = validateConfig({ version: 1, activated: arr });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => /node/.test(e)));
});

test('schema limits — pathological payload rejects within 100ms (no DoS)', () => {
  const arr: unknown[] = [];
  for (let i = 0; i < _internals.MAX_PAYLOAD_NODES * 2; i++) arr.push({ k: i });
  const start = Date.now();
  const out = validateConfig({ version: 1, activated: arr });
  const elapsed = Date.now() - start;
  assert.strictEqual(out.valid, false);
  assert.ok(elapsed < 100, `expected validation to short-circuit < 100ms, got ${elapsed}ms`);
});

test('schema limits — legitimate config payload validates without false positives', () => {
  const cfg = {
    version: 1,
    mode: 'interactive' as const,
    activated: [
      {
        skill_id: 'skills.sh:vercel-labs/agent-skills:react-best-practices',
        activated_at: '2026-04-23T00:00:00Z',
      },
    ],
    sources: [{ type: 'github' as const, owner: 'me', repo: 'r' }],
    security: {
      risk_max: 'medium' as const,
      whitelist: { orgs: ['me'], repos: [], skills: [] },
    },
  };
  const result = validateConfig(cfg);
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

test('schema limits — state payload validates within depth limit', () => {
  const result = validateState({
    version: 1,
    opportunistic_pending: false,
    session_id: 'sess-1',
  });
  assert.strictEqual(result.valid, true);
});

test('schema limits — checkPayloadComplexity short-circuits and reports clear reason', () => {
  let nested: unknown = 1;
  for (let i = 0; i < _internals.MAX_PAYLOAD_DEPTH + 1; i++) nested = [nested];
  const guard = _internals.checkPayloadComplexity(nested);
  assert.strictEqual(guard.ok, false);
  if (!guard.ok) assert.match(guard.reason, /depth/);
});
