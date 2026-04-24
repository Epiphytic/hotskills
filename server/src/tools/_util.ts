/**
 * Tool helpers shared across the six tool handlers.
 *
 * Each tool exposes a `*ToolDeps` interface with optional `projectCwd` and
 * `configDir` overrides. Production callers leave them undefined and we
 * resolve from process.env (already validated by the server entry point).
 * Tests pass explicit values to avoid env-var leakage between cases.
 */

export interface ToolEnvDeps {
  projectCwd?: string;
  configDir?: string;
}

export function resolveProjectCwd(deps: ToolEnvDeps): string {
  const cwd = deps.projectCwd ?? process.env['HOTSKILLS_PROJECT_CWD'];
  if (!cwd || cwd.trim() === '') {
    throw new Error('HOTSKILLS_PROJECT_CWD is not set');
  }
  return cwd;
}

export function resolveConfigDir(deps: ToolEnvDeps): string {
  const dir = deps.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') {
    throw new Error('HOTSKILLS_CONFIG_DIR is not set');
  }
  return dir;
}
