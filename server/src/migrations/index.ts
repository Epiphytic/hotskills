/**
 * Forward-only schema migration framework for hotskills configs.
 *
 * Per ADR-003 §State schema:
 *   - The config MUST include a `version` field (currently 1).
 *   - The server MUST refuse configs with `version` greater than supported.
 *   - Migrations between schema versions MUST be implemented as forward-only
 *     transformations, applied automatically on read.
 *
 * v0 ships no migrations; this module is the seam future schema bumps wire
 * into. Adding a migration:
 *
 *     registerMigration({
 *       from: 1,
 *       to: 2,
 *       apply: (raw) => ({ ...raw, version: 2, newField: defaultForNewField }),
 *     });
 *
 * The runner walks registered migrations in `from` order until reaching the
 * target version. Missing-step gaps (e.g., registered 1→2 and 3→4 but not
 * 2→3 when going from 1 to 4) throw at registration time? No — they throw at
 * `runMigrations` time so registration ordering is flexible.
 */

export interface Migration {
  /** Version this migration upgrades FROM. */
  readonly from: number;
  /** Version this migration upgrades TO. Must equal `from + 1`. */
  readonly to: number;
  /** Pure function: transform `raw` to the next-version shape. */
  readonly apply: (raw: unknown) => unknown;
}

export interface MigrationResult {
  /** The post-migration config object. */
  readonly migrated: unknown;
  /** Sequence of `to` versions that were applied (empty when at target). */
  readonly ranMigrations: number[];
}

export class UnsupportedVersionError extends Error {
  constructor(
    public readonly found: number,
    public readonly target: number,
    public readonly remediation = `upgrade hotskills to a version that supports config v${found}`
  ) {
    super(
      `config version ${found} is newer than the supported version ${target}; ${remediation}`
    );
    this.name = 'UnsupportedVersionError';
  }
}

export class MigrationGapError extends Error {
  constructor(public readonly missingFrom: number, public readonly missingTo: number) {
    super(
      `no registered migration from v${missingFrom} to v${missingTo}; the migration registry is missing a step`
    );
    this.name = 'MigrationGapError';
  }
}

const registry: Migration[] = [];

/**
 * Register a migration. Order of registration is irrelevant — `runMigrations`
 * walks by `from` ascending. Duplicate `from` values are rejected.
 */
export function registerMigration(m: Migration): void {
  if (m.to !== m.from + 1) {
    throw new Error(
      `migrations must increment by 1 (got from=${m.from} to=${m.to}); split multi-version jumps into single-step migrations`
    );
  }
  if (registry.some((existing) => existing.from === m.from)) {
    throw new Error(`migration from v${m.from} already registered`);
  }
  registry.push(m);
}

/**
 * Test-only: clear the migration registry. Production code never calls this.
 */
export function _resetRegistry(): void {
  registry.length = 0;
}

/**
 * Read the `version` field defensively. Missing or non-integer → returns 1
 * (assume base v1 shape). This is the conservative default for v0 since the
 * shipped schema version is 1.
 */
function readVersion(raw: unknown): number {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const v = (raw as Record<string, unknown>)['version'];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  }
  return 1;
}

/**
 * Walk the registered migrations from `current` to `targetVersion`, applying
 * each in sequence. Returns the upgraded data + the list of `to` versions
 * applied. Idempotent at the target: returns immediately with no migrations.
 *
 * Throws:
 *   - UnsupportedVersionError when the input version exceeds the target.
 *   - MigrationGapError when a step is missing in the chain.
 */
export function runMigrations(raw: unknown, targetVersion: number): MigrationResult {
  const current = readVersion(raw);

  if (current > targetVersion) {
    throw new UnsupportedVersionError(current, targetVersion);
  }

  if (current === targetVersion) {
    return { migrated: raw, ranMigrations: [] };
  }

  let working = raw;
  const ran: number[] = [];
  let cursor = current;

  while (cursor < targetVersion) {
    const step = registry.find((m) => m.from === cursor);
    if (!step) {
      throw new MigrationGapError(cursor, cursor + 1);
    }
    working = step.apply(working);
    ran.push(step.to);
    cursor = step.to;
  }

  return { migrated: working, ranMigrations: ran };
}
