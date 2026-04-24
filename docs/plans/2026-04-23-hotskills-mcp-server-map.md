# Plan: Hotskills MCP server + Claude plugin

**Slug:** hotskills-mcp-server
**ADRs:** docs/adr/2026-04-23-001-plugin-and-mcp-server-foundation.md, docs/adr/2026-04-23-002-discovery-and-vercel-skills-consumption.md, docs/adr/2026-04-23-003-activation-dispatcher-and-project-state.md, docs/adr/2026-04-23-004-security-gating-policy-v0.md, docs/adr/2026-04-23-005-opportunistic-mode-and-compaction-survival.md
**Research:** docs/plans/2026-04-23-hotskills-mcp-server-research.md
**Mode:** --parallel
**Autopilot:** true
**Lean:** false
**Branch:** brains/hotskills-mcp-server

---

## Plan-Phase 1: Plugin scaffolding + MCP server skeleton with six stub tools

**Goal:** Establish the complete plugin directory layout, a compilable MCP server that starts under stdio, and six stub tools that return placeholder responses — giving the rest of the pipeline a stable skeleton to build on.

**Exit criteria:** Running `node server/dist/index.js` starts the MCP server under stdio transport; `tools/list` returns exactly six tool entries (`hotskills.search`, `hotskills.activate`, `hotskills.deactivate`, `hotskills.list`, `hotskills.invoke`, `hotskills.audit`); each tool handler returns a typed placeholder `{stub: true}` response; Claude Code can load the plugin and the MCP server appears in the tools list.

### Task 1.1: Plugin manifest and directory scaffold
- **Outcome:** `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `commands/` (empty stubs for `hotskills.md` and `hotskills-setup.md`), `hooks/` (empty), `skills/` (empty), `scripts/` (empty), `vendor/` (empty), `server/` (empty), `MANIFEST.md` root file all exist with correct minimal content. `.mcp.json` at plugin root declares the server with `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` env vars per ADR-001.
- **Touches:** `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `commands/hotskills.md`, `commands/hotskills-setup.md`, `MANIFEST.md`
- **Acceptance:** `cat .mcp.json` shows correct `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` references; `plugin.json` validates against the Claude Code plugin manifest schema fields (`name`, `version`, `description`, `author`, `license`, `repository`).
- **Depends on:** none

### Task 1.2: MCP server package setup (Node 22 + TypeScript 5 + SDK ^1.29.0)
- **Outcome:** `server/package.json` specifying Node 22 engine, `@modelcontextprotocol/sdk ^1.29.0`, TypeScript 5.x, and a `build` script that emits to `server/dist/`. `server/tsconfig.json` targeting ES2022 modules. `.nvmrc` or `.node-version` at repo root pinning Node 22.
- **Touches:** `server/package.json`, `server/tsconfig.json`, `.nvmrc`, `server/.gitignore` (excludes `dist/`, `node_modules/`)
- **Acceptance:** `npm install` inside `server/` succeeds; `npm run build` compiles without errors; `node server/dist/index.js` exits cleanly (no crash before stdio connect).
- **Depends on:** Task 1.1

### Task 1.3: MCP server entry point with StdioServerTransport and six stub tools
- **Outcome:** `server/src/index.ts` creates an `McpServer` instance, registers all six tools (`hotskills.search`, `hotskills.activate`, `hotskills.deactivate`, `hotskills.list`, `hotskills.invoke`, `hotskills.audit`) with correct Zod input schemas matching ADR-003 tool signatures, and each handler returns a typed stub response. Server connects via `StdioServerTransport`.
- **Touches:** `server/src/index.ts`, `server/src/tools/search.ts`, `server/src/tools/activate.ts`, `server/src/tools/deactivate.ts`, `server/src/tools/list.ts`, `server/src/tools/invoke.ts`, `server/src/tools/audit.ts`
- **Acceptance:** `tools/list` over the stdio protocol returns exactly six entries with correct names and input schemas; each handler returns without throwing; server does not crash on malformed input (Zod validation rejects with structured error).
- **Depends on:** Task 1.2

### Task 1.4: JSON Schema files for config.v1.json and state.v1.json
- **Outcome:** `server/src/schemas/config.v1.json` and `server/src/schemas/state.v1.json` drafted as JSON Schema draft 2020-12 documents, covering every field in the ADR-003 state schema and ADR-004 security config schema. A `server/src/schemas/index.ts` exports compiled validators (using `ajv` or equivalent).
- **Touches:** `server/src/schemas/config.v1.json`, `server/src/schemas/state.v1.json`, `server/src/schemas/index.ts`, `server/package.json` (add `ajv` dependency)
- **Acceptance:** Both schemas validate the canonical example documents shown in ADR-003 and ADR-004; invalid documents (wrong `version` field, unknown `risk_max` value) are rejected with descriptive errors.
- **Depends on:** Task 1.2

### Task 1.5: Minimal CI pipeline
- **Outcome:** `.github/workflows/ci.yml` (or equivalent CI config) runs on every push: `npm ci`, `npm run build`, `npm test` (empty test suite passes), and a `tsc --noEmit` type-check step. A placeholder test file ensures the test runner exits zero.
- **Touches:** `.github/workflows/ci.yml`, `server/src/__tests__/smoke.test.ts`
- **Acceptance:** CI passes on a clean push to the branch; build step fails loudly on a deliberate type error (verified manually before committing).
- **Depends on:** Task 1.3

