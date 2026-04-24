/**
 * Activation engine — wraps materialize.ts with manifest + idempotency.
 *
 * Per ADR-003 §Materialization:
 *   - Cache path: ${HOTSKILLS_CONFIG_DIR}/cache/skills/<source>/<owner>/<repo>/<slug>/
 *   - Manifest fields: source, owner, repo, slug, version (sha or 'unknown'),
 *     content_sha256 (over SKILL.md + scripts/ + references/), audit_snapshot
 *     frozen at activation time, activated_at (ISO8601 UTC).
 *   - Re-activation with matching content_sha256 is a no-op (idempotent).
 *
 * Concurrency: materialize.ts holds the per-skill lock for the actual
 * blob/git writes. We re-acquire the same lock here for the manifest
 * read/sha-check/write cycle so a concurrent activator either sees the
 * fully-materialized + manifested state or waits.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep as pathSep } from 'node:path';
import { type SkillAuditData } from './audit.js';
import { acquireLock, cacheWrite, releaseLock } from './cache.js';
import {
  cacheSkillPath,
  defaultGit,
  materializeSkill as runMaterialize,
  type GitRunner,
  type MaterializeOptions,
  type ParsedSkillId,
} from './materialize.js';
import { tryBlobInstall } from './vendor/vercel-skills/blob.js';

// ─── Manifest types ───

export interface AuditSnapshot {
  audit: SkillAuditData | null;
  cached_at: string;
}

export interface ActivationManifest {
  source: string;
  owner: string;
  repo: string;
  slug: string;
  /** Source-reported version (git SHA, blob snapshot hash, or 'unknown'). */
  version: string;
  /** SHA-256 over the materialized tree (excluding the manifest itself). */
  content_sha256: string;
  audit_snapshot: AuditSnapshot;
  activated_at: string;
}

export interface ActivationOutcome {
  /** Canonical "<source>:<owner>/<repo>:<slug>" form. */
  skill_id: string;
  /** Absolute path to the materialized cache directory. */
  path: string;
  /** Manifest written to <path>/.hotskills-manifest.json. */
  manifest: ActivationManifest;
  /** True when an existing manifest matched and we skipped re-materialization. */
  reused: boolean;
}

export interface ActivateOptions {
  configDir?: string;
  git?: GitRunner;
  blobInstall?: typeof tryBlobInstall;
  /**
   * Inject a materialization implementation (for tests). The wrapper must
   * write the SKILL.md tree into `target` and return its sha + reused flag.
   */
  materializeImpl?: (
    parsed: ParsedSkillId,
    opts: MaterializeOptions
  ) => Promise<{ path: string; sha?: string; reused: boolean }>;
  lockTimeoutMs?: number;
}

const MANIFEST_NAME = '.hotskills-manifest.json';

// ─── Errors ───

export class ActivationError extends Error {
  constructor(message: string, public readonly parsed?: ParsedSkillId) {
    super(message);
    this.name = 'ActivationError';
  }
}

// ─── Helpers ───

function getConfigDir(opts?: ActivateOptions): string {
  const dir = opts?.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') {
    throw new ActivationError('HOTSKILLS_CONFIG_DIR is not set');
  }
  return dir;
}

