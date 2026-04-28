/**
 * Structured JSON-line logger — single sink router for the three log files
 * specified by ADR-004 / ADR-005:
 *
 *   - ${HOTSKILLS_CONFIG_DIR}/logs/whitelist-activations.log
 *   - ${HOTSKILLS_CONFIG_DIR}/logs/audit-errors.log
 *   - ${HOTSKILLS_CONFIG_DIR}/logs/hook.log
 *
 * Why this exists (Plan-Phase 6 Task 6.1): before this module, audit.ts and
 * whitelist.ts each had their own append+escape logic. Consolidating keeps
 * the line shape, escaping rules, and best-effort failure semantics
 * identical across all three sinks.
 *
 * Append-atomicity:
 *   POSIX guarantees write(2) of length ≤ PIPE_BUF (≥ 512 bytes; Linux 4096)
 *   is atomic on a file opened with O_APPEND. Node's fs/promises.appendFile
 *   uses O_APPEND, so any line under 4096 bytes is safe against concurrent
 *   writers. We don't enforce that here — callers cap their entry payloads.
 *
 * Failure semantics:
 *   Logging is best-effort. A failed write must NEVER propagate to gate or
 *   tool callers. All errors are swallowed. The hook script (which can't
 *   import this module) follows the same rule independently.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogSink = 'whitelist' | 'audit' | 'hook';

export interface LogOptions {
  /** Override config dir (tests). Falls back to HOTSKILLS_CONFIG_DIR env. */
  configDir?: string;
}

const SINK_FILES: Record<LogSink, string> = {
  whitelist: 'whitelist-activations.log',
  audit: 'audit-errors.log',
  hook: 'hook.log',
};

function resolveConfigDir(opts?: LogOptions): string | null {
  const dir = opts?.configDir ?? process.env['HOTSKILLS_CONFIG_DIR'];
  if (!dir || dir.trim() === '') return null;
  return dir;
}

/** Absolute path of the on-disk log file for a given sink. */
export function logPath(sink: LogSink, opts?: LogOptions): string {
  const dir = resolveConfigDir(opts);
  if (!dir) {
    throw new Error('HOTSKILLS_CONFIG_DIR is not set');
  }
  return join(dir, 'logs', SINK_FILES[sink]);
}

/**
 * Whether DEBUG-level logs are emitted. Gated by HOTSKILLS_DEBUG=true env
 * var (per Plan-Phase 6 Task 6.1 acceptance). Other levels are always
 * emitted.
 */
function debugEnabled(): boolean {
  const v = process.env['HOTSKILLS_DEBUG'];
  return v === 'true' || v === '1';
}

/**
 * Append one JSON line to the named sink. Best-effort — any IO failure or
 * missing config dir is swallowed.
 *
 * Line shape: `{ts, level, event, ...fields}\n`. Fields are merged after
 * the fixed prefix; callers MUST NOT pass keys named `ts`, `level`, or
 * `event` in fields (later keys would shadow the prefix and break
 * downstream tooling that relies on the canonical positions).
 */
export async function log(
  sink: LogSink,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  opts?: LogOptions
): Promise<void> {
  if (level === 'debug' && !debugEnabled()) return;
  const dir = resolveConfigDir(opts);
  if (!dir) return; // best-effort: nothing to do
  const path = join(dir, 'logs', SINK_FILES[sink]);
  // JSON.stringify escapes \n, \\, and embedded quotes — preserves the
  // one-line-per-record invariant of these JSONL files.
  // Strip caller-supplied ts/level/event so they can't shadow the canonical
  // prefix. Callers shouldn't pass these, but defend.
  const safeFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k !== 'ts' && k !== 'level' && k !== 'event') safeFields[k] = v;
  }
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...safeFields,
  };
  let line: string;
  try {
    line = JSON.stringify(record) + '\n';
  } catch {
    // Circular-ref or BigInt in fields — drop the record rather than throw.
    return;
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, line, { mode: 0o600 });
  } catch {
    // swallowed — logging never fails callers
  }
}
