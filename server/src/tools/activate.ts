import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { activateSkill, type ActivateOptions, type AuditSnapshot } from '../activation.js';
import { getAuditData } from '../audit.js';
import {
  mergeConfigs,
  readGlobalConfig,
  readProjectConfig,
  writeProjectConfig,
  type ActivatedSkill,
  type HotskillsConfig,
} from '../config.js';
import { runGateStack, type GateOutcome, type GateStackOptions } from '../gate/index.js';
import { logWhitelistActivation } from '../gate/whitelist.js';
import { parseSkillId, SkillIdError } from '../skill-id.js';
import { resolveConfigDir, resolveProjectCwd } from './_util.js';

type GateDecision = GateOutcome;

export interface ActivateToolDeps {
  /** Override the configured project cwd (tests). */
  projectCwd?: string;
  configDir?: string;
  /** Override the gate stack (tests). Default: runGateStack from gate/index. */
  gate?: (
    parsedId: ReturnType<typeof parseSkillId>,
    merged: HotskillsConfig,
    opts: GateStackOptions
  ) => Promise<GateOutcome>;
  /** Pass-through to activateSkill — usually only set in tests. */
  activateOptions?: ActivateOptions;
  /** Audit lookup override (tests). */
  auditLookup?: typeof getAuditData;
  /**
   * Skill install count, when known by the caller (e.g. picker passes the
   * value from search results). Defaults to 0; the install gate then
   * relies on preferred_sources / built-in allowlist for github sources.
   */
  installCount?: number;
}

export interface ActivateInput {
  skill_id: string;
  force_whitelist?: boolean;
  /** Optional install count from search results, fed to the install gate. */
  install_count?: number;
}

export interface ActivateSuccess {
  skill_id: string;
  path: string;
  manifest: import('../activation.js').ActivationManifest;
  reused: boolean;
  gate: GateDecision;
}

export interface ActivateErrorResult {
  error:
    | 'invalid_skill_id'
    | 'gate_blocked'
    | 'materialization_failed'
    | 'config_write_failed'
    | 'config_error'
    | 'internal_error';
  message: string;
  expected_format?: string;
  layers?: GateDecision['layers'];
  reason?: string;
}

/**
 * Append (or replace) an entry in `activated`, dedup'd by skill_id.
 * Returns a new array; never mutates the input.
 */
function upsertActivated(
  current: ActivatedSkill[] | undefined,
  entry: ActivatedSkill
): ActivatedSkill[] {
  const out = (current ?? []).filter((a) => a.skill_id !== entry.skill_id);
  out.push(entry);
  return out;
}

function appendWhitelistSkill(config: HotskillsConfig, skillId: string): HotskillsConfig {
  const security = { ...(config.security ?? {}) };
  const whitelist = { ...(security.whitelist ?? {}) };
  const skills = whitelist.skills ? [...whitelist.skills] : [];
  if (!skills.includes(skillId)) skills.push(skillId);
  whitelist.skills = skills;
  security.whitelist = whitelist;
  return { ...config, security };
}

/**
 * Run the full activate flow. Exposed for testing without going through
 * the MCP server harness.
 *
 * Flow per ADR-004 §Gate stack and ADR-003 §Materialization:
 *   1. Parse skill_id.
 *   2. Read project + global config; merge.
 *   3. If force_whitelist: append to project whitelist AND log entry to
 *      whitelist-activations.log (closes hotskills-0rk).
 *   4. Fetch audit snapshot (best-effort).
 *   5. Materialize the skill so the heuristic gate can scan its tree.
 *      Idempotent — re-activating an already-cached skill is cheap.
 *   6. Run the four-layer gate stack (whitelist → audit → heuristic → install).
 *      Block at any layer aborts before allow-list write.
 *   7. Append to project allow-list (dedupe by skill_id).
 *
 * Materialization happens BEFORE the gate decision so the heuristic layer
 * has the SKILL.md tree to scan. This means a blocked-by-gate skill leaves
 * its cache directory populated — that's intentional: the cache write is
 * idempotent and re-running activate after a config change (e.g. adding
 * the skill to the whitelist) skips re-materialization.
 */
