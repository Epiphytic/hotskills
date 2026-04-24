import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, resolveEnv } from './env.js';
import { registerTools } from './tools/index.js';

// Validate + canonicalize env before doing anything else. Failures here are
// fatal: the MCP server can't do useful work without a valid project cwd
// and config dir, and silently degrading would risk writing state into
// surprising locations.
try {
  const env = resolveEnv();
  // Re-export onto process.env in canonical form so downstream modules
  // (cache paths, activation, tools) read one authoritative value.
  process.env.HOTSKILLS_PROJECT_CWD = env.projectCwd;
  process.env.HOTSKILLS_CONFIG_DIR = env.configDir;
} catch (err) {
  if (err instanceof ConfigError) {
    const payload = JSON.stringify({
      level: 'error',
      event: 'config_error',
      envVar: err.envVar,
      message: err.message,
      remediation: err.remediation ?? null,
    });
    process.stderr.write(payload + '\n');
    process.exit(1);
  }
  throw err;
}

const server = new McpServer({
  name: 'hotskills',
  version: '0.1.0',
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
