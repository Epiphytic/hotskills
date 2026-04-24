/**
 * Config + state IO for hotskills.
 *
 * Per ADR-003 §State schema and §Per-project state:
 *   - global config:  ${HOTSKILLS_CONFIG_DIR}/config.json
 *   - project config: <projectCwd>/.hotskills/config.json
 *   - project state:  <projectCwd>/.hotskills/state.json
 *
 * All reads:
 *   1. Stat-then-read; missing → zero-state defaults.
 *   2. Parse JSON; parse failure → ConfigSchemaError (with file path).
 *   3. runMigrations() to current target version.
 *      UnsupportedVersionError from the runner becomes ConfigUpgradeRequiredError.
 *   4. Validate against AJV-compiled JSON Schema.
 *   5. If migrations changed the data, atomically write it back.
 *   6. Apply scalar defaults for missing optional fields (JSON Schema
 *      "default" is informational only; we apply it in TypeScript).
 *
 * All writes:
 *   - validate before persist
 *   - mkdir -p with mode 0700
 *   - cacheWrite for atomic .tmp + fsync + rename
 *
 * The merge rules in mergeConfigs follow ADR-003 §Per-project state:
 *   - activated: union dedup'd by skill_id (newer activated_at wins)
 *   - sources: union; project preferred:true entries shadow same owner/repo
 *   - security.whitelist.{orgs,repos,skills}: union (dedupe)
 *   - security.* scalars: project wins when defined
 *   - mode, opportunistic, cache.*, discovery.*: project wins when defined
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { cacheWrite } from './cache.js';
import { ConfigError } from './env.js';
import { runMigrations, UnsupportedVersionError } from './migrations/index.js';
import { validateConfig, validateState } from './schemas/index.js';

// ─── Target schema version ───

export const CONFIG_TARGET_VERSION = 1;
export const STATE_TARGET_VERSION = 1;

// ─── Types (mirror config.v1.json / state.v1.json) ───

export type SkillMode = 'interactive' | 'auto' | 'opportunistic';
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';
export type FindStrategy = 'cli' | 'api' | 'auto';

export interface ActivatedSkill {
  skill_id: string;
  activated_at: string;
  description?: string;
}

export interface SourceEntry {
  type: 'github' | 'git';
  owner: string;
  repo: string;
  branch?: string;
  preferred?: boolean;
}

export interface SecurityHeuristic {
  enabled?: boolean;
  patterns?: {
    broad_bash_glob?: boolean;
    write_outside_cwd?: boolean;
    curl_pipe_sh?: boolean;
    raw_network_egress?: boolean;
  };
}

export interface SecurityConfig {
  risk_max?: RiskLevel;
  min_installs?: number;
  audit_partners?: string[];
  audit_conflict_resolution?: 'max' | 'mean' | 'majority';
  no_audit_data_policy?: 'fallback_to_installs' | 'block' | 'allow_with_warning';
  preferred_sources?: string[];
  whitelist?: {
    orgs?: string[];
    repos?: string[];
    skills?: string[];
  };
  heuristic?: SecurityHeuristic;
}

export interface CacheTtls {
  search_ttl_seconds?: number;
  audit_ttl_seconds?: number;
  skills_ttl_seconds?: number;
}

export interface Discovery {
  find_strategy?: FindStrategy;
}

export interface HotskillsConfig {
  version: number;
  mode?: SkillMode;
  opportunistic?: boolean;
  activated?: ActivatedSkill[];
  sources?: SourceEntry[];
  security?: SecurityConfig;
  cache?: CacheTtls;
  discovery?: Discovery;
}

export interface HotskillsState {
  version: number;
  opportunistic_pending: boolean;
  session_id: string;
  last_compact_at?: string | null;
  last_session_start_at?: string | null;
}

// ─── Errors ───

export class ConfigSchemaError extends Error {
  constructor(public readonly path: string, public readonly errors: string[]) {
    super(`config at ${path} failed schema validation: ${errors.join('; ')}`);
    this.name = 'ConfigSchemaError';
  }
}

export class ConfigUpgradeRequiredError extends Error {
  constructor(
    public readonly path: string,
    public readonly found: number,
    public readonly target: number
  ) {
    super(
      `config at ${path} is version ${found}, newer than supported version ${target}; ` +
        `upgrade hotskills to read this config`
    );
    this.name = 'ConfigUpgradeRequiredError';
  }
}

// ─── Defaults ───

function defaultConfig(): HotskillsConfig {
  return { version: CONFIG_TARGET_VERSION };
}

function defaultState(): HotskillsState {
  return {
    version: STATE_TARGET_VERSION,
    opportunistic_pending: false,
    session_id: '',
  };
}

// ─── projectCwd validation (closes hotskills-rqw) ───

/**
 * Validate that `projectCwd` is a usable absolute directory before deriving
 * any filesystem path from it. The MCP server's startup validates the same
 * env var, but tools may receive a projectCwd from cached state or test
 * fixtures — re-validation here is defense in depth.
 */
