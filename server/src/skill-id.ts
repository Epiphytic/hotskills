/**
 * Skill ID parser + validator.
 *
 * Per ADR-001 / ADR-003 §Skill ID format:
 *   "<source>:<owner>/<repo>:<slug>"
 *   source ∈ { skills.sh, github, git }
 *   owner, repo, slug each match [A-Za-z0-9._-]+ (matches the SAFE_NAME
 *   regex in materialize.ts; keep these in sync).
 *
 * Used by activate/invoke/deactivate/audit tools, by the search result
 * formatter, and by migrate/list logic that needs to validate persisted IDs.
 */

export type SkillSource = 'skills.sh' | 'github' | 'git';

export interface ParsedSkillId {
  readonly source: SkillSource;
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
}

const ALLOWED_SOURCES: ReadonlySet<string> = new Set(['skills.sh', 'github', 'git']);
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export class SkillIdError extends Error {
  constructor(public readonly raw: string, public readonly reason: string) {
    super(
      `invalid skill_id ${JSON.stringify(raw)}: ${reason}. ` +
        `expected format: "<source>:<owner>/<repo>:<slug>" with source in {skills.sh, github, git}`
    );
    this.name = 'SkillIdError';
  }
}

/**
 * Parse a fully-qualified skill ID. Throws SkillIdError on malformed input.
 *
 * The parse is intentionally strict: trailing whitespace, empty segments,
 * extra colons after the slug, and any character outside [A-Za-z0-9._-]
 * are all rejected.
 */
export function parseSkillId(raw: string): ParsedSkillId {
  if (typeof raw !== 'string') {
    throw new SkillIdError(String(raw), 'not a string');
  }
  if (raw.trim() !== raw) {
    throw new SkillIdError(raw, 'leading or trailing whitespace');
  }
  if (raw === '') {
    throw new SkillIdError(raw, 'empty');
  }

  // Split into <source> : <rest> on the FIRST colon; the source has no '/'
  // or ':', so first-colon split is unambiguous.
  const firstColon = raw.indexOf(':');
  if (firstColon < 0) throw new SkillIdError(raw, 'missing source prefix');
  const source = raw.slice(0, firstColon);
  const rest1 = raw.slice(firstColon + 1);

  if (!ALLOWED_SOURCES.has(source)) {
    throw new SkillIdError(raw, `unknown source ${JSON.stringify(source)}`);
  }

  // Split <owner>/<repo>:<slug> — first '/' separates owner from rest;
  // first ':' in the remainder separates repo from slug.
  const firstSlash = rest1.indexOf('/');
  if (firstSlash < 0) throw new SkillIdError(raw, "missing '/' between owner and repo");
  const owner = rest1.slice(0, firstSlash);
  const rest2 = rest1.slice(firstSlash + 1);

  const secondColon = rest2.indexOf(':');
  if (secondColon < 0) throw new SkillIdError(raw, "missing ':' between repo and slug");
  const repo = rest2.slice(0, secondColon);
  const slug = rest2.slice(secondColon + 1);

  // Reject extra ':' in slug to keep the format unambiguous and to prevent
  // a malicious skill from carrying a ':' in its slug that would break
  // round-trip serialization in caller code.
  if (slug.includes(':')) {
    throw new SkillIdError(raw, "extra ':' after slug");
  }
  if (slug.includes('/')) {
    throw new SkillIdError(raw, "'/' is not allowed in slug for v0");
  }

  for (const [field, value] of [
    ['owner', owner],
    ['repo', repo],
    ['slug', slug],
  ] as const) {
    if (value === '') throw new SkillIdError(raw, `empty ${field}`);
    if (!SAFE_NAME.test(value)) {
      throw new SkillIdError(raw, `unsafe character in ${field}`);
    }
  }

  return { source: source as SkillSource, owner, repo, slug };
}

/**
 * Round-trip helper: rebuild the canonical string form. Useful for
 * deduplication keys and log lines.
 */
export function formatSkillId(parsed: ParsedSkillId): string {
  return `${parsed.source}:${parsed.owner}/${parsed.repo}:${parsed.slug}`;
}
