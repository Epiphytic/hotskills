# Vendored modules — vercel-labs/skills

Source repository: https://github.com/vercel-labs/skills
License: MIT (see `./LICENSE`)
Sync tag: `v1.5.1`
Sync commit SHA: `bc21a37a12b90fcb5aec051c91baf5b227b704b1`
Sync date: 2026-04-23

## Vendoring rationale

`vercel-labs/skills@1.5.1` ships no `main` or `exports` field in its
`package.json`; it is distributed as a CLI binary only. Direct `import` from
the npm package does not resolve. Hotskills therefore vendors a small subset
of source modules under MIT attribution and tracks an upstream PR that adds
the missing `exports` field (see `docs/plans/vendor-upstream-pr-tracking.md`).

ADR reference: `docs/adr/2026-04-23-002-discovery-and-vercel-skills-consumption.md`
(see also Amendment 1 for the materialization-router consequence).

## Vendored files

| Vendored path                              | Upstream path           | Sync SHA                                   | Date       | Modified? |
| ------------------------------------------ | ----------------------- | ------------------------------------------ | ---------- | --------- |
| `vendor/vercel-skills/telemetry.ts`        | `src/telemetry.ts`      | bc21a37a12b90fcb5aec051c91baf5b227b704b1   | 2026-04-23 | Yes — see `patches/telemetry-strip-tracking.patch` |
| `vendor/vercel-skills/types.ts`            | `src/types.ts`          | bc21a37a12b90fcb5aec051c91baf5b227b704b1   | 2026-04-23 | No        |
| `vendor/vercel-skills/source-parser.ts`    | `src/source-parser.ts`  | bc21a37a12b90fcb5aec051c91baf5b227b704b1   | 2026-04-23 | No        |
| `vendor/vercel-skills/blob.ts`             | `src/blob.ts`           | bc21a37a12b90fcb5aec051c91baf5b227b704b1   | 2026-04-23 | Yes — see `patches/blob-inline-frontmatter.patch` |
| `vendor/vercel-skills/find.ts`             | `src/find.ts`           | bc21a37a12b90fcb5aec051c91baf5b227b704b1   | 2026-04-23 | Yes — see `patches/find-extract-search-api.patch` |

## Modifications log

### `telemetry.ts` — strip telemetry tracking

Per ADR-002 §Vendoring: "Vendored modules MUST be: `telemetry.ts` (audit
subset only; strip telemetry tracking) ...". Only the `fetchAuditData`
function and its associated audit types (`PartnerAudit`, `SkillAuditData`,
`AuditResponse`) are retained. The `track()` function, `setVersion`,
`isCI`, `isEnabled`, `cliVersion`, telemetry interfaces, `TELEMETRY_URL`,
and all telemetry data type aliases are removed because they are unused
in the audit-only path and would otherwise add a tracking surface to the
hotskills binary.

See `patches/telemetry-strip-tracking.patch`.

### `blob.ts` — inline frontmatter parser

`blob.ts` upstream imports `parseFrontmatter` from `./frontmatter.ts`. We
do NOT vendor `frontmatter.ts` because doing so would require an ADR
amendment (ADR-002 explicitly enumerates the vendored module list).
Instead, the tiny `parseFrontmatter` function from upstream
`src/frontmatter.ts` is inlined at the top of `blob.ts` as a vendored
delta. It depends on the `yaml` npm package (added to `server/package.json`).

See `patches/blob-inline-frontmatter.patch`.

### `find.ts` — extract API search function

`find.ts` upstream is the interactive CLI `find` command — readline TTY
prompt, ANSI escape sequences, `process.stdin`, and a `runAdd` shell-out
on selection. Only the `searchSkillsAPI(query)` function and its
`SearchSkill` interface are needed by hotskills (`server/src/tools/search.ts`
calls into it directly). The interactive `runFind`, `runSearchPrompt`,
ANSI helpers, and `track()` calls are removed because the MCP server is
non-interactive by definition.

See `patches/find-extract-search-api.patch`.

## Upstream PR tracking

The upstream PR adding `exports` for these modules is tracked in
`docs/plans/vendor-upstream-pr-tracking.md`. When that PR merges and a
release ships, hotskills v1 should swap to the npm dependency and
delete `vendor/vercel-skills/`.

## Drift checking

A weekly CI workflow (`.github/workflows/vendor-drift.yml`, see beads
task `hotskills-35o`) re-fetches each vendored file at the pinned SHA
and diffs against the local copy (modulo attribution headers and
documented patches), opening a GitHub issue if drift is detected.
