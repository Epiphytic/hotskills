import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  mergeConfigs,
  readGlobalConfig,
  readProjectConfig,
  type ActivatedSkill,
} from '../config.js';

export type ListScope = 'project' | 'global' | 'merged';

export interface ListToolDeps {
  projectCwd?: string;
  configDir?: string;
}

export interface ListInput {
  scope?: ListScope;
}

export interface ListResult {
  scope: ListScope;
  activated: ActivatedSkill[];
}

function getProjectCwd(deps: ListToolDeps): string {
  const cwd = deps.projectCwd ?? process.env['HOTSKILLS_PROJECT_CWD'];
  if (!cwd || cwd.trim() === '') throw new Error('HOTSKILLS_PROJECT_CWD is not set');
  return cwd;
}

function getConfigDir(deps: ListToolDeps): string {
  const dir = deps.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') throw new Error('HOTSKILLS_CONFIG_DIR is not set');
  return dir;
}

export async function runList(
  input: ListInput,
  deps: ListToolDeps = {}
): Promise<ListResult> {
  const scope: ListScope = input.scope ?? 'merged';
  const projectCwd = getProjectCwd(deps);
  const configDir = getConfigDir(deps);

  const project = await readProjectConfig(projectCwd);
  const global = await readGlobalConfig(configDir);

  if (scope === 'project') {
    return { scope, activated: project.activated ?? [] };
  }
  if (scope === 'global') {
    return { scope, activated: global.activated ?? [] };
  }
  // merged
  const merged = mergeConfigs(global, project);
  return { scope, activated: merged.activated ?? [] };
}

export function registerList(server: McpServer): void {
  server.tool(
    'hotskills.list',
    'List activated skills for the current project, global config, or merged view',
    {
      scope: z
        .enum(['project', 'global', 'merged'])
        .default('merged')
        .describe('Which allow-list to query'),
    },
    async ({ scope }) => {
      try {
        const result = await runList({ scope });
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
                error: 'list_failed',
                message: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
        };
      }
    }
  );
}