### Task 1.6: Phase 0 API smoke-tests as CI gate (RISK-FIRST, promoted from Phase 5)
- **Outcome:** `scripts/phase0-api-verify.sh` and `.github/workflows/phase0-api-verify.yml` smoke-test the two external API endpoints that downstream phases depend on, BEFORE Phase 2 work begins: (a) `https://skills.sh/api/skills?query=test` returns 2xx with a result-shaped JSON body; (b) `https://add-skill.vercel.sh/audit?source=vercel-labs/agent-skills&skills=react-best-practices` returns 2xx with `AuditResponse`-shaped JSON matching vendored types in shape (validated via `ajv` against an inline JSON Schema derived from the vendored `PartnerAudit`/`AuditResponse` types). On failure: workflow fails, blocks merging, and writes findings to a CI artifact.
- **Touches:** `scripts/phase0-api-verify.sh`, `.github/workflows/phase0-api-verify.yml`
- **Acceptance:** CI job runs and passes against current live endpoints; deliberate URL break (test mode override) causes structured failure output naming which endpoint failed; runs on every PR.
- **Depends on:** Task 1.5
- **risk:high** — These are the two unverified network surfaces the rest of the build depends on. Failure here means schema drift or hostname change; Phase 2 work blocks until resolved.

### Task 1.7: Phase 0 npx-skills behavior smoke-test (RISK-FIRST, promoted from Phase 5)
- **Outcome:** `scripts/phase0-npx-verify.sh` invokes `npx skills add --target /tmp/hotskills-phase0-verify-<random>` against a tiny known-good skill (e.g., `vercel-labs/agent-skills@react-best-practices`) and asserts: (a) the `--target` flag is accepted (not rejected as unknown); (b) skill content lands under the target directory and NOT under `~/.claude/skills/`, `~/.cursor/skills/`, or any other agent-default directory; (c) target dir is cleaned up after the test. CI workflow gating Phase 2 PRs.
- **Touches:** `scripts/phase0-npx-verify.sh`, `.github/workflows/phase0-npx-verify.yml`
- **Acceptance:** Script passes against current `vercel-labs/skills` v1.5.1; if the `--target` flag is missing or behavior differs (e.g., still writes to `~/.claude/skills/`), script exits non-zero with a structured diagnostic; CI fails Phase 2 PRs until resolved.
- **Depends on:** Task 1.5
- **risk:high** — Resolves the load-bearing assumption from ADR-002 Phase 0 items. Tasks 2.4 (`npx-skills-wrapper.sh`) and 3.3 (materialization engine) depend on this behavior; their risk:high status is downgraded to standard once this passes.

---

## Plan-Phase 2: Vendoring + skill discovery + cache layer

**Goal:** Vendor the required `vercel-labs/skills` source modules with full attribution, implement the `npx-skills-wrapper.sh` cache-fronted shell-out, build the on-disk cache primitive with atomic writes and lock files, and wire `hotskills.search` to return real results.

**Exit criteria:** `hotskills.search({query: "react"})` returns ranked results from the skills.sh API (via `npx skills find` shell-out or vendored `blob.ts` direct call) with `cached`, `cache_age_seconds` fields populated; a second call within 1h returns `cached: true` without hitting the network; the vendored files are present under `vendor/vercel-skills/` with correct attribution headers and `ATTRIBUTION.md`.

### Task 2.1: Vendor vercel-labs/skills modules with attribution
- **Outcome:** `vendor/vercel-skills/` contains `telemetry.ts` (audit subset only; telemetry tracking calls stripped), `types.ts`, `source-parser.ts`, `blob.ts`, `find.ts`, `LICENSE` (upstream MIT copy), and `ATTRIBUTION.md` listing each file with upstream path, sync commit SHA (pinned to v1.5.1), and sync date. Each vendored file carries a header comment with source repo URL, commit SHA, MIT license notice, and a `synced from <SHA>` marker. A `vendor/vercel-skills/patches/` directory exists (empty) ready for future delta patches.
- **Touches:** `vendor/vercel-skills/` (all files above), `MANIFEST.md` (update module registry)
- **Acceptance:** All five `.ts` files compile as part of the `server/` build (via path alias or direct relative imports); `ATTRIBUTION.md` contains all required fields for each file; no telemetry call sites remain in `telemetry.ts` (grep check).
- **Depends on:** Task 1.2

### Task 2.2: Upstream PR tracking task
- **Outcome:** A GitHub issue or tracked note (in `docs/plans/vendor-upstream-pr-tracking.md`) records the intent to file an upstream PR to `vercel-labs/skills` adding a `package.json` `exports` field for the vendored modules. The file includes the target fields needed in `exports`, the relevant upstream file paths, and a checklist: [ ] PR filed, [ ] PR merged, [ ] v1 migration to npm dep complete.
- **Touches:** `docs/plans/vendor-upstream-pr-tracking.md`, `MANIFEST.md`
- **Acceptance:** File exists; checklist items are unambiguous; anyone reading it can file the PR without additional context.
- **Depends on:** Task 2.1

