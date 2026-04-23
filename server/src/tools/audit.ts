import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerAudit(server: McpServer): void {
  server.tool(
    'hotskills.audit',
    'Return cached security audit data for a skill from add-skill.vercel.sh/audit',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true }) }],
    })
  );
}
