/**
 * Skill materialization router — per ADR-002 Amendment 1.
 *
 * Two source-typed code paths, dispatched on `parsedId.source`:
 *
 *   skills.sh  → vendored blob.ts (GitHub Trees API → skills.sh
 *                `/api/download/:owner/:repo/:slug` blob); writes
 *                SKILL.md + siblings into
 *                `${HOTSKILLS_CONFIG_DIR}/cache/skills/skills.sh/<owner>/<repo>/<slug>/`.
 *
 *   github     → `git clone --depth 1 --filter=blob:none --sparse` into
 *                a temp dir, then `git sparse-checkout set <skill-subdir>`,
 *                then atomic rename of the subtree into
 *                `${HOTSKILLS_CONFIG_DIR}/cache/skills/github/<owner>/<repo>/<slug>/`.
 *
 * Both paths:
 *   - Acquire the cache directory lock via `withLock` so concurrent
 *     activations of the same skill serialize.
 *   - Sanitize owner/repo/slug before any subprocess invocation
 *     (reject anything outside [A-Za-z0-9._-]).
 *   - Verify `git --version >= 2.25` at startup when any github source
 *     is configured (public `checkGitVersion()` for activate.ts).
 *   - Write to a sibling temp dir first, then atomically rename into
 *     the final cache path to keep partial materializations out of the
 *     authoritative location.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { writeFile, mkdir as mkdirP } from 'node:fs/promises';
import { dirname, join, resolve as pathResolve, sep as pathSep } from 'node:path';
import { acquireLock, releaseLock } from './cache.js';
import { tryBlobInstall } from './vendor/vercel-skills/blob.js';

// ─── Errors ───

export class MaterializationError extends Error {
  constructor(message: string, public readonly parsed?: ParsedSkillId) {
    super(message);
    this.name = 'MaterializationError';
  }
}

export class GitVersionError extends Error {
  constructor(
    public readonly found: string | null,
    public readonly required = '2.25.0',
    public readonly remediation = 'install or upgrade git (https://git-scm.com/downloads); sparse-checkout requires git >= 2.25'
  ) {
    super(
      found === null
        ? `git not found on PATH; required >= ${required}. ${remediation}`
        : `git ${found} is older than required ${required}. ${remediation}`
    );
    this.name = 'GitVersionError';
  }
}

export class UnsafeSkillIdError extends Error {
  constructor(field: 'owner' | 'repo' | 'slug', value: string) {
    super(
      `Unsafe ${field}=${JSON.stringify(value)} — must match [A-Za-z0-9._-]+ (no shell metacharacters)`
    );
    this.name = 'UnsafeSkillIdError';
  }
}

// ─── Types ───

export interface ParsedSkillId {
  source: string;
  owner: string;
  repo: string;
  slug: string;
}

export interface MaterializationResult {
  /** Absolute path to the materialized skill directory. */
  readonly path: string;
  /** Content SHA of the snapshot, when the source reports one (blob.ts only). */
  readonly sha?: string;
  /** True when the materialization reused an existing cache entry. */
  readonly reused: boolean;
}

export interface GitRunner {
  /**
   * Run a `git` subcommand. Args are passed verbatim (never shell-interpolated).
   * Must reject with a structured error on non-zero exit; resolve with stdout
   * on success. Timeout and working directory are optional.
   */
  (args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<string>;
}

export interface MaterializeOptions {
  /** Override the config dir (otherwise reads `HOTSKILLS_CONFIG_DIR`). */
  configDir?: string;
  /** Inject a blob-install implementation (for tests). */
  blobInstall?: typeof tryBlobInstall;
  /** Inject a git runner (for tests). */
  git?: GitRunner;
  /** Per-skill lock acquire timeout; default 30s via cache.ts. */
  lockTimeoutMs?: number;
}

// ─── Sanitization ───

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function assertSafeSkillId(parsed: ParsedSkillId): void {
  if (!SAFE_NAME.test(parsed.owner)) throw new UnsafeSkillIdError('owner', parsed.owner);
  if (!SAFE_NAME.test(parsed.repo)) throw new UnsafeSkillIdError('repo', parsed.repo);
  if (!SAFE_NAME.test(parsed.slug)) throw new UnsafeSkillIdError('slug', parsed.slug);
}

// ─── Paths ───

function getConfigDir(opts?: MaterializeOptions): string {
  const dir = opts?.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') {
    throw new MaterializationError(
      'HOTSKILLS_CONFIG_DIR is not set and no configDir was provided'
    );
  }
  return dir;
}