### Task 2.3: On-disk cache primitive with atomic writes and lock files
- **Outcome:** `server/src/cache.ts` implements: `cacheRead(path, ttlSeconds, schema)` (validates JSON on read; returns null on miss/stale/corrupt), `cacheWrite(path, data)` (atomic write via `.tmp` + fsync + rename), `acquireLock(dir, timeoutMs)` / `releaseLock(dir)` (using O_EXCL open; 30s timeout per ADR-002). Cache directory permissions enforced at 0700; file permissions at 0600. All functions are idempotent.
- **Touches:** `server/src/cache.ts`, `server/src/__tests__/cache.test.ts`
- **Acceptance:** Unit test: concurrent `acquireLock` calls from two async contexts — second waits or times out cleanly; corrupted cache file returns null (not a throw); atomic write survives a simulated mid-write interruption (file rename is atomic on POSIX).
- **Depends on:** Task 1.4

### Task 2.4: Materialization router (blob.ts + git sparse-checkout)
- **Outcome:** `server/src/materialize.ts` dispatches by source type (per ADR-002 Amendment 1). For `skills.sh:*` skill IDs, calls vendored `blob.ts` to fetch the SKILL.md tree from skills.sh and writes into `${HOTSKILLS_CONFIG_DIR}/cache/skills/skills.sh/<owner>/<repo>/<slug>/`. For `github:*` skill IDs, runs `git clone --depth 1 --filter=blob:none --sparse <url> <tmpdir>` then `git -C <tmpdir> sparse-checkout set <skill-subdir>` then atomically moves the materialized subtree into `${HOTSKILLS_CONFIG_DIR}/cache/skills/github/<owner>/<repo>/<slug>/`. Acquires per-skill lock via the cache primitive (Task 2.3). At server startup, when any GitHub-source skill is in the merged config, verifies `git --version >= 2.25` and surfaces a structured remediation message if missing.
- **Touches:** `server/src/materialize.ts`, `server/src/__tests__/materialize.test.ts`
- **Acceptance:** `blob.ts` path materializes a representative skills.sh skill (full SKILL.md tree present); sparse-checkout path materializes a representative GitHub skill subtree only (no full clone, working tree contains only the targeted subdirectory); concurrent activation of same skill from two contexts blocks correctly on the lock; absent `git` with a GitHub source configured emits the remediation message and refuses materialization (does not crash).
- **Depends on:** Task 1.7 (Phase 0 npx behavior verified — confirmed `--target` absent, drove this re-architecture), Task 2.3

### Task 2.5: Audit API client (vendored telemetry.ts wrapper)
- **Outcome:** `server/src/audit.ts` wraps the vendored `fetchAuditData` from `vendor/vercel-skills/telemetry.ts`. Enforces 3000ms timeout; treats timeout and non-2xx as no-data; validates response against vendored `AuditResponse` type; caches to `${HOTSKILLS_CONFIG_DIR}/cache/audit/<owner>-<repo>.json` for 24h using the cache primitive from Task 2.3; logs errors to `${HOTSKILLS_CONFIG_DIR}/logs/audit-errors.log`.
- **Touches:** `server/src/audit.ts`, `server/src/__tests__/audit.test.ts`
- **Acceptance:** Unit test with a mock HTTP server: valid response is cached; timeout returns null; malformed response returns null; cached response is returned on second call within 24h without hitting the mock server.
- **Depends on:** Task 1.6 (Phase 0 audit API verified), Task 2.1, Task 2.3

### Task 2.6: Wire hotskills.search to real results
- **Outcome:** `server/src/tools/search.ts` stub replaced with a real implementation. Per `config.discovery.find_strategy` (default `"auto"` — prefer `npx skills find` shell-out when present, fall back to direct skills.sh `/api/search?q=` via vendored client), fetches results, merges with audit data from `audit.ts` (cached), applies source filtering from `sources?` arg, and returns `{results, cached, cache_age_seconds}` per ADR-003 tool contract. Gate status (`allow`/`block`/`unknown`) is computed per-result using a read-only preview of the gate stack (no materialization).
- **Touches:** `server/src/tools/search.ts`, `server/src/__tests__/search.test.ts`
- **Acceptance:** Integration tests: `find_strategy: "api"` → `hotskills.search({query: "react"})` returns results via mocked skills.sh `/api/search?q=` with `skill_id`, `installs`, `description`, `audit`, `gate_status`; `find_strategy: "cli"` with mocked `npx skills find` returns equivalent shape; `cached: true` on repeat call; `sources` filter narrows results.
- **Depends on:** Task 1.6 (Phase 0 skills.sh API verified), Task 2.5

### Task 2.7: Weekly CI drift check for vendored modules
- **Outcome:** `.github/workflows/vendor-drift.yml` runs weekly (cron): re-fetches the five vendored source files from upstream `vercel-labs/skills` at the pinned SHA, diffs against `vendor/vercel-skills/` (excluding patch-comment lines), and opens a GitHub issue if drift exceeds zero lines (outside of the attribution header block).
- **Touches:** `.github/workflows/vendor-drift.yml`, `scripts/check-vendor-drift.sh`
- **Acceptance:** Manually triggering the workflow with a deliberately stale vendored file produces an issue; running it with identical files produces no issue; the script handles the case where upstream SHA no longer exists (network error → issue with "upstream SHA unreachable" body).
- **Depends on:** Task 2.1

---

## Plan-Phase 3: Activation lifecycle, dispatcher, and per-project state

**Goal:** Implement the full activation lifecycle (resolve → gate → materialize → manifest → allow-list), the `hotskills.invoke` dispatcher, per-project `config.json` + `state.json` state management with JSON Schema validation and migration scaffolding, and the `hotskills.list` and `hotskills.deactivate` tools.

