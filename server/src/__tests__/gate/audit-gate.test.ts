import { test } from 'node:test';
import assert from 'node:assert';
import { checkAuditGate } from '../../gate/audit-gate.js';
import type { AuditLookupResult, SkillAuditData } from '../../audit.js';
import type { SecurityConfig } from '../../config.js';
import type { ParsedSkillId } from '../../skill-id.js';
import { UnsupportedResolutionError } from '../../gate/risk.js';

const PARSED: ParsedSkillId = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

function fakeAuditLookup(audit: SkillAuditData | null, cached = false) {
  return async (): Promise<AuditLookupResult> => ({ audit, cached });
}

test('audit gate — snyk:high vs risk_max:medium → block reason audit:snyk:high', async () => {
  const sec: SecurityConfig = { risk_max: 'medium' };
  const lookup = fakeAuditLookup({
    snyk: { risk: 'high', analyzedAt: '2026-04-01T00:00:00Z' },
    socket: { risk: 'low', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'audit:snyk:high');
  assert.strictEqual(out.effectiveRisk, 'high');
  assert.strictEqual(out.worstPartner, 'snyk');
});

test('audit gate — all partners safe → allow', async () => {
  const sec: SecurityConfig = { risk_max: 'medium' };
  const lookup = fakeAuditLookup({
    snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
    socket: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.effectiveRisk, 'safe');
});

test('audit gate — medium risk == risk_max:medium → allow (strict greater-than)', async () => {
  const sec: SecurityConfig = { risk_max: 'medium' };
  const lookup = fakeAuditLookup({
    snyk: { risk: 'medium', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'allow');
});

test('audit gate — null audit (timeout/error) → no_data with default policy', async () => {
  const sec: SecurityConfig = {}; // default fallback_to_installs
  const lookup = fakeAuditLookup(null);
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'no_data');
  assert.strictEqual(out.reason, undefined);
});

test('audit gate — empty partner set → no_data (per ADR-004 no-data semantics)', async () => {
  const sec: SecurityConfig = { audit_partners: ['snyk', 'socket'] };
  // Audit has data but only for partners not in our allowlist.
  const lookup = fakeAuditLookup({
    weird: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'no_data');
});

test('audit gate — no_audit_data_policy=block + no data → block reason no_audit_data:blocked', async () => {
  const sec: SecurityConfig = { no_audit_data_policy: 'block' };
  const lookup = fakeAuditLookup(null);
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'no_audit_data:blocked');
});

test('audit gate — no_audit_data_policy=allow_with_warning + no data → no_data with warning', async () => {
  const sec: SecurityConfig = { no_audit_data_policy: 'allow_with_warning' };
  const lookup = fakeAuditLookup(null);
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'no_data');
  assert.ok(out.warning);
});

test('audit gate — partner filter excludes non-allowlisted high risk → allow', async () => {
  const sec: SecurityConfig = { risk_max: 'medium', audit_partners: ['snyk'] };
  // 'rogue' partner reports critical but is not in the allowlist.
  const lookup = fakeAuditLookup({
    snyk: { risk: 'low', analyzedAt: '2026-04-01T00:00:00Z' },
    rogue: { risk: 'critical', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'allow');
  assert.strictEqual(out.effectiveRisk, 'low');
});

test('audit gate — unknown risk from partner (filtered set non-empty) → effective unknown → block when risk_max < unknown', async () => {
  const sec: SecurityConfig = { risk_max: 'critical', audit_partners: ['snyk'] };
  const lookup = fakeAuditLookup({
    snyk: { risk: 'unknown' as 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  // unknown > critical per ADR-004 → block
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'audit:snyk:unknown');
});

test('audit gate — critical from one partner overrides safe others → block', async () => {
  const sec: SecurityConfig = { risk_max: 'medium' };
  const lookup = fakeAuditLookup({
    snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
    socket: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' },
    ath: { risk: 'critical', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(out.reason, 'audit:ath:critical');
});

test('audit gate — non-"max" resolution throws UnsupportedResolutionError', async () => {
  const sec: SecurityConfig = { audit_conflict_resolution: 'mean' };
  const lookup = fakeAuditLookup({});
  await assert.rejects(
    () => checkAuditGate(PARSED, sec, { auditLookup: lookup }),
    (err: unknown) => err instanceof UnsupportedResolutionError
  );
});

test('audit gate — sanitizes partner name in reason string (secure)', async () => {
  const sec: SecurityConfig = { risk_max: 'medium', audit_partners: ['snyk\nINJECTED'] };
  const lookup = fakeAuditLookup({
    'snyk\nINJECTED': { risk: 'high', analyzedAt: '2026-04-01T00:00:00Z' },
  });
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.decision, 'block');
  // Reason field must NOT contain the raw newline; sanitization replaces it.
  assert.ok(out.reason);
  assert.ok(!out.reason!.includes('\n'));
  assert.match(out.reason!, /^audit:snyk_INJECTED:high$/);
  // The full worstPartner field preserves the raw value for audit-tool consumers.
  assert.strictEqual(out.worstPartner, 'snyk\nINJECTED');
});

test('audit gate — cached flag is propagated', async () => {
  const sec: SecurityConfig = {};
  const lookup = fakeAuditLookup(
    { snyk: { risk: 'safe', analyzedAt: '2026-04-01T00:00:00Z' } },
    true
  );
  const out = await checkAuditGate(PARSED, sec, { auditLookup: lookup });
  assert.strictEqual(out.cached, true);
});
