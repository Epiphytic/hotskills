/**
 * Environment-variable trust boundary for the hotskills MCP server.
 *
 * The .mcp.json plugin manifest passes two substituted env vars into the
 * server process at boot:
 *   - HOTSKILLS_PROJECT_CWD   (sourced from ${CLAUDE_PROJECT_DIR})
 *   - HOTSKILLS_CONFIG_DIR    (default ${HOME}/.config/hotskills)
 *
 * Per the phase-1 star-chamber nurture review (hotskills-2d6), these values
 * are attacker-influenceable (malicious project + malicious .mcp.json could
 * redirect cache / state writes into a privileged location). The server
 * MUST canonicalize + validate both before touching the filesystem:
 *
 *   - Both must be non-empty.
 *   - path.resolve() to a canonical absolute form.
 *   - HOTSKILLS_PROJECT_CWD must be an existing directory the server can
 *     read+write.
 *   - HOTSKILLS_CONFIG_DIR must either resolve under ${HOME}/.config OR
 *     match an explicit HOTSKILLS_DEV_OVERRIDE prefix (so the test suite
 *     and developer machines with custom XDG roots keep working).
 *
 * Failures raise ConfigError with a remediation message. The MCP server
 * entry point translates this into a structured stderr log + exit(1).
 */

import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(
    public readonly envVar: string,
    message: string,
    public readonly remediation?: string
  ) {
    super(`[config] ${envVar}: ${message}${remediation ? ` — ${remediation}` : ''}`);
    this.name = 'ConfigError';
  }
}

export interface HotskillsEnv {
  readonly projectCwd: string;
  readonly configDir: string;
  readonly devOverride: string | null;
}

const DEFAULT_CONFIG_SUBDIR = '.config/hotskills';
const DIR_MODE = 0o700;

function isChildOf(child: string, parent: string): boolean {
  // Both args are already canonicalized via path.resolve upstream, so we
  // can rely on string-prefix semantics with a trailing separator to avoid
  // matching siblings (e.g. "/home/u/.configX" must not match "/home/u/.config").
  const normalizedParent = parent.endsWith('/') ? parent : parent + '/';
  return child === parent || child.startsWith(normalizedParent);
}

function readEnvRequired(name: string, env = process.env): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(
      name,
      'env var is missing or empty',
      `set ${name} in .mcp.json "env" or the caller's environment`
    );
  }
  return raw;
}

function canonicalize(raw: string): string {
  // path.resolve normalizes '..' and '.', expands relative paths against
  // cwd, and yields a canonical absolute form. Note that it does NOT
  // resolve symlinks — if an attacker pre-creates a symlink at the
  // configDir location, we still write through it. That's accepted risk
  // for v0 (documented in SECURITY implications of ADR-001).
  return resolve(raw);
}

/**
 * Return the canonical absolute path to the project CWD. Throws ConfigError
 * if the env var is missing/empty, the path doesn't exist, it's not a
 * directory, or the server lacks read+write access.
 */