**Exit criteria:** `hotskills.activate({skill_id: "skills.sh:vercel-labs/agent-skills:react-best-practices"})` completes the full flow (gate stub → materialize to `${HOTSKILLS_CONFIG_DIR}/cache/…` → write manifest → append to `.hotskills/config.json`) and returns `{skill_id, path, manifest}`; `hotskills.invoke({skill_id})` returns `{body, path, scripts, references, args_passed}` for an activated skill and returns an error for a non-activated skill; `hotskills.list()` reflects the allow-list; `hotskills.deactivate()` removes from allow-list without deleting cache.

### Task 3.1: Migration framework scaffolding (ordered before config IO so reads route through it)
- **Outcome:** `server/src/migrations/index.ts` implements a forward-only migration runner: reads `version` from config, applies any migration functions for versions between current and target in sequence, writes upgraded config atomically. No actual migration functions exist yet (v0 is the base); the framework is the deliverable. A `server/src/migrations/README.md` documents the convention for adding future migrations. Exports `runMigrations(rawConfig, targetVersion)` for `server/src/config.ts` (Task 3.2) to call on every read.
- **Touches:** `server/src/migrations/index.ts`, `server/src/migrations/README.md`, `server/src/__tests__/migrations.test.ts`
- **Acceptance:** Test: a config at `version: 0` (hypothetical) with a registered v0→v1 migration function is upgraded correctly; a config at `version: 99` (future) returns the structured "upgrade required" error without mutating the file; runner is idempotent when version already matches target.
- **Depends on:** Task 1.4

### Task 3.2: Config + state IO module with merge logic, schema validation, and migration hookup
- **Outcome:** `server/src/config.ts` implements: `readGlobalConfig()`, `readProjectConfig(projectCwd)`, `mergeConfigs(global, project)` (per ADR-003 merge rules), `writeProjectConfig(projectCwd, config)` (atomic write), `readProjectState(projectCwd)`, `writeProjectState(projectCwd, state)` (atomic write). All reads call `runMigrations` from Task 3.1 BEFORE schema validation, so configs persisted at older versions are auto-upgraded on next read. All reads validate against schemas from Task 1.4 AFTER migration; `version > 1` triggers the structured "upgrade required" error from the migration runner. `config.json` auto-creates `.hotskills/` on first write. `state.json` path is added to `.gitignore` if a `.gitignore` is present and the entry is absent.
- **Touches:** `server/src/config.ts`, `server/src/__tests__/config.test.ts`
- **Acceptance:** Unit test: merged config applies union for `activated` and `sources`, project-wins for `security.*` scalars, union for `security.whitelist.*`; schema-invalid config file returns a structured error (not a crash); `state.json` missing returns a zero-state default object; a hypothetical `version: 0` config with a registered v0→v1 migration is auto-upgraded on read and the upgraded form is written back atomically.
- **Depends on:** Task 1.4, Task 2.3, Task 3.1

### Task 3.3: Materialization engine
- **Outcome:** `server/src/activate.ts` implements `materializeSkill(skillId, parsedId, auditSnapshot)`: resolves materialized path (`${HOTSKILLS_CONFIG_DIR}/cache/skills/<source>/<owner>/<repo>/<slug>/`), acquires lock, calls the materialization router from Task 2.4 (`materialize.ts`) which dispatches to `blob.ts` for skills.sh sources or `git sparse-checkout` for github sources, verifies SKILL.md exists, writes `.hotskills-manifest.json` (per ADR-003 manifest fields: `source`, `owner`, `repo`, `slug`, `version`, `content_sha256`, `audit_snapshot`, `activated_at`), releases lock. On re-activation, checks `content_sha256`; skips re-materialization if matching (idempotent).
- **Touches:** `server/src/activate.ts`, `server/src/__tests__/activate.test.ts`
- **Acceptance:** Test with mocked materialization router: manifest is written with all required fields; second call with same content SHA returns without re-invoking the router; SHA mismatch triggers re-materialization; lock prevents concurrent materializations of the same skill.
- **Depends on:** Task 2.3, Task 2.4
- **Notes:** Original Phase 0 dependency on `npx skills add --target <dir>` is closed (assumption invalidated; ADR-002 Amendment 1 chose blob.ts + sparse-checkout). `${SKILL_PATH}` substitution sampling against 20 popular skills (ADR-003 Phase 0 item) still applies before marking done.

### Task 3.4: hotskills.activate tool implementation
- **Outcome:** `server/src/tools/activate.ts` stub replaced with full implementation: parse and validate `skill_id` format; run gate stack (Phase 4 will replace the stub gate with real logic; for now, a pass-through stub gate is acceptable); call `materializeSkill`; append to project allow-list via `config.ts`; return `{skill_id, path, manifest}`. Malformed skill IDs return a structured error. Skills not found in any source return an explicit error (no auto-source-add).
- **Touches:** `server/src/tools/activate.ts`, `server/src/__tests__/tools/activate.test.ts`
- **Acceptance:** End-to-end test (mocked materialization): activate a valid skill ID → manifest returned, allow-list updated; activate a malformed ID → error with message referencing expected format; activate twice → idempotent (no duplicate in allow-list).
- **Depends on:** Task 3.2, Task 3.3

