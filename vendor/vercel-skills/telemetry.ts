// vendored-from-START
// Source: https://github.com/vercel-labs/skills (src/telemetry.ts)
// Sync SHA: bc21a37a12b90fcb5aec051c91baf5b227b704b1 (tag v1.5.1)
// Sync date: 2026-04-23
// License: MIT (see ./LICENSE)
// Modifications: telemetry tracking removed (see ./patches/telemetry-strip-tracking.patch)
//   Retained: PartnerAudit, SkillAuditData, AuditResponse, fetchAuditData
//   Removed:  TELEMETRY_URL, track(), setVersion(), isCI(), isEnabled(),
//             cliVersion, all telemetry data interfaces (Install, Remove,
//             Update, Find, Sync), and the TelemetryData union.
// vendored-from-END

const AUDIT_URL = 'https://add-skill.vercel.sh/audit';

// ─── Security audit data ───

export interface PartnerAudit {
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

export type SkillAuditData = Record<string, PartnerAudit>;
export type AuditResponse = Record<string, SkillAuditData>;

/**
 * Fetch security audit results for skills from the audit API.
 * Returns null on any error or timeout — never blocks installation.
 */
export async function fetchAuditData(
  source: string,
  skillSlugs: string[],
  timeoutMs = 3000
): Promise<AuditResponse | null> {
  if (skillSlugs.length === 0) return null;

  try {
    const params = new URLSearchParams({
      source,
      skills: skillSlugs.join(','),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${AUDIT_URL}?${params.toString()}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    return (await response.json()) as AuditResponse;
  } catch {
    return null;
  }
}