export function getProjectCwd(env: NodeJS.ProcessEnv = process.env): string {
  const raw = readEnvRequired('HOTSKILLS_PROJECT_CWD', env);
  const canonical = canonicalize(raw);

  let stat;
  try {
    stat = statSync(canonical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(
      'HOTSKILLS_PROJECT_CWD',
      `cannot stat path ${canonical} (${code ?? 'unknown'})`,
      'ensure the .mcp.json ${CLAUDE_PROJECT_DIR} substitution points to a real directory'
    );
  }

  if (!stat.isDirectory()) {
    throw new ConfigError(
      'HOTSKILLS_PROJECT_CWD',
      `path ${canonical} is not a directory`,
      'HOTSKILLS_PROJECT_CWD must name a directory, not a file'
    );
  }

  try {
    accessSync(canonical, constants.R_OK | constants.W_OK);
  } catch {
    throw new ConfigError(
      'HOTSKILLS_PROJECT_CWD',
      `insufficient permissions on ${canonical}`,
      'the server process must have read+write access to the project directory'
    );
  }

  return canonical;
}

/**
 * Return the canonical absolute path to the hotskills config dir, creating
 * it (mode 0700) if absent. Throws ConfigError if the path would escape
 * the sandbox (${HOME}/.config or HOTSKILLS_DEV_OVERRIDE).
 *
 * If HOTSKILLS_CONFIG_DIR is unset, defaults to `${HOME}/.config/hotskills`.
 * HOTSKILLS_DEV_OVERRIDE names a directory under which HOTSKILLS_CONFIG_DIR
 * is ALSO permitted to resolve (useful for tests and XDG-override users).
 */
/**
 * Locate a usable HOME path, refusing system-root values that would let
 * any user-writable HOTSKILLS_CONFIG_DIR resolve under a privileged
 * sandbox root. If both `env.HOME` and `homedir()` resolve to a system
 * root, we throw rather than silently widen the sandbox.
 *
 * Allowed values: any absolute path that is NOT '/', '/root', or empty.
 */
function resolveHomeOrThrow(env: NodeJS.ProcessEnv): string {
  const candidates: Array<{ source: string; value: string }> = [];
  if (env['HOME'] && env['HOME'].trim() !== '') {
    candidates.push({ source: 'HOME', value: env['HOME'] });
  }
  const fromOs = homedir();
  if (fromOs && fromOs.trim() !== '') {
    candidates.push({ source: 'os.homedir()', value: fromOs });
  }
  for (const { value } of candidates) {
    const resolved = resolve(value);
    if (resolved === '' || resolved === '/' || resolved === '/root') continue;
    return resolved;
  }
  throw new ConfigError(
    'HOME',
    'home directory resolves to a system root (/, /root) or is empty; ' +
      'a user-writable hotskills config dir cannot be derived from this',
    'set HOME explicitly to a user-owned directory, or set HOTSKILLS_DEV_OVERRIDE'
  );
}

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  // Allow HOTSKILLS_DEV_OVERRIDE alone to satisfy the home requirement —
  // CI containers often run as root with HOME=/root and rely on the dev
  // override to land in a tmp tree.
  const devOverrideRaw = env['HOTSKILLS_DEV_OVERRIDE'];
  const devOverride =
    devOverrideRaw && devOverrideRaw.trim() !== '' ? canonicalize(devOverrideRaw) : null;

  let home: string;
  try {
    home = resolveHomeOrThrow(env);
  } catch (err) {
    if (devOverride === null) throw err;
    // Use the dev override as a synthetic home so sandboxRoot lives there.
    home = devOverride;
  }
  const defaultRoot = resolve(home, '.config', 'hotskills');
  const sandboxRoot = resolve(home, '.config');

  const raw = env['HOTSKILLS_CONFIG_DIR'];
  const effective = raw && raw.trim() !== '' ? canonicalize(raw) : defaultRoot;

  const inSandbox = isChildOf(effective, sandboxRoot);
  const inDevOverride = devOverride !== null && isChildOf(effective, devOverride);

  if (!inSandbox && !inDevOverride) {
    throw new ConfigError(
      'HOTSKILLS_CONFIG_DIR',
      `resolves to ${effective}, which is outside the sandbox root ${sandboxRoot}`,
      devOverride === null
        ? `either set HOTSKILLS_CONFIG_DIR under ${sandboxRoot}, or set HOTSKILLS_DEV_OVERRIDE to a development prefix`
        : `or extend HOTSKILLS_DEV_OVERRIDE (currently ${devOverride}) to cover the requested path`
    );
  }

  try {
    mkdirSync(effective, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(
      'HOTSKILLS_CONFIG_DIR',
      `cannot create ${effective} (${code ?? 'unknown'})`,
      'check filesystem permissions on the parent directory'
    );
  }

  return effective;
}

/**
 * Resolve both env vars. Designed to be called once at server startup.
 * Throws ConfigError on any validation failure.
 */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): HotskillsEnv {
  const projectCwd = getProjectCwd(env);
  const configDir = getConfigDir(env);
  const devOverrideRaw = env['HOTSKILLS_DEV_OVERRIDE'];
  const devOverride =
    devOverrideRaw && devOverrideRaw.trim() !== '' ? canonicalize(devOverrideRaw) : null;
  return { projectCwd, configDir, devOverride };
}