### Task 3.5: hotskills.invoke dispatcher implementation
- **Outcome:** `server/src/tools/invoke.ts` stub replaced: verify `skill_id` in merged allow-list (error if not); read SKILL.md from materialized cache path; substitute `${SKILL_PATH}` with absolute cache directory path; enumerate `scripts/` (executable files) and `references/` (markdown files); return `{body, path, scripts, references, args_passed}`. No script execution occurs. Handles: skill not in allow-list, SKILL.md missing from cache (drop from allow-list, surface notice), manifest corrupted (surface error).
- **Touches:** `server/src/tools/invoke.ts`, `server/src/__tests__/tools/invoke.test.ts`
- **Acceptance:** Test: invoke activated skill → correct body with substitutions, scripts list, references list; invoke non-activated skill → structured error "skill not activated"; invoke skill whose cache is missing → structured error "cache missing, re-activate"; `${SKILL_PATH}` in SKILL.md body is replaced with absolute path in returned body.
- **Depends on:** Task 3.2, Task 3.3

### Task 3.6: hotskills.list and hotskills.deactivate tool implementations
- **Outcome:** `server/src/tools/list.ts` stub replaced: reads merged allow-list for `scope` param (`"project"`, `"global"`, `"merged"`; default `"merged"`); returns array of `{skill_id, activated_at, description}`. `server/src/tools/deactivate.ts` stub replaced: removes skill from project allow-list (not global unless scoped); writes config atomically; does NOT delete cache directory.
- **Touches:** `server/src/tools/list.ts`, `server/src/tools/deactivate.ts`, `server/src/__tests__/tools/list.test.ts`, `server/src/__tests__/tools/deactivate.test.ts`
- **Acceptance:** Test: list with `scope: "project"` returns only project-scoped skills; deactivate removes from project list only; deactivate a non-activated skill returns a structured error (not a crash); cache directory still exists after deactivate.
- **Depends on:** Task 3.2

### Task 3.7: Skill ID parser and validator
- **Outcome:** `server/src/skill-id.ts` implements `parseSkillId(raw)` → `{source, owner, repo, slug}` or throws a typed `SkillIdError`. Validates source is one of `skills.sh`, `github`, `git`. Rejects ambiguous or partial IDs. Exported and used by activate, invoke, deactivate, and audit tools.
- **Touches:** `server/src/skill-id.ts`, `server/src/__tests__/skill-id.test.ts`
- **Acceptance:** Tests cover valid IDs for all three source types, malformed IDs (missing source, missing slug, extra segments), and the specific example from ADR-001 (`skills.sh:vercel-labs/agent-skills:react-best-practices`).
- **Depends on:** Task 1.2

---

## Plan-Phase 4: Security gate stack

**Goal:** Implement the full four-layer gate stack (whitelist → audit → heuristic → install+author), wire it into `hotskills.activate`, implement `hotskills.audit` tool, and establish the whitelist and audit error log files.

**Exit criteria:** `hotskills.activate` for a skill with `snyk: "high"` in audit data is blocked with reason `audit:snyk:high`; a whitelisted org bypasses all gates and logs to `whitelist-activations.log`; a skill with no audit data and `installs < 1000` is blocked with reason `install_threshold`; heuristic gate is off by default and can be enabled via config; `hotskills.audit` returns cached audit data for a skill.

### Task 4.1: Risk severity comparator and multi-partner conflict resolver
- **Outcome:** `server/src/gate/risk.ts` implements `compareRisk(a, b)` (total ordering: `safe < low < medium < high < critical < unknown`), `effectiveRisk(partners)` (max-of-partners; `unknown` is treated as worst-case), and a `riskExceedsMax(effective, riskMax)` predicate. Only `audit_conflict_resolution: "max"` is implemented; other values produce a config validation error.
- **Touches:** `server/src/gate/risk.ts`, `server/src/__tests__/gate/risk.test.ts`
- **Acceptance:** Unit tests: `effectiveRisk({snyk: {risk: "high"}, socket: {risk: "low"}})` → `"high"`; `compareRisk("unknown", "critical")` → unknown is greater; config with `audit_conflict_resolution: "mean"` returns a typed config-validation error.
- **Depends on:** Task 1.4

### Task 4.2: Whitelist gate with append-only log
- **Outcome:** `server/src/gate/whitelist.ts` implements `checkWhitelist(skillId, parsedId, config)` → `{allow: true, matchedEntry}` or `{allow: false}`. On allow, appends a structured JSON line to `${HOTSKILLS_CONFIG_DIR}/logs/whitelist-activations.log` (skill_id, scope, timestamp, matching whitelist entry). Log directory is created if absent. Log write is atomic (append is POSIX-atomic for lines <PIPE_BUF; document this assumption).
- **Touches:** `server/src/gate/whitelist.ts`, `server/src/__tests__/gate/whitelist.test.ts`
- **Acceptance:** Test: skill matching `whitelist.skills` → allow + log entry written; skill matching `whitelist.orgs` → allow; no match → deny; log file contains valid JSON lines after concurrent activations (run 5 concurrent whitelist-matching activations, verify no log corruption).
- **Depends on:** Task 3.2, Task 4.1