export function cacheSkillPath(parsed: ParsedSkillId, configDir: string): string {
  assertSafeSkillId(parsed);
  // `source` is restricted to known values (skills.sh | github | git) by the
  // skill-ID parser; we still pass it through sanitization to be defensive.
  if (!/^[a-z][a-z0-9.]*$/.test(parsed.source)) {
    throw new MaterializationError(`unsafe source=${JSON.stringify(parsed.source)}`);
  }
  return pathResolve(
    configDir,
    'cache',
    'skills',
    parsed.source,
    parsed.owner,
    parsed.repo,
    parsed.slug
  );
}

// ─── Default git runner ───

export const defaultGit: GitRunner = (args, opts = {}) =>
  new Promise((resolveRun, rejectRun) => {
    // NEVER use shell:true here — that would re-open command injection
    // for anything that slipped through SAFE_NAME.
    const proc = spawn('git', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = opts.timeoutMs
      ? setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs)
      : null;

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.once('error', (err) => {
      if (timer) clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        rejectRun(new GitVersionError(null));
      } else {
        rejectRun(err);
      }
    });
    proc.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (signal || code !== 0) {
        rejectRun(
          new MaterializationError(
            `git ${args.join(' ')} failed (code=${code}, signal=${signal}): ${stderr.slice(0, 500)}`
          )
        );
      } else {
        resolveRun(stdout);
      }
    });
  });

// ─── Git version check ───

const MIN_GIT_VERSION: [number, number, number] = [2, 25, 0];

function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/**
 * Confirm `git` is available and `>= 2.25`. Called by activate.ts at
 * startup when any github-typed source appears in the merged config.
 * Throws GitVersionError otherwise.
 */
export async function checkGitVersion(git: GitRunner = defaultGit): Promise<string> {
  let output: string;
  try {
    output = await git(['--version'], { timeoutMs: 5000 });
  } catch (err) {
    if (err instanceof GitVersionError) throw err;
    throw new GitVersionError(null);
  }
  const m = output.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new GitVersionError(output.trim().slice(0, 40));
  const found: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (cmpSemver(found, MIN_GIT_VERSION) < 0) {
    throw new GitVersionError(`${found[0]}.${found[1]}.${found[2]}`);
  }
  return `${found[0]}.${found[1]}.${found[2]}`;
}

// ─── skills.sh path: vendored blob.ts ───

async function materializeSkillsSh(
  parsed: ParsedSkillId,
  target: string,
  opts: MaterializeOptions
): Promise<MaterializationResult> {
  const blobInstall = opts.blobInstall ?? tryBlobInstall;
  const result = await blobInstall(`${parsed.owner}/${parsed.repo}`, {
    skillFilter: parsed.slug,
  });
  if (!result || result.skills.length === 0) {
    throw new MaterializationError(
      `blob materialization failed for skills.sh:${parsed.owner}/${parsed.repo}:${parsed.slug}`,
      parsed
    );
  }

  // If multiple skills came back (shared owner/repo), select the one
  // whose computed slug matches ours. Fall back to first.
  const match = result.skills.find((s) => s.repoPath.includes(parsed.slug)) ?? result.skills[0]!;

  // Write files into a sibling .tmp dir, then atomically rename into place.
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(`${target}.materialize-`);
  try {
    // Files from the blob API are relative to the skill folder. Strip the
    // folder prefix so the materialized tree is rooted at SKILL.md.
    const folderPrefix = match.repoPath.endsWith('/SKILL.md')
      ? match.repoPath.slice(0, -('SKILL.md'.length))
      : '';

    for (const file of match.files) {
      const rel = file.path.startsWith(folderPrefix)
        ? file.path.slice(folderPrefix.length)
        : file.path;
      // Defense against a malicious blob returning '../..' paths.
      if (rel.startsWith('/') || rel.includes('..')) {
        throw new MaterializationError(
          `blob returned unsafe path ${JSON.stringify(file.path)}`,
          parsed
        );
      }
      const abs = join(tmp, rel);
      await mkdirP(dirname(abs), { recursive: true, mode: 0o700 });
      await writeFile(abs, file.contents, { mode: 0o600 });
    }

    // If the blob had no SKILL.md path explicitly, use the rawContent.
    const hasSkillMd = match.files.some((f) => f.path.endsWith('SKILL.md'));
    if (!hasSkillMd && match.rawContent) {
      await writeFile(join(tmp, 'SKILL.md'), match.rawContent, { mode: 0o600 });
    }

    // Atomic swap. If `target` already exists from a prior attempt, remove
    // it first; this only runs under the per-skill lock.
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }

  return { path: target, sha: match.snapshotHash, reused: false };
}

