#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mergeConfigs, readGlobalConfig, readProjectConfig } from './config.js';
import { ConfigError, resolveEnv } from './env.js';
import { checkGitVersion, GitVersionError } from './materialize.js';
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

// Eager git-version check when the merged config has any github-typed
// source. Failures here are warnings (not fatal) — a later materialization
// would surface the same error; this just gives an early signal to the
// developer running with HOTSKILLS_DEBUG.
try {
  const project = await readProjectConfig(process.env['HOTSKILLS_PROJECT_CWD']!);
  const global = await readGlobalConfig(process.env['HOTSKILLS_CONFIG_DIR']!);
  const merged = mergeConfigs(global, project);
  const hasGithub = (merged.sources ?? []).some((s) => s.type === 'github');
  if (hasGithub) {
    try {
      await checkGitVersion();
    } catch (err) {
      if (err instanceof GitVersionError) {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            event: 'git_version_warning',
            message: err.message,
            remediation: err.remediation,
          }) + '\n'
        );
      } else {
        throw err;
      }
    }
  }
} catch {
  // Best-effort: a missing/invalid config at this stage is not fatal —
  // tools that need it will surface their own errors.
}

const server = new McpServer({
  name: 'hotskills',
  version: '0.1.0',
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
