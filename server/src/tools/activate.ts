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
import { parseSkillId, SkillIdError } from '../skill-id.js';
import { resolveConfigDir, resolveProjectCwd } from './_util.js';

interface GateDecision {
  decision: 'allow' | 'block';
  reason?: string;
  layers: { whitelist: string; audit: string; heuristic: string; install: string };
}

/**
 * Phase-3 stub gate: pass-through ALLOW.
 * Phase 4 (Task 4.6) replaces this with the real four-layer gate stack.
 * Surfacing the layers shape now keeps the tool response stable across
 * the phase boundary so callers don't need to special-case v0 output.
 */
async function runGateStackStub(
  _parsedId: ReturnType<typeof parseSkillId>,
  _merged: HotskillsConfig
): Promise<GateDecision> {
  return {
    decision: 'allow',
    layers: { whitelist: 'skipped', audit: 'skipped', heuristic: 'skipped', install: 'skipped' },
  };
}

export interface ActivateToolDeps {
  /** Override the configured project cwd (tests). */
  projectCwd?: string;
  configDir?: string;
  /** Phase-4 wires the real gate; tests can stub this directly. */
  gate?: typeof runGateStackStub;
  /** Pass-through to activateSkill — usually only set in tests. */
  activateOptions?: ActivateOptions;
  /** Audit lookup override (tests). */
  auditLookup?: typeof getAuditData;
}

export interface ActivateInput {
  skill_id: string;
  force_whitelist?: boolean;
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
    | 'internal_error';
  message: string;
  expected_format?: string;
  layers?: GateDecision['layers'];
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
  // matches in phase 4. The picker is responsible for the user-facing
  // confirmation prompt per ADR-004.
  if (input.force_whitelist === true) {
    projectConfig = appendWhitelistSkill(projectConfig, input.skill_id);
    try {
      await writeProjectConfig(projectCwd, projectConfig);
    } catch (err) {
      return { error: 'config_write_failed', message: (err as Error).message };
    }
  }

  // 4. Run gate stack (stub in v0).
  const gate = deps.gate ?? runGateStackStub;
  const merged = mergeConfigs(globalConfig, projectConfig);
  const decision = await gate(parsedId, merged);
  if (decision.decision === 'block') {
    return {
      error: 'gate_blocked',
      message: decision.reason ?? 'gate blocked',
      layers: decision.layers,
    };
  }

  // 5. Fetch audit snapshot (best-effort; null on any failure).
  const auditLookup = deps.auditLookup ?? getAuditData;
  let snapshot: AuditSnapshot;
  try {
    const lookup = await auditLookup(parsedId);
    snapshot = { audit: lookup.audit, cached_at: new Date().toISOString() };
  } catch {
    snapshot = { audit: null, cached_at: new Date().toISOString() };
  }

  // 6. Materialize + manifest.
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
    },
    async ({ skill_id, force_whitelist }) => {
      try {
        const result = await runActivate({ skill_id, force_whitelist });
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