// ─── github path: sparse-checkout ───

/**
 * Discover the skill subdirectory inside a sparse-checked-out repo, using
 * the ADR-002 §7 source-scan order (root, skills/<slug>, .claude/skills/<slug>,
 * .agents/skills/<slug>).
 *
 * NB: the sparse-checkout has to happen BEFORE we know the subdir — so we
 * initially set the checkout to the union of all candidate prefixes, look
 * at which of them materialized, and narrow on the first match.
 */
function candidateSubdirs(slug: string): string[] {
  return [slug, `skills/${slug}`, `.claude/skills/${slug}`, `.agents/skills/${slug}`];
}

/**
 * Walk a directory tree and reject if it contains any symlinks. A
 * malicious skill repo could ship `secret -> /etc/passwd`; after
 * materialization the symlink would point outside the cache and a
 * downstream model `Read` of the SKILL would dereference into a
 * privileged file.
 */
function assertNoSymlinks(root: string): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new MaterializationError(
          `unsafe symlink detected at ${full}; refusing to materialize a skill containing symlinks`
        );
      }
      if (entry.isDirectory()) stack.push(full);
    }
  }
}

async function materializeGithub(
  parsed: ParsedSkillId,
  target: string,
  opts: MaterializeOptions
): Promise<MaterializationResult> {
  const git = opts.git ?? defaultGit;
  await checkGitVersion(git);

  const configDir = getConfigDir(opts);
  const tmpRoot = join(configDir, 'cache', '.tmp');
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(`${tmpRoot}${pathSep}`);

  const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;

  try {
    // 1. Clone sparse + blobless for minimum bandwidth.
    await git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', url, tmp], {
      timeoutMs: 60_000,
    });

    // 2. Set sparse-checkout to all candidate subdirs — git will silently
    //    skip missing ones.
    const candidates = candidateSubdirs(parsed.slug);
    await git(['-C', tmp, 'sparse-checkout', 'init', '--cone'], { timeoutMs: 10_000 }).catch(
      () => undefined
    );
    await git(['-C', tmp, 'sparse-checkout', 'set', ...candidates], { timeoutMs: 10_000 });

    // 3. Resolve which candidate actually materialized.
    const { existsSync, statSync } = await import('node:fs');
    const picked = candidates.find((sub) => {
      const p = join(tmp, sub);
      return existsSync(p) && statSync(p).isDirectory();
    });
    if (!picked) {
      throw new MaterializationError(
        `no skill subdirectory found in ${parsed.owner}/${parsed.repo} for slug ${parsed.slug}; ` +
          `tried: ${candidates.join(', ')}`,
        parsed
      );
    }

    // 4. Capture sha for the manifest.
    const sha = (await git(['-C', tmp, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 })).trim();

    // 5. Reject symlinks anywhere in the materialized tree before swap.
    assertNoSymlinks(join(tmp, picked));

    // 6. Atomic swap: move picked subtree into `target`.
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    rmSync(target, { recursive: true, force: true });
    renameSync(join(tmp, picked), target);

    // Stamp a marker file (handy for manual debugging).
    writeFileSync(join(target, '.hotskills-source.json'), JSON.stringify({ sha, subdir: picked }), {
      mode: 0o600,
    });

    return { path: target, sha, reused: false };
  } finally {
    // Even on the happy path we must clean up the clone remnants that
    // weren't moved into target.
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Public entry point ───

/**
 * Materialize a skill to its deterministic cache path. Idempotent:
 * concurrent calls for the same skill_id serialize on the cache lock,
 * and the second caller sees the fully-materialized tree on lock release.
 */
export async function materializeSkill(
  parsed: ParsedSkillId,
  opts: MaterializeOptions = {}
): Promise<MaterializationResult> {
  assertSafeSkillId(parsed);
  const configDir = getConfigDir(opts);
  const target = cacheSkillPath(parsed, configDir);

  // Hold the lock for the whole operation; this prevents two concurrent
  // activations of the same skill from racing the atomic rename.
  const handle = await acquireLock(target, opts.lockTimeoutMs);
  try {
    switch (parsed.source) {
      case 'skills.sh':
        return await materializeSkillsSh(parsed, target, opts);
      case 'github':
        return await materializeGithub(parsed, target, opts);
      case 'git':
        throw new MaterializationError(
          `raw-git sources are not yet supported in v0 (use github:<owner>/<repo> instead)`,
          parsed
        );
      default:
        throw new MaterializationError(`unknown skill source: ${parsed.source}`, parsed);
    }
  } finally {
    releaseLock(handle);
  }
}