function assertProjectCwd(projectCwd: string): string {
  if (typeof projectCwd !== 'string' || projectCwd.trim() === '') {
    throw new ConfigError(
      'HOTSKILLS_PROJECT_CWD',
      'projectCwd argument is missing or empty',
      'pass an absolute path to a writable directory'
    );
  }
  const canonical = pathResolve(projectCwd);
  let stat;
  try {
    stat = statSync(canonical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(
      'HOTSKILLS_PROJECT_CWD',
      `cannot stat ${canonical} (${code ?? 'unknown'})`,
      'projectCwd must name an existing directory'
    );
  }
  if (!stat.isDirectory()) {
    throw new ConfigError(
      'HOTSKILLS_PROJECT_CWD',
      `${canonical} is not a directory`,
      'projectCwd must be a directory'
    );
  }
  try {
    accessSync(canonical, constants.R_OK | constants.W_OK);
  } catch {
    throw new ConfigError(
      'HOTSKILLS_PROJECT_CWD',
      `insufficient permissions on ${canonical}`,
      'the server must have read+write access to projectCwd'
    );
  }
  return canonical;
}

// ─── Path computation ───

export function projectConfigPath(projectCwd: string): string {
  return join(assertProjectCwd(projectCwd), '.hotskills', 'config.json');
}

export function projectStatePath(projectCwd: string): string {
  return join(assertProjectCwd(projectCwd), '.hotskills', 'state.json');
}

export function globalConfigPath(configDir: string): string {
  if (!configDir || configDir.trim() === '') {
    throw new ConfigError(
      'HOTSKILLS_CONFIG_DIR',
      'configDir argument is missing or empty'
    );
  }
  return join(configDir, 'config.json');
}

// ─── Generic read/write ───

interface ReadResult<T> {
  data: T;
  upgraded: boolean;
}

async function readJsonOrDefault<T>(
  path: string,
  fallback: () => T,
  targetVersion: number,
  validator: (data: unknown) => { valid: boolean; errors: string[] }
): Promise<ReadResult<T>> {
  if (!existsSync(path)) {
    return { data: fallback(), upgraded: false };
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigSchemaError(path, [`read failed: ${(err as Error).message}`]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigSchemaError(path, [`JSON parse failed: ${(err as Error).message}`]);
  }

  let migrated: unknown;
  let upgraded = false;
  try {
    const result = runMigrations(parsed, targetVersion);
    migrated = result.migrated;
    upgraded = result.ranMigrations.length > 0;
  } catch (err) {
    if (err instanceof UnsupportedVersionError) {
      throw new ConfigUpgradeRequiredError(path, err.found, err.target);
    }
    throw err;
  }

  const verdict = validator(migrated);
  if (!verdict.valid) {
    throw new ConfigSchemaError(path, verdict.errors);
  }

  return { data: migrated as T, upgraded };
}

function writeJsonAtomic(path: string, data: unknown): void {
  cacheWrite(path, data);
}

// ─── Public read API ───

export async function readGlobalConfig(configDir: string): Promise<HotskillsConfig> {
  const path = globalConfigPath(configDir);
  const result = await readJsonOrDefault<HotskillsConfig>(
    path,
    defaultConfig,
    CONFIG_TARGET_VERSION,
    validateConfig
  );
  if (result.upgraded) {
    writeJsonAtomic(path, result.data);
  }
  return result.data;
}

export async function readProjectConfig(projectCwd: string): Promise<HotskillsConfig> {
  const path = projectConfigPath(projectCwd);
  const result = await readJsonOrDefault<HotskillsConfig>(
    path,
    defaultConfig,
    CONFIG_TARGET_VERSION,
    validateConfig
  );
  if (result.upgraded) {
    writeJsonAtomic(path, result.data);
  }
  return result.data;
}

export async function readProjectState(projectCwd: string): Promise<HotskillsState> {
  const path = projectStatePath(projectCwd);
  const result = await readJsonOrDefault<HotskillsState>(
    path,
    defaultState,
    STATE_TARGET_VERSION,
    validateState
  );
  if (result.upgraded) {
    writeJsonAtomic(path, result.data);
  }
  return result.data;
}

// ─── Public write API ───

export async function writeGlobalConfig(
  configDir: string,
  config: HotskillsConfig
): Promise<void> {
  const verdict = validateConfig(config);
  if (!verdict.valid) {
    throw new ConfigSchemaError(globalConfigPath(configDir), verdict.errors);
  }
  ensureConfigDir(configDir);
  writeJsonAtomic(globalConfigPath(configDir), config);
}

export async function writeProjectConfig(
  projectCwd: string,
  config: HotskillsConfig
): Promise<void> {
  const verdict = validateConfig(config);
  if (!verdict.valid) {
    throw new ConfigSchemaError(projectConfigPath(projectCwd), verdict.errors);
  }
  const path = projectConfigPath(projectCwd);
  ensureProjectHotskillsDir(projectCwd);
  writeJsonAtomic(path, config);
}

export async function writeProjectState(
  projectCwd: string,
  state: HotskillsState
): Promise<void> {
  const verdict = validateState(state);
  if (!verdict.valid) {
    throw new ConfigSchemaError(projectStatePath(projectCwd), verdict.errors);
  }
  const path = projectStatePath(projectCwd);
  ensureProjectHotskillsDir(projectCwd);
  writeJsonAtomic(path, state);
  // Lazily patch .gitignore (idempotent) on first state write so the
  // ephemeral state file never lands in commits.
  await patchGitignore(projectCwd);
}

function ensureConfigDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
}

function ensureProjectHotskillsDir(projectCwd: string): void {
  const dir = join(assertProjectCwd(projectCwd), '.hotskills');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ─── .gitignore patching ───

const GITIGNORE_ENTRY = '.hotskills/state.json';

/**
 * Idempotently append `.hotskills/state.json` to `<projectCwd>/.gitignore`
 * if a .gitignore exists and does not already contain the entry.
 *
 * Behavior:
 *   - .gitignore missing → no-op (do NOT create one; the project may not
 *     use git, and creating a .gitignore would be presumptuous).
 *   - entry already present (exact line) → no-op.
 *   - otherwise append a newline + entry + newline.
 */
export async function patchGitignore(projectCwd: string): Promise<void> {
  const gitignore = join(assertProjectCwd(projectCwd), '.gitignore');
  if (!existsSync(gitignore)) return;

  let body: string;
  try {
    body = await readFile(gitignore, 'utf8');
  } catch {
    return; // best-effort
  }

  const lines = body.split('\n').map((l) => l.trim());
  if (lines.includes(GITIGNORE_ENTRY)) return;

  const trailingNewline = body.endsWith('\n') ? '' : '\n';
  const append = `${trailingNewline}${GITIGNORE_ENTRY}\n`;
  try {
    await appendFile(gitignore, append);
  } catch {
    // best-effort; non-fatal
  }
}

// ─── Merge logic ───

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    seen.set(keyFn(item), item);
  }
  return Array.from(seen.values());
}

