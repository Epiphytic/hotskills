/**
 * Install + author gate — fourth (final) layer of the gate stack per ADR-004.
 *
 * Per ADR-004 §Gate stack step 4:
 *   Allow if:
 *     - installs >= security.min_installs (default 1000), OR
 *     - owner in security.preferred_sources, OR
 *     - owner in built-in audited_authors_allowlist:
 *       [anthropics, vercel-labs, microsoft, mastra-ai, remotion-dev]
 *   Otherwise block with reason `install_threshold:<installs>:<min_installs>`.
 */

import type { SecurityConfig } from '../config.js';
import type { ParsedSkillId } from '../skill-id.js';

// ─── Constants ───

/**
 * Built-in allowlist per ADR-004. These vendors are audited subset on the
 * skills.sh /audits page so they generally have audit data anyway —
 * this allowlist exists to bypass the install-count threshold for new
 * skills from these orgs that haven't accumulated installs yet.
 */
export const AUDITED_AUTHORS_ALLOWLIST: readonly string[] = [
  'anthropics',
  'vercel-labs',
  'microsoft',
  'mastra-ai',
  'remotion-dev',
];

const DEFAULT_MIN_INSTALLS = 1000;

// ─── Types ───

export type InstallDecisionKind = 'allow' | 'block';
export type InstallReasonKind =
  | 'min_installs'
  | 'preferred_sources'
  | 'audited_authors_allowlist';

export interface InstallDecision {
  decision: InstallDecisionKind;
  /** Block reason `install_threshold:<installs>:<min_installs>` when block. */
  reason?: string;
  /** Which allow-rule fired when allow. */
  allowedBy?: InstallReasonKind;
}

// ─── Public API ───

/**
 * Run the install + author gate.
 *
 * `installCount` is the install count from search results (skills.sh) or
 * 0 for github-source skills (no install metric available — only the
 * preferred_sources / built-in allowlist paths can satisfy them).
 */
export function checkInstallGate(
  parsedId: ParsedSkillId,
  installCount: number,
  security: SecurityConfig | undefined
): InstallDecision {
  const sec = security ?? {};
  const minInstalls = sec.min_installs ?? DEFAULT_MIN_INSTALLS;
  const preferred = sec.preferred_sources ?? [];

  // Installs threshold.
  if (installCount >= minInstalls) {
    return { decision: 'allow', allowedBy: 'min_installs' };
  }

  // User-configured preferred sources.
  if (preferred.includes(parsedId.owner)) {
    return { decision: 'allow', allowedBy: 'preferred_sources' };
  }

  // Built-in audited authors allowlist.
  if (AUDITED_AUTHORS_ALLOWLIST.includes(parsedId.owner)) {
    return { decision: 'allow', allowedBy: 'audited_authors_allowlist' };
  }

  return {
    decision: 'block',
    reason: `install_threshold:${installCount}:${minInstalls}`,
  };
}
