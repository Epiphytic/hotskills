import { test } from 'node:test';
import assert from 'node:assert';
import {
  ALL_RISK_LEVELS,
  coerceRisk,
  compareRisk,
  effectiveRisk,
  riskExceedsMax,
  UnsupportedResolutionError,
} from '../../gate/risk.js';

test('compareRisk — total ordering safe < low < medium < high < critical < unknown', () => {
  for (let i = 0; i < ALL_RISK_LEVELS.length - 1; i++) {
    const a = ALL_RISK_LEVELS[i]!;
    const b = ALL_RISK_LEVELS[i + 1]!;
    assert.ok(compareRisk(a, b) < 0, `${a} < ${b}`);
    assert.ok(compareRisk(b, a) > 0, `${b} > ${a}`);
    assert.strictEqual(compareRisk(a, a), 0, `${a} == ${a}`);
  }
});

test('compareRisk — unknown is greater than critical (per ADR-004)', () => {
  assert.ok(compareRisk('unknown', 'critical') > 0);
  assert.ok(compareRisk('critical', 'unknown') < 0);
});

test('coerceRisk — unknown strings collapse to "unknown"', () => {
  assert.strictEqual(coerceRisk('huh'), 'unknown');
  assert.strictEqual(coerceRisk(null), 'unknown');
  assert.strictEqual(coerceRisk(undefined), 'unknown');
  assert.strictEqual(coerceRisk(42), 'unknown');
  assert.strictEqual(coerceRisk('safe'), 'safe');
  assert.strictEqual(coerceRisk('critical'), 'critical');
});

test('riskExceedsMax — strict greater-than comparison', () => {
  assert.strictEqual(riskExceedsMax('high', 'medium'), true);
  assert.strictEqual(riskExceedsMax('medium', 'medium'), false);
  assert.strictEqual(riskExceedsMax('low', 'medium'), false);
  assert.strictEqual(riskExceedsMax('unknown', 'critical'), true);
  assert.strictEqual(riskExceedsMax('safe', 'safe'), false);
});

test('effectiveRisk — max-of-partners picks worst', () => {
  const out = effectiveRisk({
    snyk: { risk: 'high', analyzedAt: '2026-04-01T00:00:00Z' },
    socket: { risk: 'low', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  assert.strictEqual(out.risk, 'high');
  assert.strictEqual(out.worstPartner, 'snyk');
  assert.deepStrictEqual(out.perPartner, { snyk: 'high', socket: 'low' });
});

test('effectiveRisk — empty partners → unknown sentinel (no-data signal)', () => {
  const out = effectiveRisk({});
  assert.strictEqual(out.risk, 'unknown');
  assert.strictEqual(out.worstPartner, null);
  assert.deepStrictEqual(out.perPartner, {});
});

test('effectiveRisk — null/undefined partners → unknown', () => {
  assert.strictEqual(effectiveRisk(null).risk, 'unknown');
  assert.strictEqual(effectiveRisk(undefined).risk, 'unknown');
});

test('effectiveRisk — unknown risk from one partner wins (worst-case bias)', () => {
  const out = effectiveRisk({
    snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
    ath: { risk: 'unknown', analyzedAt: '2026-04-01T00:00:00Z' },
    socket: { risk: 'medium', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  assert.strictEqual(out.risk, 'unknown');
  assert.strictEqual(out.worstPartner, 'ath');
});

test('effectiveRisk — all-safe → safe', () => {
  const out = effectiveRisk({
    snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
    socket: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  assert.strictEqual(out.risk, 'safe');
  assert.strictEqual(out.worstPartner, 'snyk');
});

test('effectiveRisk — partner with unrecognized risk string treated as unknown', () => {
  const out = effectiveRisk({
    weird: { risk: 'spicy' as unknown as 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
    safe1: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  assert.strictEqual(out.risk, 'unknown');
  assert.strictEqual(out.worstPartner, 'weird');
});

test('effectiveRisk — non-"max" resolution throws UnsupportedResolutionError', () => {
  assert.throws(
    () => effectiveRisk({}, 'mean'),
    (err: unknown) => err instanceof UnsupportedResolutionError && err.resolution === 'mean'
  );
  assert.throws(
    () => effectiveRisk({}, 'majority'),
    (err: unknown) => err instanceof UnsupportedResolutionError
  );
});

test('effectiveRisk — first-hit wins on ties', () => {
  const out = effectiveRisk({
    a: { risk: 'high', analyzedAt: '2026-04-01T00:00:00Z' },
    b: { risk: 'high', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  assert.strictEqual(out.risk, 'high');
  assert.strictEqual(out.worstPartner, 'a');
});
