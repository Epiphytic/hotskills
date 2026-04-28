import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearch } from './search.js';
import { registerActivate } from './activate.js';
import { registerDeactivate } from './deactivate.js';
import { registerList } from './list.js';
import { registerInvoke } from './invoke.js';
import { registerAudit } from './audit.js';

export function registerTools(server: McpServer): void {
  registerSearch(server);
  registerActivate(server);
  registerDeactivate(server);
  registerList(server);
  registerInvoke(server);
  registerAudit(server);
}
