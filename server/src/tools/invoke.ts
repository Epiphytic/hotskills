import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  mergeConfigs,
  readGlobalConfig,
  readProjectConfig,
  writeProjectConfig,
  type HotskillsConfig,
} from '../config.js';
import { cacheSkillPath } from '../materialize.js';
import { parseSkillId, SkillIdError, type ParsedSkillId } from '../skill-id.js';

export interface InvokeToolDeps {
  projectCwd?: string;
  configDir?: string;
}

export interface InvokeInput {
  skill_id: string;
  args?: Record<string, unknown>;
}

export interface ScriptEntry {
  name: string;
  path: string;
}

export interface ReferenceEntry {
  name: string;
  path: string;
}

export interface InvokeSuccess {
  body: string;
  path: string;
  scripts: ScriptEntry[];
  references: ReferenceEntry[];
  args_passed: Record<string, unknown>;
}

export interface InvokeErrorResult {
  error:
    | 'invalid_skill_id'
    | 'not_activated'
    | 'cache_missing'
    | 'manifest_corrupted'
    | 'internal_error';
  message: string;
  expected_format?: string;
}

function getProjectCwd(deps: InvokeToolDeps): string {
  const cwd = deps.projectCwd ?? process.env['HOTSKILLS_PROJECT_CWD'];
  if (!cwd || cwd.trim() === '') throw new Error('HOTSKILLS_PROJECT_CWD is not set');
  return cwd;
}

function getConfigDir(deps: InvokeToolDeps): string {
  const dir = deps.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') throw new Error('HOTSKILLS_CONFIG_DIR is not set');
  return dir;
}

/**
 * Enumerate top-level files in `<target>/<sub>` matching the supplied
 * predicate. Returns [] when the directory is missing — that is not an
 * error per ADR-003.
 */
function enumerateDir(
  target: string,
  sub: string,
  matches: (e: Dirent) => boolean
): Array<{ name: string; path: string }> {
  const dir = join(target, sub);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; path: string }> = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // defense in depth
    if (!matches(e)) continue;
    out.push({ name: e.name, path: join(dir, e.name) });
  }
  return out;
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function dropFromAllowList(
  projectCwd: string,
  projectConfig: HotskillsConfig,
  skillId: string
): Promise<void> {
  const next: HotskillsConfig = {
    ...projectConfig,
    activated: (projectConfig.activated ?? []).filter((a) => a.skill_id !== skillId),
  };
  await writeProjectConfig(projectCwd, next);
}

export async function runInvoke(
  input: InvokeInput,
  deps: InvokeToolDeps = {}
): Promise<InvokeSuccess | InvokeErrorResult> {
  // 1. Parse skill_id.
  let parsedId: ParsedSkillId;
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

  // 2. Verify in merged allow-list.
  const projectCwd = getProjectCwd(deps);
  const configDir = getConfigDir(deps);
  const projectConfig = await readProjectConfig(projectCwd);
  const globalConfig = await readGlobalConfig(configDir);
  const merged = mergeConfigs(globalConfig, projectConfig);
  const inAllowList = (merged.activated ?? []).some((a) => a.skill_id === input.skill_id);
  if (!inAllowList) {
    return {
      error: 'not_activated',
      message: `skill ${input.skill_id} is not in the merged allow-list; call hotskills.activate first`,
    };
  }

  // 3. Read SKILL.md.
  const target = cacheSkillPath(parsedId, configDir);
  const skillMdPath = join(target, 'SKILL.md');
  if (!existsSync(skillMdPath) || !statSync(skillMdPath).isFile()) {
    // Stale allow-list entry — drop and surface to caller.
    await dropFromAllowList(projectCwd, projectConfig, input.skill_id);
    return {
      error: 'cache_missing',
      message: `cache for ${input.skill_id} is missing or stale at ${target}; allow-list entry removed — re-activate to retry`,
    };
  }

  let body: string;
  try {
    body = readFileSync(skillMdPath, 'utf8');
  } catch (err) {
    return {
      error: 'cache_missing',
      message: `failed to read ${skillMdPath}: ${(err as Error).message}`,
    };
  }

  // 4. Read manifest (best-effort surfacing of corruption).
  const manifestPath = join(target, '.hotskills-manifest.json');
  if (existsSync(manifestPath)) {
    try {
      JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      return {
        error: 'manifest_corrupted',
        message: `manifest at ${manifestPath} is not valid JSON`,
      };
    }
  }

  // 5. ${SKILL_PATH} substitution.
  const substituted = body.split('${SKILL_PATH}').join(target);

  // 6. Enumerate scripts/ and references/.
  const scripts: ScriptEntry[] = enumerateDir(target, 'scripts', (e) => {
    if (!e.isFile()) return false;
    return isExecutableFile(join(target, 'scripts', e.name));
  });
  const references: ReferenceEntry[] = enumerateDir(target, 'references', (e) =>
    e.isFile() && e.name.endsWith('.md')
  );

  return {
    body: substituted,
    path: target,
    scripts,
    references,
    args_passed: input.args ?? {},
  };
}

export function registerInvoke(server: McpServer): void {
  server.tool(
    'hotskills.invoke',
    'Return the SKILL.md body and materialized path for an activated skill. Script execution is performed by the caller via Bash — hotskills never executes scripts itself.',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
      args: z.record(z.unknown()).optional().describe('Arguments to pass to the skill'),
    },
    async ({ skill_id, args }) => {
      try {
        const result = await runInvoke({ skill_id, ...(args ? { args } : {}) });
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
