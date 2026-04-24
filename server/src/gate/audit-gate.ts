/**
 * Audit gate — second layer of the gate stack per ADR-004.
 *
 * Per ADR-004 §Gate stack step 2:
 *   - Fetch audit data via the audit client.
 *   - Compute effective_risk = max-of(partner.risk for partner in audit_partners).
 *   - If audit returned data and effective_risk > risk_max → BLOCK with
 *     reason `audit:<partner>:<risk>`.
 *   - If audit returned no data, apply no_audit_data_policy:
 *     fallback_to_installs (default) → no_data
 *     block                          → BLOCK reason `no_audit_data:blocked`
 *     allow_with_warning             → continue, warning surfaced
 */

import { getAuditData } from '../audit.js';
import type { SkillAuditData } from '../audit.js';
import type { SecurityConfig } from '../config.js';
import type { ParsedSkillId } from '../skill-id.js';
import {
  effectiveRisk,
  riskExceedsMax,
  UnsupportedResolutionError,
  type ConflictResolution,
  type RiskCap,
  type RiskLevel,
} from './risk.js';

// ─── Types ───

export type AuditDecisionKind = 'allow' | 'block' | 'no_data';

export interface AuditDecision {
  decision: AuditDecisionKind;
  /** Block reason in `audit:<partner>:<risk>` form, or `no_audit_data:blocked`. */
  reason?: string;
  /** Resolved effective risk; present when audit data was available. */
  effectiveRisk?: RiskLevel;
  /** Worst-of-partners partner name; present when block reason references a partner. */
  worstPartner?: string | null;
  /** Per-partner normalized risks; useful for the audit tool response. */
  perPartner?: Record<string, RiskLevel>;
  /** True when no_audit_data_policy=allow_with_warning suppressed a no-data outcome. */
  warning?: string;
  /** True when audit data was served from on-disk cache. */
  cached?: boolean;
}

export interface AuditGateOptions {
  /** Inject the audit lookup function for tests. Defaults to getAuditData. */
  auditLookup?: typeof getAuditData;
}

const DEFAULT_PARTNERS: readonly string[] = ['ath', 'socket', 'snyk', 'zeroleaks'];
const DEFAULT_RISK_MAX: RiskCap = 'medium';
const DEFAULT_NO_DATA_POLICY: NonNullable<SecurityConfig['no_audit_data_policy']> =
  'fallback_to_installs';

// ─── Helpers ───

/**
 * Filter the raw audit data down to the partners the user opted into.
 * Returns `null` when the input is null. Empty filtered set is preserved
 * (the caller treats it as no-data per ADR-004).
 */
function filterPartners(
  audit: SkillAuditData | null,
  allowedPartners: readonly string[]
): SkillAuditData | null {
  if (!audit) return null;
  const out: SkillAuditData = {};
  for (const name of allowedPartners) {
    const entry = audit[name];
    if (entry) out[name] = entry;
  }
  return out;
}

function isPartnerSetEmpty(audit: SkillAuditData): boolean {
  return Object.keys(audit).length === 0;
}

// ─── Public API ───

/**
 * Run the audit gate. Returns one of three decisions:
 *   - `allow`   — audit returned data and effective_risk ≤ risk_max
 *   - `block`   — audit data above risk_max, OR policy=block on no-data
 *   - `no_data` — audit returned nothing AND policy ∈ {fallback_to_installs,
 *                 allow_with_warning}; caller continues to next gate layer.
 *
 * The policy `allow_with_warning` returns `no_data` with a `warning` field
 * set. Callers that aggregate warnings (the picker) should surface it.
 *
 * Throws UnsupportedResolutionError when `audit_conflict_resolution` is set
 * to anything other than `max`. Caller MUST convert this to a config error.
 */
export async function checkAuditGate(
  parsedId: ParsedSkillId,
  security: SecurityConfig | undefined,
  opts: AuditGateOptions = {}
): Promise<AuditDecision> {
  const sec = security ?? {};
  const riskMax: RiskCap = sec.risk_max ?? DEFAULT_RISK_MAX;
  const partners = sec.audit_partners ?? DEFAULT_PARTNERS;
  const policy = sec.no_audit_data_policy ?? DEFAULT_NO_DATA_POLICY;
  const resolution: ConflictResolution = sec.audit_conflict_resolution ?? 'max';

  // Surface the unsupported-resolution as a thrown error; the orchestrator
  // converts it to a typed config error so the user gets a clear message.
  if (resolution !== 'max') {
    throw new UnsupportedResolutionError(resolution);
  }

  const lookup = opts.auditLookup ?? getAuditData;
  const result = await lookup(parsedId);

  // ─── No-data path ───
  const filtered = filterPartners(result.audit, partners);
  if (filtered === null || isPartnerSetEmpty(filtered)) {
    if (policy === 'block') {
      return {
        decision: 'block',
        reason: 'no_audit_data:blocked',
        cached: result.cached,
      };
    }
    if (policy === 'allow_with_warning') {
      return {
        decision: 'no_data',
        warning: 'no audit data; continuing per allow_with_warning policy',
        cached: result.cached,
      };
    }
    // fallback_to_installs (default): defer to subsequent gates.
    return { decision: 'no_data', cached: result.cached };
  }

  // ─── Resolve effective risk ───
  const er = effectiveRisk(filtered, 'max');
  if (riskExceedsMax(er.risk, riskMax)) {
    return {
      decision: 'block',
      reason: `audit:${er.worstPartner ?? 'unknown'}:${er.risk}`,
      effectiveRisk: er.risk,
      worstPartner: er.worstPartner,
      perPartner: er.perPartner,
      cached: result.cached,
    };
  }

  return {
    decision: 'allow',
    effectiveRisk: er.risk,
    worstPartner: er.worstPartner,
    perPartner: er.perPartner,
    cached: result.cached,
  };
}
