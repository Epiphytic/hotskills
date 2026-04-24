import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readProjectConfig, writeProjectConfig, type HotskillsConfig } from '../config.js';
import { cacheSkillPath } from '../materialize.js';
import { parseSkillId, SkillIdError } from '../skill-id.js';

export interface DeactivateToolDeps {
  projectCwd?: string;
  configDir?: string;
}

export interface DeactivateInput {
  skill_id: string;
}

export interface DeactivateSuccess {
  skill_id: string;
  removed: true;
  cache_preserved_at: string;
}

export interface DeactivateErrorResult {
  error: 'invalid_skill_id' | 'not_activated_in_project' | 'config_write_failed' | 'internal_error';
  message: string;
  expected_format?: string;
}

function getProjectCwd(deps: DeactivateToolDeps): string {
  const cwd = deps.projectCwd ?? process.env['HOTSKILLS_PROJECT_CWD'];
  if (!cwd || cwd.trim() === '') throw new Error('HOTSKILLS_PROJECT_CWD is not set');
  return cwd;
}

function getConfigDir(deps: DeactivateToolDeps): string {
  const dir = deps.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') throw new Error('HOTSKILLS_CONFIG_DIR is not set');
  return dir;
}

export async function runDeactivate(
  input: DeactivateInput,
  deps: DeactivateToolDeps = {}
): Promise<DeactivateSuccess | DeactivateErrorResult> {
  let parsedId;
  try {
    parsedId = parseSkillId(input.skill_id);
  } catch (err) {
    if (err instanceof SkillIdError) {
      return {
        error: 'invalid_skill_id',
        message: err.reason,
        expected_format: '<source>:<owner>/<repo>:<slug>',
      };
    }
    return { error: 'internal_error', message: (err as Error).message };
  }

  const projectCwd = getProjectCwd(deps);
  const configDir = getConfigDir(deps);
  const project = await readProjectConfig(projectCwd);

  const activated = project.activated ?? [];
  if (!activated.some((a) => a.skill_id === input.skill_id)) {
    return {
      error: 'not_activated_in_project',
      message: `${input.skill_id} is not in the project allow-list; global allow-list is not modified`,
    };
  }

  const next: HotskillsConfig = {
    ...project,
    activated: activated.filter((a) => a.skill_id !== input.skill_id),
  };

  try {
    await writeProjectConfig(projectCwd, next);
  } catch (err) {
    return { error: 'config_write_failed', message: (err as Error).message };
  }

  return {
    skill_id: input.skill_id,
    removed: true,
    cache_preserved_at: cacheSkillPath(parsedId, configDir),
  };
}

export function registerDeactivate(server: McpServer): void {
  server.tool(
    'hotskills.deactivate',
    'Remove a skill from the current project allow-list (does not delete cache)',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
    },
    async ({ skill_id }) => {
      try {
        const result = await runDeactivate({ skill_id });
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
