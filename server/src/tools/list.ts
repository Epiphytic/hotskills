import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true }) }],
    })
  );
}
