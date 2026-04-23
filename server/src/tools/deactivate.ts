import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerDeactivate(server: McpServer): void {
  server.tool(
    'hotskills.deactivate',
    'Remove a skill from the current project allow-list (does not delete cache)',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true }) }],
    })
  );
}
