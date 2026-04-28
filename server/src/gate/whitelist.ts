/**
 * Whitelist gate — first layer of the gate stack per ADR-004.
 *
 * Per ADR-004 §Gate stack step 1:
 *   If skill_id matches `security.whitelist.skills`,
 *   OR `owner` matches `security.whitelist.orgs`,
 *   OR `owner/repo` matches `security.whitelist.repos`,
 *   the gate MUST return ALLOW.
 *
 * Per ADR-004 §Whitelist override surface:
 *   Whitelist matches MUST log a one-line audit entry to
 *   `${HOTSKILLS_CONFIG_DIR}/logs/whitelist-activations.log` with
 *   skill_id, scope, timestamp, and matching whitelist entry.
 *
 * Append-atomicity:
 *   POSIX guarantees `write(2)` of length ≤ PIPE_BUF (≥ 512 bytes; Linux 4096)
 *   is atomic when the file was opened with O_APPEND. Node's
 *   fs.promises.appendFile uses O_APPEND under the hood. We keep each log
 *   line ≤ ~1 KiB by capping matched_entry serialization length.
 */

import { join } from 'node:path';
import type { HotskillsConfig } from '../config.js';
import { log, logPath } from '../logger.js';
import type { ParsedSkillId } from '../skill-id.js';
import { formatSkillId } from '../skill-id.js';

// ─── Types ───

export type WhitelistScope = 'skill' | 'repo' | 'org';

export interface WhitelistMatch {
  /** Which whitelist bucket matched. */
  scope: WhitelistScope;
  /** The exact entry string from the config that matched. */
  matched_entry: string;
}

export interface WhitelistAllow {
  allow: true;
  match: WhitelistMatch;
}

export interface WhitelistDeny {
  allow: false;
}

export type WhitelistDecision = WhitelistAllow | WhitelistDeny;

export interface WhitelistOptions {
  /** Override config dir (tests). Falls back to HOTSKILLS_CONFIG_DIR. */
  configDir?: string;
  /** Disable log writing entirely (tests, dry runs). */
  skipLog?: boolean;
}

// ─── Match logic ───

/**
 * Decide whether the parsed skill matches any whitelist entry.
 *
 * Order of checks: skills (most specific) → repos → orgs (broadest).
 * The first match wins; subsequent buckets aren't consulted.
 */
export function matchWhitelist(
  parsedId: ParsedSkillId,
  config: HotskillsConfig
): WhitelistDecision {
  const wl = config.security?.whitelist ?? {};
  const skillId = formatSkillId(parsedId);
  const ownerRepo = `${parsedId.owner}/${parsedId.repo}`;

  // 1. Exact skill_id match.
  for (const entry of wl.skills ?? []) {
    if (entry === skillId) {
      return { allow: true, match: { scope: 'skill', matched_entry: entry } };
    }
  }

  // 2. owner/repo match.
  for (const entry of wl.repos ?? []) {
    if (entry === ownerRepo) {
      return { allow: true, match: { scope: 'repo', matched_entry: entry } };
    }
  }

  // 3. owner (org) match.
  for (const entry of wl.orgs ?? []) {
    if (entry === parsedId.owner) {
      return { allow: true, match: { scope: 'org', matched_entry: entry } };
    }
  }

  return { allow: false };
}

// ─── Logging ───

const MAX_ENTRY_LEN = 256;

export function whitelistLogPath(configDir: string): string {
  return join(configDir, 'logs', 'whitelist-activations.log');
}

/**
 * Append one JSON line to whitelist-activations.log via the shared logger.
 *
 * Log line shape (matches ADR-004 §Phase 0 verification + §Whitelist log):
 *   { ts, level, event, skill_id, scope, matched_entry }
 *
 * `matched_entry` is truncated to MAX_ENTRY_LEN to keep each line well
 * under Linux's PIPE_BUF (4096) so concurrent appends stay atomic.
 */
export async function logWhitelistActivation(
  parsedId: ParsedSkillId,
  match: WhitelistMatch,
  opts: WhitelistOptions = {}
): Promise<void> {
  const entry =
    match.matched_entry.length > MAX_ENTRY_LEN
      ? match.matched_entry.slice(0, MAX_ENTRY_LEN) + '…'
      : match.matched_entry;
  // Resolve path eagerly so callers without HOTSKILLS_CONFIG_DIR get a
  // clear error (preserves the contract from before the logger refactor).
  const logOpts = opts.configDir !== undefined ? { configDir: opts.configDir } : undefined;
  logPath('whitelist', logOpts);
  await log(
    'whitelist',
    'info',
    'whitelist_activation',
    {
      skill_id: formatSkillId(parsedId),
      scope: match.scope,
      matched_entry: entry,
    },
    logOpts
  );
}

// ─── Public API ───

/**
 * Run the whitelist gate. On match, side-effect: writes one line to the
 * whitelist activations log (unless `opts.skipLog`).
 */
export async function checkWhitelist(
  parsedId: ParsedSkillId,
  config: HotskillsConfig,
  opts: WhitelistOptions = {}
): Promise<WhitelistDecision> {
  const decision = matchWhitelist(parsedId, config);
  if (decision.allow && !opts.skipLog) {
    await logWhitelistActivation(parsedId, decision.match, opts);
  }
  return decision;
}