### Task 4.3: Audit gate
- **Outcome:** `server/src/gate/audit-gate.ts` implements `checkAuditGate(parsedId, config, auditClient)` → `{decision: "allow"|"block"|"no_data", reason?, effectiveRisk?}`. Calls `audit.ts`, applies `effectiveRisk`, compares against `config.security.risk_max`. Handles `no_audit_data_policy`: `fallback_to_installs` → `no_data`, `block` → `block`, `allow_with_warning` → `allow` with warning flag.
- **Touches:** `server/src/gate/audit-gate.ts`, `server/src/__tests__/gate/audit-gate.test.ts`
- **Acceptance:** Tests cover: audit returns `snyk:high` with `risk_max: "medium"` → block with reason `audit:snyk:high`; all partners `safe` → allow; audit timeout → `no_data` (no block); `no_audit_data_policy: "block"` + no data → block with reason `no_audit_data:blocked`.
- **Depends on:** Task 2.5, Task 4.1

### Task 4.4: Heuristic gate (opt-in static scanner)
- **Outcome:** `server/src/gate/heuristic.ts` implements the four pattern checkers (`broad_bash_glob`, `write_outside_cwd`, `curl_pipe_sh`, `raw_network_egress`) against SKILL.md frontmatter and `scripts/` file contents. Each pattern has a 100ms per-file execution timeout. Findings map to synthetic risk per ADR-004 (0 patterns → `low`, 1 → `medium`, 2+ → `high`). Results are labeled `source: "heuristic"`. Returns `{decision, syntheticRisk, findings}`. Only runs if `config.security.heuristic.enabled: true`.
- **Touches:** `server/src/gate/heuristic.ts`, `server/src/__tests__/gate/heuristic.test.ts`
- **Acceptance:** Tests for each pattern: a SKILL.md with `Bash(*)` in allowed-tools triggers `broad_bash_glob`; a script containing `curl http://... | sh` triggers `curl_pipe_sh`; a script with `Write /etc/passwd` triggers `write_outside_cwd`; timeout protection — a pathological regex input completes or times out within 200ms.
- **Depends on:** Task 4.1

### Task 4.5: Install + author gate
- **Outcome:** `server/src/gate/install-gate.ts` implements `checkInstallGate(parsedId, installCount, config)` → `{decision: "allow"|"block", reason?}`. Checks `installs >= security.min_installs`, `owner` in `security.preferred_sources`, `owner` in built-in `audited_authors_allowlist` (`anthropics`, `vercel-labs`, `microsoft`, `mastra-ai`, `remotion-dev`). Returns block reason `install_threshold:<installs>:<min_installs>` on deny.
- **Touches:** `server/src/gate/install-gate.ts`, `server/src/__tests__/gate/install-gate.test.ts`
- **Acceptance:** Tests: `installs: 500, min_installs: 1000` → block; `installs: 500, owner: "vercel-labs"` → allow (built-in allowlist); `installs: 500, owner: "myorg", preferred_sources: ["myorg"]` → allow; `installs: 1001` → allow.
- **Depends on:** Task 4.1

### Task 4.6: Gate stack orchestrator and activation wire-up
- **Outcome:** `server/src/gate/index.ts` composes the four gates in order (whitelist → audit → heuristic → install), short-circuiting on first BLOCK. Returns `{decision: "allow"|"block", reason, layers: {whitelist, audit, heuristic, install}}`. Wired into `hotskills.activate` (Task 3.4), replacing the stub pass-through gate. `hotskills.search` uses a read-only preview (Task 2.6 gate_status) updated to use this stack.
- **Touches:** `server/src/gate/index.ts`, `server/src/tools/activate.ts` (update gate call), `server/src/tools/search.ts` (update gate preview), `server/src/__tests__/gate/index.test.ts`
- **Acceptance:** Integration test: full gate stack for a skill with `snyk: "high"` → blocked at audit layer, install gate never runs; whitelist match → all subsequent gates skipped; heuristic disabled by default → heuristic layer result is `skipped`; block reason propagated through activate tool response.
- **Depends on:** Task 3.4, Task 4.2, Task 4.3, Task 4.4, Task 4.5

### Task 4.7: hotskills.audit tool implementation
- **Outcome:** `server/src/tools/audit.ts` stub replaced: accepts `{skill_id}`; parses skill ID; returns cached `AuditResponse` for the skill (calls `audit.ts` which uses the 24h cache); includes `gate_status` preview and `heuristic` data if `heuristic.enabled` and skill is in cache. Never forces a re-fetch; returns `cached_at` timestamp.
- **Touches:** `server/src/tools/audit.ts`, `server/src/__tests__/tools/audit.test.ts`
- **Acceptance:** Test: audit for a skill with cached data returns it without a network call; audit for a skill with no cached data fetches and caches; malformed skill ID returns structured error.
- **Depends on:** Task 2.5, Task 4.1

---

## Plan-Phase 5: Hooks, slash commands, and setup flow

**Goal:** Implement the `inject-reminders.sh` hook script, `hooks/hooks.json`, the `/hotskills` and `/hotskills-setup` slash command bodies, and the setup flow including find-skills auto-activation, `.gitignore` patching, and Phase 0 verification smoke tests.

**Exit criteria:** Running `scripts/inject-reminders.sh --event=UserPromptSubmit` in a project with activated skills emits a well-formed `<system-reminder>` block to stdout within 200ms and exits zero; running it in a project with no `.hotskills/` exits zero with no output; the `/hotskills-setup` command body walks through global config creation, find-skills activation, and `npx` availability check; shell tests for the hook script cover all required scenarios.