function dedupeStrings(items: string[]): string[] {
  return Array.from(new Set(items));
}

function maxByActivatedAt(a: ActivatedSkill, b: ActivatedSkill): ActivatedSkill {
  return a.activated_at >= b.activated_at ? a : b;
}

/**
 * Merge global + project configs per ADR-003 rules.
 *
 * The result always carries the target version. Both inputs MUST already
 * have passed migration to the same target version.
 */
export function mergeConfigs(
  global: HotskillsConfig,
  project: HotskillsConfig
): HotskillsConfig {
  // activated: union dedup'd by skill_id; newer activated_at wins.
  const allActivated = [...(global.activated ?? []), ...(project.activated ?? [])];
  const activatedMap = new Map<string, ActivatedSkill>();
  for (const entry of allActivated) {
    const existing = activatedMap.get(entry.skill_id);
    activatedMap.set(entry.skill_id, existing ? maxByActivatedAt(existing, entry) : entry);
  }
  const activated = Array.from(activatedMap.values());

  // sources: union; project preferred:true shadows same owner/repo from global.
  const projectShadowed = new Set(
    (project.sources ?? [])
      .filter((s) => s.preferred === true)
      .map((s) => `${s.owner}/${s.repo}`)
  );
  const sources = [
    ...(global.sources ?? []).filter((s) => !projectShadowed.has(`${s.owner}/${s.repo}`)),
    ...(project.sources ?? []),
  ];

  // security.whitelist.{orgs,repos,skills}: union dedupe.
  const globalSec = global.security ?? {};
  const projectSec = project.security ?? {};
  const globalWl = globalSec.whitelist ?? {};
  const projectWl = projectSec.whitelist ?? {};
  const whitelist = {
    orgs: dedupeStrings([...(globalWl.orgs ?? []), ...(projectWl.orgs ?? [])]),
    repos: dedupeStrings([...(globalWl.repos ?? []), ...(projectWl.repos ?? [])]),
    skills: dedupeStrings([...(globalWl.skills ?? []), ...(projectWl.skills ?? [])]),
  };

  // security.* scalars: project wins when defined.
  const security: SecurityConfig = {
    ...globalSec,
    ...projectSec,
    whitelist,
  };

  // mode, opportunistic, cache.*, discovery.*: project wins when defined.
  const mode = project.mode ?? global.mode;
  const opportunistic = project.opportunistic ?? global.opportunistic;
  const cache = project.cache ?? global.cache;
  const discovery = project.discovery ?? global.discovery;

  const merged: HotskillsConfig = {
    version: CONFIG_TARGET_VERSION,
    activated: dedupeBy(activated, (a) => a.skill_id),
    sources,
    security,
  };
  if (mode !== undefined) merged.mode = mode;
  if (opportunistic !== undefined) merged.opportunistic = opportunistic;
  if (cache !== undefined) merged.cache = cache;
  if (discovery !== undefined) merged.discovery = discovery;
  return merged;
}

// ─── Test-only utilities ───

/**
 * For tests that want to read a persisted file without touching the
 * canonical accessors. NOT for production code.
 */
export function _readRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
