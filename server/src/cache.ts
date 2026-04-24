/**
 * On-disk cache primitive for hotskills.
 *
 * Per ADR-002 §Cache integrity:
 *   - Atomic writes via .tmp + fsync + rename
 *   - O_EXCL lock files with 30s timeout
 *   - 0700 dirs / 0600 files
 *   - JSON parse + optional schema validation on read; null on miss/stale/corrupt
 *
 * Stale-lock cleanup (e.g., reaping locks held by crashed processes) is
 * intentionally OUT OF SCOPE for v0 — a crashed materialization will leave a
 * .lock file until the 30s acquire-timeout elapses, after which a fresh
 * acquirer will time out and surface a clear error to the caller.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ─── Errors ───

export class LockTimeoutError extends Error {
  constructor(public readonly lockPath: string, public readonly timeoutMs: number) {
    super(`Failed to acquire lock at ${lockPath} within ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

// ─── Types ───

export interface LockHandle {
  readonly path: string;
  readonly acquiredAt: number;
}

export type Validator<T> = (data: unknown) => T;

// ─── Constants ───

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 50;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ─── Helpers ───

function ensureDir(path: string): void {
  // recursive: true is idempotent and won't throw if path already exists.
  // mode applies only to newly-created leaf segments — pre-existing parents
  // keep their permissions. Callers control the leaf which is the cache root.
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Cache read ───

/**
 * Read and parse a JSON cache file with TTL + optional schema validation.
 *
 * Returns null on:
 *   - file missing
 *   - mtime older than ttlSeconds
 *   - JSON parse error
 *   - validator throwing
 *
 * Never throws on cache miss/corruption — corrupted entries are treated as
 * miss so the caller can re-fetch and overwrite.
 */
export async function cacheRead<T = unknown>(
  path: string,
  ttlSeconds: number,
  validator?: Validator<T>
): Promise<T | null> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null; // missing
  }

  const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
  if (ageSeconds > ttlSeconds) return null; // stale

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupted JSON
  }

  if (!validator) return parsed as T;

  try {
    return validator(parsed);
  } catch {
    return null; // schema mismatch
  }
}

/**
 * Return the age in seconds of a cache file, or null if missing.
 * Useful for surfacing `cache_age_seconds` in tool responses.
 */
export function cacheAgeSeconds(path: string): number | null {
  try {
    const stat = statSync(path);
    return (Date.now() - stat.mtimeMs) / 1000;
  } catch {
    return null;
  }
}

// ─── Cache write ───

/**
 * Atomically write JSON to `path` via the .tmp + fsync + rename idiom.
 *
 * Crash-safety: if the process crashes between writeFile and rename, the
 * partial write lives at `<path>.tmp` and the original `<path>` is
 * untouched. POSIX rename is atomic within a filesystem.
 *
 * The parent directory is created with 0700 if absent. The output file is
 * written with 0600.
 */
export function cacheWrite(path: string, data: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(data);

  // writeFileSync with mode + flag 'wx' would fail on stale tmp files
  // from prior crashes; use plain write and rely on the unique tmp name
  // (pid + timestamp) to avoid collisions in normal operation.
  writeFileSync(tmp, json, { mode: FILE_MODE });

  // fsync the data file before rename so the rename + post-crash recovery
  // observes the bytes we intended (rename of an unsynced file can yield
  // an empty file post-crash on some filesystems).
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmp, path);
}

// ─── Locking ───

/**
 * Acquire an exclusive lock on `dir`, identified by a sibling `<dir>.lock`
 * file opened with O_EXCL. Polls every 50ms up to `timeoutMs`.
 *
 * The lock file body contains `pid:timestamp` for diagnostic inspection
 * (`cat <dir>.lock` while debugging). It carries no recovery semantics —
 * stale locks from crashed processes will block acquire until the timeout.
 */
export async function acquireLock(
  dir: string,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS
): Promise<LockHandle> {
  ensureDir(dirname(dir));
  const lockPath = `${dir}.lock`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // 'wx' = O_WRONLY | O_CREAT | O_EXCL : fails with EEXIST if file exists.
      const fd = openSync(lockPath, 'wx', FILE_MODE);
      try {
        const body = `${process.pid}:${Date.now()}`;
        writeFileSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return { path: lockPath, acquiredAt: Date.now() };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock held — wait and retry.
      await sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }

  throw new LockTimeoutError(lockPath, timeoutMs);
}

/**
 * Release a previously-acquired lock. Idempotent: missing lock files
 * are silently ignored.
 */
export function releaseLock(handle: LockHandle): void {
  try {
    rmSync(handle.path, { force: true });
  } catch {
    // Idempotent release; never throw.
  }
}

// ─── Convenience helpers ───

/**
 * Run `fn` while holding the lock on `dir`. Releases the lock on success
 * or failure.
 */
export async function withLock<T>(
  dir: string,
  fn: () => Promise<T>,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS
): Promise<T> {
  const handle = await acquireLock(dir, timeoutMs);
  try {
    return await fn();
  } finally {
    releaseLock(handle);
  }
}

/**
 * Build a cache file path under `${HOTSKILLS_CONFIG_DIR}/cache/<bucket>/<key>.json`.
 * Pure path computation; does not touch the filesystem.
 */
export function cachePath(configDir: string, bucket: string, key: string): string {
  return join(configDir, 'cache', bucket, `${key}.json`);
}

// Re-exported for tests that want to inspect the constants without touching internals.
export const _internals = {
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_RETRY_INTERVAL_MS,
  DIR_MODE,
  FILE_MODE,
  ensureDir,
  pathExists: existsSync,
};