### Task 5.1: inject-reminders.sh hook script
- **Outcome:** `scripts/inject-reminders.sh` implements the full per-event logic from ADR-005: `--event=PostCompact` emits activated-skills reminder + opportunistic reminder (if `opportunistic: true`), sets `opportunistic_pending: true` in `state.json`, updates `last_compact_at`; `--event=SessionStart` emits reminders, sets pending, updates `last_session_start_at`, writes fresh `session_id`; `--event=UserPromptSubmit` emits activated-skills reminder always (if allow-list non-empty), emits opportunistic reminder only if `opportunistic_pending: true` then clears flag. Activated-skills reminder caps at 20 entries (most-recently-activated first); descriptions truncated to 80 chars. All IO failures log to `${HOTSKILLS_CONFIG_DIR}/logs/hook.log` and exit zero.
- **Touches:** `scripts/inject-reminders.sh`
- **Acceptance:** Shell tests (`bats` or equivalent): empty allow-list → exit 0, no stdout; 1-skill allow-list → correct `<system-reminder>` block; 25-skill allow-list → first 20 + "... and 5 more" line; `opportunistic_pending: true` + UserPromptSubmit → both reminders, flag cleared; corrupted `config.json` → exit 0, no stdout, log entry written; runtime ≤200ms on 20-skill allow-list (timed in CI).
- **Depends on:** Task 3.2
- **risk:high** — Hook stdout injection into post-compact context is a load-bearing assumption (ADR-005 Phase 0 item). This task should be marked complete only after manual smoke-test confirms `PostCompact` stdout is injected into the model context (not just shown to the user). Similarly, confirm `SessionStart` injection and whether `/clear` triggers `SessionStart`.

### Task 5.2: hooks/hooks.json declaration
- **Outcome:** `hooks/hooks.json` declares the three hook handlers (PostCompact, SessionStart, UserPromptSubmit) using the exact format from ADR-005, referencing `${CLAUDE_PLUGIN_ROOT}/scripts/inject-reminders.sh --event=<X>`. Matcher is `*` for all three.
- **Touches:** `hooks/hooks.json`
- **Acceptance:** JSON is valid; event names, matcher, and command field match ADR-005 exactly; `${CLAUDE_PLUGIN_ROOT}` is used (no absolute paths).
- **Depends on:** Task 5.1

### Task 5.3: /hotskills-setup slash command body
- **Outcome:** `commands/hotskills-setup.md` stub replaced with a full slash command body: creates `~/.config/hotskills/config.json` with default security config (ADR-004 schema); auto-activates `skills.sh:vercel-labs/skills:find-skills` to global config (calls `hotskills.activate` or writes directly); creates per-project `.hotskills/config.json` skeleton if invoked in a repo; patches `.gitignore` to add `.hotskills/state.json` if `.gitignore` exists; checks `npx skills` on PATH (warns if absent); verifies audit API and skills.sh API are reachable; writes `session_id` to `state.json`.
- **Touches:** `commands/hotskills-setup.md`
- **Acceptance:** Running `/hotskills-setup` on a clean machine creates the global config with all required fields; running it a second time is idempotent (no duplicate entries, no error); warns cleanly if `npx` is absent.
- **Depends on:** Task 3.2, Task 3.4, Task 5.2

### Task 5.4: /hotskills slash command body
- **Outcome:** `commands/hotskills.md` stub replaced: without args, shows activated skills for current project (calls `hotskills.list`) and prompts for a query; with `[query]`, calls `hotskills.search` and shows ranked candidates with audit/gate status; `--auto` activates the top passing-gate result; `--source <repo>` scopes the search; `--whitelist <skill_id>` appends to per-project whitelist after displaying the warning required by ADR-004 (what skill, current risk level, consequence of bypassing gates).
- **Touches:** `commands/hotskills.md`
- **Acceptance:** Command body is syntactically valid markdown; picker instructions reference `hotskills.search`, `hotskills.activate`, `hotskills.list`; whitelist warning text matches ADR-004 requirements; `--auto` instruction references the pass-gate condition.
- **Depends on:** Task 2.6, Task 3.6, Task 4.6

### Task 5.5: Phase 0 manual checklist + lock-primitive concurrent test
- **Outcome:** `docs/plans/phase0-manual-checklist.md` documents all remaining Phase 0 verification items from the five ADRs that require a live Claude Code session and cannot be CI-automated: (a) `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_PLUGIN_ROOT}` env-var resolution; (b) PostCompact hook stdout injection into post-compact context; (c) SessionStart hook stdout injection at session start; (d) whether `/clear` triggers SessionStart; (e) `${SKILL_PATH}` substitution coverage on 20 popular skills sampled from skills.sh. The checklist names a verifier (manual smoke test on a real Claude Code install) and pass/fail criteria per item. Additionally, `scripts/phase0-lock-test.sh` and `.github/workflows/phase0-lock-test.yml` exercise the chosen lock primitive (Task 2.3) under simulated concurrent activations to confirm it behaves correctly across MCP child processes. (API smoke tests + `npx skills` behavior are handled in Tasks 1.6 and 1.7 respectively.)
- **Touches:** `docs/plans/phase0-manual-checklist.md`, `scripts/phase0-lock-test.sh`, `.github/workflows/phase0-lock-test.yml`
- **Acceptance:** Checklist exists with clear pass/fail criteria for each item and is referenced from each relevant ADR; lock-primitive test passes in CI under 5 concurrent acquire attempts; the checklist is signed off (timestamp + verifier name written into the file) before Task 5.1 (`inject-reminders.sh`) is closed.
- **Depends on:** Task 2.3

