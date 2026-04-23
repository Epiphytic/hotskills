# ADR-002: Skill discovery via find-skills + vercel-labs/skills consumption strategy

**Date:** 2026-04-23
**Status:** Accepted
**Decision makers:** liam.helmer@gmail.com (user), local subagent, star-chamber

## Context

The user observed: *"much of the logic exists already here: vercel-labs/skills/skills/find-skills/SKILL.md. We're just adding pre-configuration to this."* That SKILL.md encodes a complete 6-step discovery+ranking+verification workflow (intent → leaderboard → `npx skills find` → verify install/source/stars → present → install). Reimplementing it would be redundant and divergent.

Separately, hotskills needs structured server-side access to several primitives in `vercel-labs/skills`: the audit API client (`src/telemetry.ts:97 fetchAuditData`), source-URL parsing, the skills.sh download/blob API client, and shared types. The package ships **no `main` or `exports` field** in `package.json` — it is a CLI binary only. Direct `import` from the npm package does not work.

This ADR fixes how hotskills consumes find-skills, vercel-labs/skills' source modules, and skills.sh APIs, including caching.

## Decision

1. Auto-activate `skills.sh:vercel-labs/skills:find-skills` to **global config** during `/hotskills-setup`. Hotskills does not implement skill ranking; the find-skills SKILL.md owns it.
2. **Vendor** the small set of needed `vercel-labs/skills` source modules under `vendor/vercel-skills/` with full MIT attribution. In parallel, file an upstream PR adding a `package.json` `exports` field; v1 swaps to npm dep when merged.
3. Shell out to `npx skills` for **CLI actions** (`add`, `list`, `update`, `find`) behind a cache wrapper. Reimplementing install/symlink/lock logic is 80% of the package — not worth it.
4. Cache aggressively with TTLs: search 1h, audits 24h, materialized SKILL.md trees 7d (manifest checksum invalidates).

## Requirements (RFC 2119)

### Find-skills auto-activation

- `/hotskills-setup` MUST auto-activate `skills.sh:vercel-labs/skills:find-skills` to the global config (`~/.config/hotskills/config.json`).
- The activated-skills system reminder (per ADR-005) MUST include find-skills in its enumeration when find-skills is in the merged allow-list.
- Per-project config MAY explicitly deactivate find-skills; if deactivated, the dispatcher MUST refuse `hotskills.invoke` calls targeting it for that project.

### Vendoring

- Vendored modules MUST live under `vendor/vercel-skills/` and MUST include a copy of the upstream LICENSE file at `vendor/vercel-skills/LICENSE`.
- Each vendored file MUST carry an attribution header: source repo URL, source commit SHA, MIT license notice, and a "synced from <SHA>" marker.
- Vendored modules MUST be: `telemetry.ts` (audit subset only; strip telemetry tracking), `types.ts`, `source-parser.ts`, `blob.ts`, `find.ts`. No additional modules without an updated ADR.
- `vendor/vercel-skills/ATTRIBUTION.md` MUST list every vendored file with upstream path, sync SHA, and date.
- Vendored modules MUST NOT be edited beyond removing telemetry calls; modifications require a delta-patch file in `vendor/vercel-skills/patches/` and a comment in the modified file pointing to it.
- A CI check MUST verify vendored sync state weekly: re-fetch upstream files, diff against vendored copies (modulo patches), open issue if drift exceeds threshold.
- An upstream PR adding `exports` for the vendored modules MUST be filed and tracked.

### Shell-out + cache wrapper