export async function runActivate(
  input: ActivateInput,
  deps: ActivateToolDeps = {}
): Promise<ActivateSuccess | ActivateErrorResult> {
  // 1. Parse skill_id.
  let parsedId;
  try {
    parsedId = parseSkillId(input.skill_id);
  } catch (err) {
    if (err instanceof SkillIdError) {
      return {
        error: 'invalid_skill_id',
        message: err.reason,
        expected_format: '<source>:<owner>/<repo>:<slug> (source ∈ {skills.sh, github, git})',
      };
    }
    return { error: 'internal_error', message: (err as Error).message };
  }

  // 2. Read configs.
  const projectCwd = resolveProjectCwd(deps);
  const configDir = resolveConfigDir(deps);
  let projectConfig = await readProjectConfig(projectCwd);
  const globalConfig = await readGlobalConfig(configDir);

  // 3. force_whitelist: append BEFORE running gate so the whitelist layer
  // matches. Also log to whitelist-activations.log per ADR-004 (closes
  // hotskills-0rk: the picker confirmation has already happened in slash
  // command UX; this is the audit trail).
  if (input.force_whitelist === true) {
    projectConfig = appendWhitelistSkill(projectConfig, input.skill_id);
    try {
      await writeProjectConfig(projectCwd, projectConfig);
    } catch (err) {
      return { error: 'config_write_failed', message: (err as Error).message };
    }
    try {
      await logWhitelistActivation(
        parsedId,
        { scope: 'skill', matched_entry: input.skill_id },
        { configDir }
      );
    } catch {
      // Logging failure must never abort the activation.
    }
  }

  // 4. Fetch audit snapshot (best-effort; null on any failure).
  const auditLookup = deps.auditLookup ?? getAuditData;
  let snapshot: AuditSnapshot;
  try {
    const lookup = await auditLookup(parsedId);
    snapshot = { audit: lookup.audit, cached_at: new Date().toISOString() };
  } catch {
    snapshot = { audit: null, cached_at: new Date().toISOString() };
  }

  // 5. Materialize first so the heuristic gate can scan the tree.
  let outcome;
  try {
    const opts: ActivateOptions = deps.activateOptions ?? {};
    if (deps.configDir !== undefined && opts.configDir === undefined) {
      opts.configDir = deps.configDir;
    }
    outcome = await activateSkill(parsedId, snapshot, opts);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return {
      error: 'materialization_failed',
      message: msg.length > 500 ? msg.slice(0, 500) + '…' : msg,
    };
  }

  // 6. Run gate stack post-materialize.
  const merged = mergeConfigs(globalConfig, projectConfig);
  const gate = deps.gate ?? runGateStack;
  let decision: GateOutcome;
  try {
    decision = await gate(parsedId, merged, {
      configDir,
      skillDir: outcome.path,
      installCount: input.install_count ?? deps.installCount ?? 0,
      // Wire the audit-lookup override through to the audit gate; tests
      // pass a stub here so the gate doesn't try to read process.env or
      // hit the network.
      ...(deps.auditLookup ? { auditGateOptions: { auditLookup: deps.auditLookup } } : {}),
    });
  } catch (err) {
    return {
      error: 'config_error',
      message: (err as Error).message ?? String(err),
    };
  }
  if (decision.decision === 'block') {
    return {
      error: 'gate_blocked',
      message: decision.reason ?? 'gate blocked',
      layers: decision.layers,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }

  // 7. Append to project allow-list (dedupe).
  const entry: ActivatedSkill = {
    skill_id: outcome.skill_id,
    activated_at: outcome.manifest.activated_at,
  };
  const updated: HotskillsConfig = {
    ...projectConfig,
    activated: upsertActivated(projectConfig.activated, entry),
  };
  try {
    await writeProjectConfig(projectCwd, updated);
  } catch (err) {
    return { error: 'config_write_failed', message: (err as Error).message };
  }

  return {
    skill_id: outcome.skill_id,
    path: outcome.path,
    manifest: outcome.manifest,
    reused: outcome.reused,
    gate: decision,
  };
}

export function registerActivate(server: McpServer): void {
  server.tool(
    'hotskills.activate',
    'Activate a skill for the current project after security gate checks',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
      force_whitelist: z.boolean().optional().describe('Skip security gates and whitelist this skill'),
      install_count: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Install count from search results, used by the install gate'),
    },
    async ({ skill_id, force_whitelist, install_count }) => {
      try {
        const input: ActivateInput = { skill_id };
        if (force_whitelist !== undefined) input.force_whitelist = force_whitelist;
        if (install_count !== undefined) input.install_count = install_count;
        const result = await runActivate(input);
        if ('error' in result) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'internal_error',
                message: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
        };
      }
    }
  );
}
