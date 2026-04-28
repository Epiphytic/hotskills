/**
 * Gate stack orchestrator — composes the four ADR-004 gate layers.
 *
 * Per ADR-004 §Gate stack:
 *   Order: whitelist → audit → heuristic → install
 *   First BLOCK short-circuits.
 *   Whitelist match short-circuits to ALLOW (subsequent layers `skipped`).
 *
 * Two entry points:
 *   - runGateStack:    full stack (used by hotskills.activate after materialization).
 *   - runGatePreview:  whitelist + audit + install (heuristic skipped because the
 *                      skill is not yet materialized). Used by hotskills.search
 *                      and hotskills.audit for read-only previews.
 *
 * Heuristic placement note: ADR-004 lists heuristic third. It scans the
 * materialized SKILL.md + scripts/, so it can only run after materialize.ts
 * has written the cache. activate.ts (Task 3.4) runs the gate stack BEFORE
 * materialization to avoid wasted IO on blocked skills. Resolution adopted
 * here: split gate stack into pre-materialize (whitelist/audit/install) and
 * post-materialize (heuristic). Both must pass; whitelist short-circuits both.
 *
 * The orchestrator returns a uniform `{decision, reason, layers}` shape so
 * callers don't need to special-case which path ran.
 */

import { existsSync } from 'node:fs';
import type { HotskillsConfig, SecurityConfig } from '../config.js';
import type { ParsedSkillId } from '../skill-id.js';
import { checkAuditGate, type AuditDecision, type AuditGateOptions } from './audit-gate.js';
import {
  checkHeuristic,
  type HeuristicDecision,
  type HeuristicOptions,
} from './heuristic.js';
import { checkInstallGate, type InstallDecision } from './install-gate.js';
import { UnsupportedResolutionError } from './risk.js';
import {
  checkWhitelist,
  type WhitelistDecision,
  type WhitelistOptions,
} from './whitelist.js';

// ─── Types ───

export type LayerStatus =
  | 'allow'
  | 'block'
  | 'skipped'
  | 'no_data'
  | 'unknown'
  | 'error';

export interface GateLayers {
  whitelist: LayerStatus;
  audit: LayerStatus;
  heuristic: LayerStatus;
  install: LayerStatus;
}

export type GateDecisionKind = 'allow' | 'block' | 'unknown';

export interface GateOutcome {
  decision: GateDecisionKind;
  /** Block reason from the layer that fired, or undefined when allow. */
  reason?: string;
  layers: GateLayers;
  /** Detailed per-layer results for the audit tool / picker. */
  details: {
    whitelist?: WhitelistDecision;
    audit?: AuditDecision;
    heuristic?: HeuristicDecision;
    install?: InstallDecision;
  };
  /** Aggregated warnings from layers (e.g. allow_with_warning audit policy). */
  warnings?: string[];
}

export interface GateStackOptions {
  configDir?: string;
  /** Per-layer overrides for tests. */
  whitelistOptions?: WhitelistOptions;
  auditGateOptions?: AuditGateOptions;
  heuristicOptions?: HeuristicOptions;
  /** Materialized skill directory (required for heuristic; absent → skipped). */
  skillDir?: string;
  /** Install count from search/audit (default 0 — github-source skills have no count). */
  installCount?: number;
  /**
   * When true, the install layer is reported as `skipped` instead of being
   * evaluated against `min_installs`. Used by the audit tool when the
   * caller hasn't supplied an install count: blocking on `install_threshold:0:N`
   * would be misleading information rather than a real gate decision.
   */
  skipInstallGate?: boolean;
}

// ─── Helpers ───

function emptyLayers(): GateLayers {
  return { whitelist: 'unknown', audit: 'unknown', heuristic: 'unknown', install: 'unknown' };
}

function configErrorReason(err: unknown): string {
  if (err instanceof UnsupportedResolutionError) {
    return `config_error:audit_conflict_resolution=${err.resolution}_unsupported`;
  }
  return `config_error:${(err as Error).message ?? 'unknown'}`;
}

// ─── Internal: run audit step uniformly ───

async function runAuditStep(
  parsedId: ParsedSkillId,
  security: SecurityConfig | undefined,
  opts: AuditGateOptions | undefined,
  layers: GateLayers,
  warnings: string[]
): Promise<{ ok: boolean; details: AuditDecision | undefined; reason?: string }> {
  let auditDecision: AuditDecision;
  try {
    auditDecision = await checkAuditGate(parsedId, security, opts ?? {});
  } catch (err) {
    layers.audit = 'error';
    return { ok: false, details: undefined, reason: configErrorReason(err) };
  }
  if (auditDecision.warning) warnings.push(auditDecision.warning);
  if (auditDecision.decision === 'block') {
    layers.audit = 'block';
    return { ok: false, details: auditDecision, reason: auditDecision.reason };
  }
  if (auditDecision.decision === 'no_data') {
    layers.audit = 'no_data';
  } else {
    layers.audit = 'allow';
  }
  return { ok: true, details: auditDecision };
}

// ─── Public API: full stack (post-materialize) ───

/**
 * Run the full gate stack — used by hotskills.activate after materialization.
 *
 * Layer order:
 *   1. whitelist  → on match: ALLOW immediately, log entry written.
 *   2. audit      → BLOCK on >risk_max; allow/no_data continue.
 *   3. heuristic  → BLOCK on >risk_max (only if enabled). Requires skillDir.
 *   4. install    → BLOCK on too-few-installs (unless author/preferred allow).
 */
