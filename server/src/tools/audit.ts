/**
 * hotskills.audit — return cached audit data + computed gate preview for a skill.
 *
 * Per ADR-004 §Phase 0 verification + plan-phase 4 §Task 4.7:
 *   - Accepts {skill_id} (validated via parseSkillId).
 *   - Returns cached AuditResponse via audit.ts (24h cache).
 *   - Includes gate_status preview computed via runGatePreview.
 *   - Includes heuristic findings if heuristic.enabled and the skill
 *     has been materialized to its cache path.
 *   - Never forces a re-fetch (the cache is consulted first; the audit
 *     client decides whether to fetch).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { getAuditData } from '../audit.js';
import {
  mergeConfigs,
  readGlobalConfig,
  readProjectConfig,
} from '../config.js';
import { runGatePreview, type GateOutcome } from '../gate/index.js';
import { checkHeuristic, type HeuristicDecision } from '../gate/heuristic.js';
import { cacheSkillPath } from '../materialize.js';
import { parseSkillId, SkillIdError } from '../skill-id.js';
import { resolveConfigDir, resolveProjectCwd } from './_util.js';

// ─── Types ───

export interface AuditToolDeps {
  projectCwd?: string;
  configDir?: string;
  /** Audit lookup override (tests). */
  auditLookup?: typeof getAuditData;
}

export interface AuditToolInput {
  skill_id: string;
}

export interface AuditToolSuccess {
  skill_id: string;
  /** Per-partner audit entries. null when no audit data is available. */
  audit: Record<string, unknown> | null;
  /** True when audit served from on-disk cache. */
  cached: boolean;
  /** ISO8601 timestamp of when this lookup completed (for diagnostics). */
  fetched_at: string;
  /** Read-only gate preview (whitelist + audit + install; heuristic only when materialized). */
  gate: GateOutcome;
  /** Heuristic findings when heuristic.enabled and the skill is materialized. */
  heuristic?: HeuristicDecision;
}

export interface AuditToolError {
  error: 'invalid_skill_id' | 'config_error' | 'internal_error';
  message: string;
  expected_format?: string;
}

// ─── Public API ───

export async function runAuditTool(
  input: AuditToolInput,
  deps: AuditToolDeps = {}
): Promise<AuditToolSuccess | AuditToolError> {
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

  // 2. Resolve env.
  let projectCwd: string | undefined;
  let configDir: string;
  try {
    configDir = resolveConfigDir(deps);
  } catch (err) {
    return { error: 'config_error', message: (err as Error).message };
  }
  try {
    projectCwd = resolveProjectCwd(deps);
  } catch {
    // projectCwd is optional for audit lookups — config merge falls back to global only.
    projectCwd = undefined;
  }

  // 3. Look up audit data (cache-first; never forces re-fetch beyond what
  // the audit client does on cache miss).
  const auditLookup = deps.auditLookup ?? getAuditData;
  const lookup = await auditLookup(parsedId);
  const fetchedAt = new Date().toISOString();

  // 4. Build merged config for the gate preview. Best-effort.
  let merged;
  try {
    const project = projectCwd
      ? await readProjectConfig(projectCwd)
      : { version: 1 };
    const global = await readGlobalConfig(configDir);
    merged = mergeConfigs(global, project);
  } catch (err) {
    return { error: 'config_error', message: (err as Error).message };
  }

  // 5. Compute gate preview using the same audit data we just fetched.
  // We pass an auditLookup that returns the lookup we already have so the
  // preview doesn't refetch.
  const inlineLookup = async () => lookup;
  let gate: GateOutcome;
  try {
    gate = await runGatePreview(parsedId, merged, {
      configDir,
      installCount: 0, // unknown at audit-tool time; install gate may report block
      auditGateOptions: { auditLookup: inlineLookup },
    });
  } catch (err) {
    return { error: 'config_error', message: (err as Error).message };
  }

  // 6. If heuristic is enabled AND the skill has been materialized, run the
  // heuristic and include findings. We never block on heuristic result here
  // — the runGatePreview already handles allow/block decisions; this is
  // pure information surface for the picker.
  let heuristic: HeuristicDecision | undefined;
  if (merged.security?.heuristic?.enabled) {
    const skillDir = cacheSkillPath(parsedId, configDir);
    if (existsSync(skillDir)) {
      const riskCap = merged.security?.risk_max ?? 'medium';
      heuristic = checkHeuristic(skillDir, merged.security.heuristic, {
        riskMax: riskCap,
      });
    }
  }

  return {
    skill_id: input.skill_id,
    audit: (lookup.audit ?? null) as Record<string, unknown> | null,
    cached: lookup.cached,
    fetched_at: fetchedAt,
    gate,
    ...(heuristic ? { heuristic } : {}),
  };
}

export function registerAudit(server: McpServer): void {
  server.tool(
    'hotskills.audit',
    'Return cached security audit data for a skill from add-skill.vercel.sh/audit',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
    },
    async ({ skill_id }) => {
      try {
        const result = await runAuditTool({ skill_id });
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
