/**
 * Risk severity comparator + multi-partner conflict resolver.
 *
 * Per ADR-004 §Risk severity ordering:
 *   safe < low < medium < high < critical < unknown
 *   `unknown` MUST be treated as worst-case (never auto-allowed).
 *
 * Per ADR-004 §Risk severity ordering (multi-partner):
 *   Conflict resolution MUST be `max` in v0 — worst partner signal wins.
 *   Other values (`mean`, `majority`) MUST return a typed config error.
 */

import type { PartnerAudit, SkillAuditData } from '../audit.js';

// ─── Types ───

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';

/**
 * A level that the user may set as a cap (`security.risk_max`).
 * Note `unknown` is NOT a valid cap — it's only an input from partners.
 */
export type RiskCap = Exclude<RiskLevel, 'unknown'>;

// ─── Ordering ───

const RISK_RANK: Record<RiskLevel, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  unknown: 5,
};

export const ALL_RISK_LEVELS: readonly RiskLevel[] = [
  'safe',
  'low',
  'medium',
  'high',
  'critical',
  'unknown',
];

/**
 * Normalize an arbitrary string (as returned by a partner) to a RiskLevel.
 * Any value we don't recognize collapses to `unknown` — which per ADR-004
 * is the worst-case bucket, so partners returning unrecognized values
 * cannot accidentally allow a skill.
 */
export function coerceRisk(raw: unknown): RiskLevel {
  if (typeof raw !== 'string') return 'unknown';
  if (raw in RISK_RANK) return raw as RiskLevel;
  return 'unknown';
}

/**
 * Total ordering over RiskLevel. Returns:
 *   < 0 if a is less severe than b
 *   = 0 if equal
 *   > 0 if a is more severe than b
 */
export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return RISK_RANK[a] - RISK_RANK[b];
}

/**
 * True when `effective` is strictly greater than the user cap `riskMax`.
 * Used by the audit gate to decide block-vs-allow.
 */
export function riskExceedsMax(effective: RiskLevel, riskMax: RiskCap): boolean {
  return compareRisk(effective, riskMax) > 0;
}

// ─── Multi-partner resolution ───

export class UnsupportedResolutionError extends Error {
  constructor(public readonly resolution: string) {
    super(
      `audit_conflict_resolution=${JSON.stringify(resolution)} is not implemented in v0; ` +
        `only "max" is supported per ADR-004`
    );
    this.name = 'UnsupportedResolutionError';
  }
}

export type ConflictResolution = 'max' | 'mean' | 'majority';

export interface EffectiveRiskResult {
  /** The worst-of-partners risk. `unknown` if no partners reported, per ADR-004 no-data semantics. */
  risk: RiskLevel;
  /** The partner name whose risk produced the effective value (first hit on ties). */
  worstPartner: string | null;
  /** Per-partner normalized risks — useful for logs + the audit tool response. */
  perPartner: Record<string, RiskLevel>;
}

/**
 * Compute the effective risk across the reporting partners.
 *
 * Restrictions:
 *   - Only `resolution: "max"` is implemented; any other value throws
 *     UnsupportedResolutionError (caller MUST convert to a config error).
 *   - `partners` may be the full SkillAuditData map or a pre-filtered subset
 *     (the caller is responsible for applying `security.audit_partners`).
 *
 * Semantics:
 *   - Empty `partners` → { risk: 'unknown', worstPartner: null, perPartner: {} }.
 *     This mirrors ADR-004's treatment of no-audit-data as "worst case";
 *     the audit gate uses this signal to apply `no_audit_data_policy`.
 */
export function effectiveRisk(
  partners: SkillAuditData | null | undefined,
  resolution: ConflictResolution = 'max'
): EffectiveRiskResult {
  if (resolution !== 'max') {
    throw new UnsupportedResolutionError(resolution);
  }

  const perPartner: Record<string, RiskLevel> = {};
  if (!partners || typeof partners !== 'object') {
    return { risk: 'unknown', worstPartner: null, perPartner };
  }

  let worst: RiskLevel = 'safe';
  let worstPartner: string | null = null;
  let sawAny = false;

  // Iterate in insertion order for deterministic worst-partner choice on ties.
  for (const [name, entry] of Object.entries(partners)) {
    const risk = coerceRisk((entry as PartnerAudit | undefined)?.risk);
    perPartner[name] = risk;
    if (!sawAny) {
      worst = risk;
      worstPartner = name;
      sawAny = true;
      continue;
    }
    if (compareRisk(risk, worst) > 0) {
      worst = risk;
      worstPartner = name;
    }
  }

  if (!sawAny) {
    return { risk: 'unknown', worstPartner: null, perPartner };
  }
  return { risk: worst, worstPartner, perPartner };
}