function listFilesSorted(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      // Skip the manifest itself and any in-flight .tmp files.
      const rel = relative(root, full);
      if (rel === MANIFEST_NAME) continue;
      if (rel.endsWith('.tmp')) continue;
      if (e.isSymbolicLink()) continue; // materialize already rejects, defense in depth
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  // Sort by POSIX-normalized relative path so the digest is deterministic
  // regardless of filesystem-readdir order or platform separator.
  return out.sort((a, b) => {
    const ra = relative(root, a).split(pathSep).join('/');
    const rb = relative(root, b).split(pathSep).join('/');
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/**
 * Compute a deterministic SHA-256 over the materialized tree.
 * Format: for each file (sorted by POSIX relative path):
 *   update(relPath + '\0')
 *   update(sha256_hex_of_file_contents)
 *   update('\0')
 * Final hex digest is the content_sha256.
 */
export function computeContentSha(root: string): string {
  const outer = createHash('sha256');
  for (const path of listFilesSorted(root)) {
    const rel = relative(root, path).split(pathSep).join('/');
    const inner = createHash('sha256');
    inner.update(readFileSync(path));
    outer.update(rel);
    outer.update('\0');
    outer.update(inner.digest('hex'));
    outer.update('\0');
  }
  return outer.digest('hex');
}

async function readExistingManifest(target: string): Promise<ActivationManifest | null> {
  const path = join(target, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).content_sha256 === 'string'
    ) {
      return parsed as ActivationManifest;
    }
    return null;
  } catch {
    return null;
  }
}

function assertSkillMdExists(target: string, parsed: ParsedSkillId): void {
  const md = join(target, 'SKILL.md');
  if (!existsSync(md) || !statSync(md).isFile()) {
    throw new ActivationError(
      `materialization completed but SKILL.md is missing at ${md}`,
      parsed
    );
  }
}

// ─── Public API ───

/**
 * Activate a skill: materialize the SKILL.md tree to its deterministic cache
 * path, freeze an audit snapshot into a manifest, and return the result.
 *
 * Idempotent: a second call with the same materialized content (and an
 * existing valid manifest with a matching content_sha256) returns the
 * existing manifest with `reused: true` and skips re-materialization.
 *
 * Concurrency model (closes hotskills-w9g): the entire activation flow
 * (fast-path manifest check → materialize → manifest write) runs under
 * a per-skill `<target>.activate.lock` file (a SEPARATE lock from the
 * `<target>.lock` that materialize.ts uses internally for its blob/git
 * IO). This means a concurrent loser blocks on the outer activate-lock,
 * observes the winner's manifest in the fast-path read, and short-
 * circuits with `reused: true` — no second materialize call.
 *
 * Two-lock design rationale: the existing `<target>.lock` is acquired
 * inside materialize for the duration of blob/git writes. We cannot
 * reuse it (the O_EXCL primitive is non-reentrant — taking it twice in
 * the same process would deadlock). The `<target>.activate.lock` lives
 * one level out and is held across the whole activation.
 */
export async function activateSkill(
  parsed: ParsedSkillId,
  auditSnapshot: AuditSnapshot,
  opts: ActivateOptions = {}
): Promise<ActivationOutcome> {
  const configDir = getConfigDir(opts);
  const target = cacheSkillPath(parsed, configDir);
  const skillId = `${parsed.source}:${parsed.owner}/${parsed.repo}:${parsed.slug}`;

  // Outer activation lock — distinct file from materialize's <target>.lock.
  const activateLockDir = `${target}.activate`;
  const handle = await acquireLock(activateLockDir, opts.lockTimeoutMs);
  try {
    // ─── 1. Fast-path: existing manifest with matching content sha ───
    const existing = await readExistingManifest(target);
    if (existing) {
      let computed: string;
      try {
        computed = computeContentSha(target);
      } catch {
        computed = '';
      }
      if (computed && computed === existing.content_sha256) {
        // Per ADR-003 the audit snapshot is frozen at activation time.
        // Reuse semantics return the original.
        return { skill_id: skillId, path: target, manifest: existing, reused: true };
      }
    }

    // ─── 2. Materialize (acquires its own inner <target>.lock internally) ───
    const materializeImpl = opts.materializeImpl ?? runMaterialize;
    const matOpts: MaterializeOptions = {};
    if (opts.configDir !== undefined) matOpts.configDir = opts.configDir;
    if (opts.git !== undefined) matOpts.git = opts.git;
    if (opts.blobInstall !== undefined) matOpts.blobInstall = opts.blobInstall;
    if (opts.lockTimeoutMs !== undefined) matOpts.lockTimeoutMs = opts.lockTimeoutMs;
    const result = await materializeImpl(parsed, matOpts);
    assertSkillMdExists(result.path, parsed);

    // ─── 3. Write manifest (still under outer activate-lock) ───
    const contentSha = computeContentSha(result.path);
    const manifest: ActivationManifest = {
      source: parsed.source,
      owner: parsed.owner,
      repo: parsed.repo,
      slug: parsed.slug,
      version: result.sha ?? 'unknown',
      content_sha256: contentSha,
      audit_snapshot: auditSnapshot,
      activated_at: new Date().toISOString(),
    };
    cacheWrite(join(result.path, MANIFEST_NAME), manifest);

    return { skill_id: skillId, path: target, manifest, reused: false };
  } finally {
    releaseLock(handle);
  }
}

// Re-export materialize's defaultGit so tools can inject test runners
// without importing materialize directly.
export { defaultGit };