---

## Plan-Phase 6: Integration tests, E2E, logging structure, README, and install docs

**Goal:** Wire all phases together with cross-component integration tests, one full setup-to-invoke E2E test, validate all log file paths and formats, and produce the README and install instructions that make the plugin installable and usable by a new user.

**Exit criteria:** A full E2E test script (`scripts/e2e.sh`) runs from scratch: creates a temp project dir, runs setup equivalent, searches for a skill, activates it (with real gate evaluation), invokes it, verifies the returned body and paths, and deactivates — all without a live Claude Code session (MCP server invoked directly via stdio). All log files (`whitelist-activations.log`, `audit-errors.log`, `hook.log`) are written in structured JSON lines format. `README.md` explains one-command install.

### Task 6.1: Structured logging module
- **Outcome:** `server/src/logger.ts` provides `log(level, event, fields)` → writes a JSON line to the appropriate log file (structured: `{ts, level, event, ...fields}`). Three log sinks: `${HOTSKILLS_CONFIG_DIR}/logs/whitelist-activations.log` (whitelist gate), `${HOTSKILLS_CONFIG_DIR}/logs/audit-errors.log` (audit client errors), `${HOTSKILLS_CONFIG_DIR}/logs/hook.log` (hook script). Log directory created if absent. Debug-level logging gated on `HOTSKILLS_DEBUG=true` env var (not committed).
- **Touches:** `server/src/logger.ts`, `scripts/inject-reminders.sh` (update to use same JSON lines format for hook.log), `MANIFEST.md`
- **Acceptance:** Integration test: after a whitelist-match activation, `whitelist-activations.log` contains a valid JSON line with `skill_id`, `scope`, `ts`, `matched_entry`; after a simulated audit fetch failure, `audit-errors.log` contains a JSON line with `error`, `skill_id`, `ts`; hook log from a failed inject-reminders run contains `event`, `error`, `ts`.
- **Depends on:** Task 4.2, Task 2.5, Task 5.1

### Task 6.2: Cross-component integration tests
- **Outcome:** `server/src/__tests__/integration/` contains tests covering: (a) search → activate → invoke → deactivate round-trip (all real modules, network mocked at the HTTP boundary); (b) gate stack with all four layers exercised (whitelist bypass, audit block, heuristic block, install block, full allow); (c) config merge producing correct merged allow-list with project + global entries; (d) concurrent activations of the same skill from two async contexts (lock prevents double-materialization); (e) hook script emitting correct reminder content for a 20-skill and 25-skill allow-list.
- **Touches:** `server/src/__tests__/integration/`
- **Acceptance:** All integration tests pass in CI; the concurrent-activation test verifies via manifest timestamp that materialization happened exactly once; tests use a temp directory for `HOTSKILLS_CONFIG_DIR` and clean up after themselves.
- **Depends on:** Task 3.5, Task 4.6, Task 5.1, Task 6.1

### Task 6.3: E2E test script
- **Outcome:** `scripts/e2e.sh` orchestrates a full setup-to-invoke flow against the real MCP server via stdio: starts the server process, sends JSON-RPC `tools/list`, calls `hotskills.search`, calls `hotskills.activate` (with audit and gate mocked at the HTTP level via environment override), calls `hotskills.invoke`, verifies returned body contains `${SKILL_PATH}` substitution and `scripts`/`references` arrays, calls `hotskills.deactivate`, verifies allow-list is empty. Exits non-zero on any unexpected result.
- **Touches:** `scripts/e2e.sh`, `.github/workflows/ci.yml` (add e2e job)
- **Acceptance:** E2E script passes in CI on a clean checkout; any of the six tool stubs (not yet replaced) cause the script to fail loudly; the script cleans up temp directories on both pass and fail.
- **Depends on:** Task 6.2, Task 5.5

### Task 6.4: MANIFEST.md final reconciliation
- **Outcome:** `MANIFEST.md` is fully populated with all modules, facades, and scripts created across all phases. The module registry covers: `cache.ts`, `config.ts`, `audit.ts`, `skill-id.ts`, `logger.ts`, `migrations/index.ts`, `materialize.ts`, all gate modules, all tool modules, `vendor/vercel-skills/*`, `scripts/inject-reminders.sh`. External integration facades documented for: skills.sh API (search + blob), `add-skill.vercel.sh/audit` API, `git` CLI (sparse-checkout), and (optional) `npx skills find` CLI when present.
- **Touches:** `MANIFEST.md`
- **Acceptance:** Every `server/src/*.ts` file and `scripts/*.sh` file has an entry; no duplicate entries; all file paths are absolute or clearly relative to repo root; external facades section matches the three external surfaces.
- **Depends on:** Task 6.2

### Task 6.5: README and install documentation
- **Outcome:** `README.md` at repo root covers: one-sentence description, one-command install (Claude Code plugin install), prerequisites (Node 22+, `npx skills`), first-use (`/hotskills-setup`), the six tools and what they do, slash commands, hooks behavior, security gating overview, per-project config reference, and a troubleshooting section for the most common failure modes (audit API unreachable, `npx` not on PATH, lock timeout).
- **Touches:** `README.md`
- **Acceptance:** A developer who has not read the ADRs can install and activate their first skill using only the README; the troubleshooting section addresses all failure modes from ADR-001 §11 ("Failure modes + degradation" in the synthesis doc).
- **Depends on:** Task 6.4