export async function runGateStack(
  parsedId: ParsedSkillId,
  config: HotskillsConfig,
  opts: GateStackOptions = {}
): Promise<GateOutcome> {
  const layers = emptyLayers();
  const warnings: string[] = [];
  const details: GateOutcome['details'] = {};

  // ─── 1. Whitelist ───
  const wl = await checkWhitelist(parsedId, config, {
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    ...(opts.whitelistOptions ?? {}),
  });
  details.whitelist = wl;
  if (wl.allow) {
    layers.whitelist = 'allow';
    layers.audit = 'skipped';
    layers.heuristic = 'skipped';
    layers.install = 'skipped';
    return { decision: 'allow', layers, details, warnings };
  }
  layers.whitelist = 'block';

  // ─── 2. Audit ───
  const audit = await runAuditStep(
    parsedId,
    config.security,
    opts.auditGateOptions,
    layers,
    warnings
  );
  if (audit.details) details.audit = audit.details;
  if (!audit.ok) {
    layers.heuristic = 'skipped';
    layers.install = 'skipped';
    return {
      decision: 'block',
      layers,
      details,
      warnings,
      ...(audit.reason ? { reason: audit.reason } : {}),
    };
  }

  // ─── 3. Heuristic (post-materialize only) ───
  const heuristicCfg = config.security?.heuristic;
  if (!heuristicCfg?.enabled) {
    layers.heuristic = 'skipped';
  } else if (!opts.skillDir || !existsSync(opts.skillDir)) {
    // Heuristic enabled but skill not materialized — caller must handle this.
    // For runGateStack (post-materialize path) the skillDir should exist;
    // missing it indicates a wiring bug. Treat as skipped + warn rather
    // than crash.
    layers.heuristic = 'skipped';
    warnings.push('heuristic enabled but skill_dir missing; skipped');
  } else {
    const riskMaxCap = config.security?.risk_max ?? 'medium';
    const heuristic = checkHeuristic(opts.skillDir, heuristicCfg, {
      ...(opts.heuristicOptions ?? {}),
      riskMax: riskMaxCap,
    });
    details.heuristic = heuristic;
    if (heuristic.decision === 'block') {
      layers.heuristic = 'block';
      layers.install = 'skipped';
      return {
        decision: 'block',
        layers,
        details,
        warnings,
        ...(heuristic.reason ? { reason: heuristic.reason } : {}),
      };
    }
    layers.heuristic = heuristic.decision === 'skipped' ? 'skipped' : 'allow';
  }

  // ─── 4. Install + author ───
  const installCount = opts.installCount ?? 0;
  const install = checkInstallGate(parsedId, installCount, config.security);
  details.install = install;
  if (install.decision === 'block') {
    layers.install = 'block';
    return {
      decision: 'block',
      layers,
      details,
      warnings,
      ...(install.reason ? { reason: install.reason } : {}),
    };
  }
  layers.install = 'allow';

  return { decision: 'allow', layers, details, warnings };
}

// ─── Public API: pre-materialize preview ───

/**
 * Read-only preview used by hotskills.search and hotskills.audit.
 *
 * Identical to runGateStack but skips the heuristic layer (the skill isn't
 * materialized yet). When the audit gate reports `no_data` and the install
 * gate would block, the preview reports `unknown` (not `block`) — the
 * picker should surface this so users can decide whether to whitelist.
 */
export async function runGatePreview(
  parsedId: ParsedSkillId,
  config: HotskillsConfig,
  opts: GateStackOptions = {}
): Promise<GateOutcome> {
  const layers = emptyLayers();
  const warnings: string[] = [];
  const details: GateOutcome['details'] = {};

  // Whitelist preview — IMPORTANT: skip the log write so a search call
  // doesn't pollute whitelist-activations.log with non-activations.
  const wl = await checkWhitelist(parsedId, config, {
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    ...(opts.whitelistOptions ?? {}),
    skipLog: true,
  });
  details.whitelist = wl;
  if (wl.allow) {
    layers.whitelist = 'allow';
    layers.audit = 'skipped';
    layers.heuristic = 'skipped';
    layers.install = 'skipped';
    return { decision: 'allow', layers, details, warnings };
  }
  layers.whitelist = 'block';

  // Audit preview.
  const audit = await runAuditStep(
    parsedId,
    config.security,
    opts.auditGateOptions,
    layers,
    warnings
  );
  if (audit.details) details.audit = audit.details;
  if (!audit.ok) {
    layers.heuristic = 'skipped';
    layers.install = 'skipped';
    return {
      decision: 'block',
      layers,
      details,
      warnings,
      ...(audit.reason ? { reason: audit.reason } : {}),
    };
  }

  // Heuristic always skipped in preview (no materialization).
  layers.heuristic = 'skipped';

  // Install preview. When the caller explicitly opts out (audit tool with no
  // install_count), report 'skipped' rather than fabricating a 0 count.
  if (opts.skipInstallGate) {
    layers.install = 'skipped';
    return { decision: 'allow', layers, details, warnings };
  }
  const installCount = opts.installCount ?? 0;
  const install = checkInstallGate(parsedId, installCount, config.security);
  details.install = install;
  if (install.decision === 'block') {
    // If audit had no data, surface the install block as "unknown" instead
    // of a hard block in the preview — the picker can show "would block".
    layers.install = 'block';
    if (audit.details?.decision === 'no_data') {
      return {
        decision: 'unknown',
        layers,
        details,
        warnings,
        ...(install.reason ? { reason: install.reason } : {}),
      };
    }
    return {
      decision: 'block',
      layers,
      details,
      warnings,
      ...(install.reason ? { reason: install.reason } : {}),
    };
  }
  layers.install = 'allow';

  return { decision: 'allow', layers, details, warnings };
}