- The MCP server MUST shell out to `npx skills` for `find` and `add` operations, with cache interposition.
- The shell-out MUST set `--target <hotskills-cache-path>` for `add` operations and MUST NOT call `add -g` (which would pollute the user's global skill installs).
- The wrapper script MUST be `scripts/npx-skills-wrapper.sh` and MUST hash query+args to derive cache key.
- If `npx` or `skills` is missing, `hotskills-setup` MUST surface a warning; fallback discovery via vendored `blob.ts` + direct skills.sh API MUST be available but limited to read-only operations.

### Cache TTLs (defaults; per-project overridable)

- Search results: 3600s (1h) under `~/.config/hotskills/cache/search/<query-hash>.json`
- Audit responses: 86400s (24h) under `~/.config/hotskills/cache/audit/<owner-repo>.json`
- Materialized SKILL.md trees: 604800s (7d) under `~/.config/hotskills/cache/skills/<source>/<owner>/<repo>/<slug>/`; manifest-checksum mismatch MUST invalidate
- Top/leaderboard: 1800s (30m)

### Cache integrity

- All cache writes MUST use atomic file replacement: write to `<path>.tmp`, fsync, rename to `<path>`.
- All cache reads MUST validate JSON parseability and schema; on failure, treat as cache miss and overwrite.
- Materialization writes MUST acquire a `<dir>.lock` file (open-with-O_EXCL) to prevent concurrent activate races. Lock acquisition timeout: 30s; on timeout, return error.
- Cache directory permissions MUST be 0700; cache files MUST be 0600.

### User-configured sources

- Per-project `sources` config entries MUST list `{type: "github"|"git", owner, repo, branch?, preferred?}`.
- Source enumeration MUST use `git ls-remote` (cached 1h) and MUST NOT clone full history.
- SKILL.md discovery within a source MUST scan: root, `skills/`, `.claude/skills/`, `.agents/skills/`. No deeper recursion.
- Sources marked `preferred: true` MUST win on display ordering and MUST bypass the install-count threshold (per ADR-004), but MUST NOT bypass the audit gate.

## Rationale

- **Don't reimplement find-skills.** The user's design intent was explicit. find-skills is in the `vercel-labs/skills` repo, MIT-licensed, and stays current with the ecosystem. Shipping it as the default-activated discovery skill keeps hotskills aligned with upstream.
- **Vendor + upstream PR is the pragmatic path.** Direct npm import doesn't work today; waiting for upstream `exports` blocks v0; reimplementing the audit API client divorces us from upstream schema evolution. Vendoring with attribution gets v0 shipped while the PR lands.
- **Shell-out for CLI actions** preserves vercel-labs/skills' install logic (lock files, symlinks, agent-specific layout) without our reimplementation. Cache wrapper kills the per-call latency tax.
- **Aggressive TTLs** match how skills evolve (slowly): a 7-day materialized cache + manifest checksum invalidation gives both freshness and speed.

## Alternatives Considered

### Reimplement everything in-process (no shell-out, no vendoring)
- Pros: zero subprocess cost; full control.
- Cons: massive scope creep; reimplements 80% of vercel-labs/skills; risks divergence.
- Why rejected: violates the user's "we're just adding pre-configuration" framing.

### Shell out via `npx skills` for everything including audit fetches
- Pros: maximum upstream alignment.
- Cons: `npx` cold start = hundreds of ms per call; brittle parsing of CLI stdout.
- Why rejected: vendoring `fetchAuditData` is 30 lines and gives us in-process speed for the hottest path.

### `npm install github:vercel-labs/skills` and import from `dist/`
- Pros: no vendoring; tracks main branch.
- Cons: `dist/` is not a stable interface; breakage on every upstream release.
- Why rejected: more fragile than vendoring with explicit sync SHAs.

### Drop find-skills auto-activation; require user to discover it manually
- Pros: less magic; user opt-in.
- Cons: defeats the "first-use just works" goal; violates the user's design intent.
- Why rejected: contradicts the explicit user steer.

## Assumed Versions (SHOULD)

- `vercel-labs/skills`: 1.5.1 (vendor sync SHA pinned in `vendor/vercel-skills/ATTRIBUTION.md`)
- skills.sh API (mastra-ai/skills-api): current main (no semver published)
- add-skill.vercel.sh/audit: schema as observed 2026-04-23 (see ADR-004)

## Diagram

<!-- brains:diagram populates this section if applicable. -->

## Consequences

- A vendored modules sync workflow (CI + upstream-PR tracking) becomes part of operations.
- License attribution surface (LICENSE file + per-file headers + ATTRIBUTION.md) is required.
- A cache lock primitive (`scripts/lock.sh` or in-process `proper-lockfile`) becomes a shared dependency.
- The dispatcher contract in ADR-003 can rely on the materialized-cache layout.

### Phase 0 verification items

- Confirm `npx skills add --target <dir>` actually accepts a custom target (read CLI source if not documented).
- Confirm `npx skills add --target` does NOT mutate `~/.claude/skills/` or other global locations.
- Confirm `https://skills.sh/api/skills?query=...` is the reachable public hostname (research flagged this as unverified).
- Smoke-test concurrent activations of the same skill from two sessions; confirm lock prevents corruption.

## Council Input

Star-chamber flagged "ongoing upstream drift and compliance burden" as a vendoring concern; addressed via per-file sync-SHA headers, weekly CI drift check, and required LICENSE+ATTRIBUTION files. Star-chamber also flagged cache as "race-prone and stale-prone"; addressed via mandatory atomic writes, lock files, and schema validation on read.
