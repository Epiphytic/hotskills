/**
 * Audit API client — thin wrapper over vendor/vercel-skills/telemetry.ts.
 *
 * Per ADR-002 §Cache integrity + ADR-004 §Audit API:
 *   - Single-skill query: GET https://add-skill.vercel.sh/audit?source=<owner>/<repo>&skills=<slug>
 *   - 3000ms timeout (matches upstream default, also enforced by vendored fn)
 *   - Non-2xx, timeout, and parse errors all yield null (no-data sentinel)
 *   - Non-2xx / parse errors append a JSON line to audit-errors.log
 *   - Successful responses are cached 24h under
 *     ${HOTSKILLS_CONFIG_DIR}/cache/audit/<owner>-<repo>.json
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cacheAgeSeconds, cacheRead, cacheWrite } from './cache.js';
import {
  fetchAuditData,
  type AuditResponse,
  type SkillAuditData,
} from './vendor/vercel-skills/telemetry.js';

export type { AuditResponse, PartnerAudit, SkillAuditData } from './vendor/vercel-skills/telemetry.js';

const AUDIT_TTL_SECONDS = 24 * 60 * 60; // 24h per ADR-004

export interface ParsedSkillId {
  source: string;
  owner: string;
  repo: string;
  slug: string;
}

export interface AuditLookupResult {
  /** The per-skill entry from the audit API, or null when no data is available. */
  audit: SkillAuditData | null;
  /** True when the lookup served from the on-disk cache (no network). */
  cached: boolean;
  /** Age in seconds of the cache entry, when `cached` is true. */
  cacheAgeSeconds?: number;
}

/**
 * Shape checker: the audit API returns `{ [slug]: { [partner]: PartnerAudit } }`.
 * This is intentionally permissive — any extra fields are preserved; any
 * missing/wrong-typed ones cause the entry to be treated as no-data.
 */
function validateAuditResponse(data: unknown): AuditResponse {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('audit response is not a JSON object');
  }
  return data as AuditResponse;
}

function configDir(): string {
  const dir = process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') {
    throw new Error('HOTSKILLS_CONFIG_DIR is unset; server env validation should have rejected this');
  }
  return dir;
}

function cacheFilePath(parsed: ParsedSkillId): string {
  // Per ADR-004 §Audit API: ${HOTSKILLS_CONFIG_DIR}/cache/audit/<owner>-<repo>.json
  const fname = `${parsed.owner}-${parsed.repo}.json`;
  return join(configDir(), 'cache', 'audit', fname);
}

function logFilePath(): string {
  return join(configDir(), 'logs', 'audit-errors.log');
}

async function logAuditError(
  parsed: ParsedSkillId,
  reason: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const path = logFilePath();
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        event: 'audit_error',
        skill_id: `${parsed.source}:${parsed.owner}/${parsed.repo}:${parsed.slug}`,
        reason,
        ...extra,
      }) + '\n';
    await appendFile(path, line, { mode: 0o600 });
  } catch {
    // Logging failures must never propagate to callers.
  }
}

/**
 * Look up audit data for a single skill. Returns `{ audit: null }` when no
 * data is available for any reason (cache miss + fetch failure, schema
 * mismatch, timeout).
 *
 * Cache-first. On miss, calls the vendored fetchAuditData and caches a
 * successful response for 24h.
 */
export async function getAuditData(parsed: ParsedSkillId): Promise<AuditLookupResult> {
  const cachePath = cacheFilePath(parsed);

  const cached = await cacheRead<AuditResponse>(cachePath, AUDIT_TTL_SECONDS, validateAuditResponse);
  if (cached) {
    const age = cacheAgeSeconds(cachePath);
    return {
      audit: cached[parsed.slug] ?? null,
      cached: true,
      ...(age !== null ? { cacheAgeSeconds: age } : {}),
    };
  }

  const source = `${parsed.owner}/${parsed.repo}`;
  let response: AuditResponse | null;
  try {
    response = await fetchAuditData(source, [parsed.slug]);
  } catch (err) {
    // fetchAuditData already returns null on most failures; treat thrown
    // errors as no-data and log them.
    await logAuditError(parsed, 'fetch_threw', { error: String(err) });
    return { audit: null, cached: false };
  }

  if (response === null) {
    // Timeout, non-2xx, or network error per vendored implementation.
    // We can't distinguish which from inside the wrapper, so log a
    // generic no_data_from_api reason.
    await logAuditError(parsed, 'no_data_from_api');
    return { audit: null, cached: false };
  }

  let validated: AuditResponse;
  try {
    validated = validateAuditResponse(response);
  } catch (err) {
    await logAuditError(parsed, 'schema_mismatch', { error: String(err) });
    return { audit: null, cached: false };
  }

  // Cache the full response — other slugs in the same repo will reuse it.
  try {
    cacheWrite(cachePath, validated);
  } catch (err) {
    // Write failures are non-fatal; surface in log.
    await logAuditError(parsed, 'cache_write_failed', { error: String(err) });
  }

  return { audit: validated[parsed.slug] ?? null, cached: false };
}

