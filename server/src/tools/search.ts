import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerSearch(server: McpServer): void {
  server.tool(
    'hotskills.search',
    'Search for skills from skills.sh and configured sources',
    {
      query: z.string().describe('Search query'),
      limit: z.number().int().positive().optional().describe('Max results to return'),
      sources: z.array(z.string()).optional().describe('Filter to specific sources'),
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true }) }],
    })
  );
}
