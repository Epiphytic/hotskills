import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerActivate(server: McpServer): void {
  server.tool(
    'hotskills.activate',
    'Activate a skill for the current project after security gate checks',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
      force_whitelist: z.boolean().optional().describe('Skip security gates and whitelist this skill'),
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true }) }],
    })
  );
}
