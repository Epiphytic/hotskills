import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerInvoke(server: McpServer): void {
  server.tool(
    'hotskills.invoke',
    'Return the SKILL.md body and materialized path for an activated skill. Script execution is performed by the caller via Bash — hotskills never executes scripts itself.',
    {
      skill_id: z.string().describe('Fully-qualified skill ID: <source>:<owner>/<repo>:<slug>'),
      args: z.record(z.unknown()).optional().describe('Arguments to pass to the skill'),
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true }) }],
    })
  );
}
