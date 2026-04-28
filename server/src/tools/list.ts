import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  mergeConfigs,
  readGlobalConfig,
  readProjectConfig,
  type ActivatedSkill,
} from '../config.js';
import { resolveConfigDir, resolveProjectCwd, type ToolEnvDeps } from './_util.js';

export type ListScope = 'project' | 'global' | 'merged';

export type ListToolDeps = ToolEnvDeps;

export interface ListInput {
  scope?: ListScope;
}

export interface ListResult {
  scope: ListScope;
  activated: ActivatedSkill[];
}

export async function runList(
  input: ListInput,
  deps: ListToolDeps = {}
): Promise<ListResult> {
  const scope: ListScope = input.scope ?? 'merged';
  const projectCwd = resolveProjectCwd(deps);
  const configDir = resolveConfigDir(deps);

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
