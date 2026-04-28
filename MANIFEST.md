# Agent & Module Manifest

**Purpose:** This file acts as the single source of truth for all coding agents. It records the existing agents, available internal modules, and external integrations to prevent duplication of effort and maintain architectural consistency.
**Rule:** Agents MUST update this registry whenever a new reusable module, agent role, or external facade is created.

---

## 🤖 1. Active Agent Teams & Roles

| Agent Name | Primary Role | Trigger Condition | Capabilities / Scopes |
| :--- | :--- | :--- | :--- |
| `Grooming_Agent` | Fleshes out beads task descriptions and notes | `brains:ready-for-grooming` label on phase tasks | Read beads, write notes, swap labels |
| `Implementation_Agent` | Implements individual phase tasks | Task assigned and groomed | Read/write `server/`, `scripts/`, config files |
| `Nurture_Agent` | Post-phase quality review and cleanup | All phase impl tasks closed | Read/write repo, close beads tasks |
| `Secure_Agent` | Security review of phase changes | Nurture complete | Read-only code scan, write beads findings |

---

## 🧩 2. Module & Function Registry

### 2.1 MCP server core (server/src/)

| Module / Function | File Path | Description | Dependencies | Idempotent (Y/N) |
| :--- | :--- | :--- | :--- | :--- |
| MCP server entry | `server/src/index.ts` | Boots `McpServer` with stdio transport; validates env via `resolveEnv()` before binding; eagerly checks git version when github sources are configured; registers 6 tools | `@modelcontextprotocol/sdk`, `env.ts`, `tools/index.ts`, `materialize.ts`, `config.ts` | Y |
| `resolveEnv / getProjectCwd / getConfigDir` (+ `ConfigError`) | `server/src/env.ts` | Env-var trust boundary: canonicalize + validate `HOTSKILLS_PROJECT_CWD` and `HOTSKILLS_CONFIG_DIR`; enforces `${HOME}/.config` sandbox unless `HOTSKILLS_DEV_OVERRIDE` covers the path | `node:fs`, `node:os`, `node:path` | Y |
| `cacheRead / cacheWrite / cacheAgeSeconds / cachePath` | `server/src/cache.ts` | On-disk JSON cache with TTL + optional schema validation; atomic `.tmp` + fsync + rename writes; 0700 dirs / 0600 files; 16 MiB read ceiling | `node:fs`, `node:fs/promises` | Y |
| `acquireLock / releaseLock / withLock` (+ `LockTimeoutError`) | `server/src/cache.ts` | Inter-process directory lock (`<dir>.lock` via O_EXCL); 30s default timeout, 50ms backoff; idempotent release; stale-lock cleanup deferred to v1 | `node:fs` | Y |
| `getAuditData` (+ type re-exports `AuditResponse`, `PartnerAudit`, `SkillAuditData`) | `server/src/audit.ts` | Audit-API client wrapper: cache-first lookup against `${HOTSKILLS_CONFIG_DIR}/cache/audit/<owner>-<repo>.json` (24h TTL); delegates network to vendored `fetchAuditData`; errors logged via `logger.ts` to `audit-errors.log` | `cache.ts`, `logger.ts`, vendored `telemetry.ts` | Y |
| `parseSkillId / formatSkillId` (+ `SkillIdError`) | `server/src/skill-id.ts` | Parse `<source>:<owner>/<repo>:<slug>` → `ParsedSkillId`; validate source enum; reject ambiguous IDs | (none) | Y |
| `materializeSkill` (+ `checkGitVersion`, `cacheSkillPath`, `assertSafeSkillId`, `defaultGit`, `MaterializationError`/`GitVersionError`/`UnsafeSkillIdError`) | `server/src/materialize.ts` | Source-typed materialization router per ADR-002 Amendment 1: `skills.sh:` → vendored `blob.ts`; `github:` → `git clone --depth 1 --filter=blob:none --sparse` + `sparse-checkout set <subdir>`; per-skill lock; atomic rename; subprocess args sanitized | `cache.ts`, vendored `blob.ts`, `node:child_process`, `git` >= 2.25 | Y |
| `activateSkill` (+ `computeContentSha`, `ActivationManifest`) | `server/src/activation.ts` | Activation engine: outer activate-lock + manifest fast-path; on miss, calls materialize and writes `.hotskills-manifest.json`; idempotent re-activation when content sha matches | `cache.ts`, `materialize.ts`, `node:crypto`, `node:fs` | Y |
| `readGlobalConfig / readProjectConfig / mergeConfigs / writeProjectConfig / readProjectState / writeProjectState` | `server/src/config.ts` | Per-project + global config IO with schema validation, migration hookup, atomic writes, allow-list merge per ADR-003 | `cache.ts`, `schemas/index.ts`, `migrations/index.ts` | Y |
| `runMigrations` | `server/src/migrations/index.ts` | Forward-only migration runner; reads `version` from raw config, applies each registered migration in order, surfaces structured `upgrade required` error for future versions | (none) | Y |
| `validateConfig() / validateState()` | `server/src/schemas/index.ts` | ajv-compiled validators for `config.v1.json` and `state.v1.json` (JSON Schema draft 2020-12) | `ajv`, `ajv-formats` | Y |
| `log / logPath` (+ `LogSink`, `LogLevel`) | `server/src/logger.ts` | **(Phase 6)** Single sink router for the three JSONL log files (`whitelist-activations.log`, `audit-errors.log`, `hook.log`); canonical `{ts, level, event, ...fields}` shape; debug level gated on `HOTSKILLS_DEBUG=true`; best-effort (failures swallowed) | `node:fs/promises` | Y |

### 2.2 Tools (server/src/tools/)

| Module / Function | File Path | Description |
| :--- | :--- | :--- |
| `registerTools()` | `server/src/tools/index.ts` | Registers all 6 hotskills tools on a McpServer |
| `registerSearch / runSearch / resolveFindStrategy` | `server/src/tools/search.ts` | Cache-first 1h TTL; dispatches to vendored `searchSkillsAPI` (api) or `npx skills find` shell-out (cli); merges audit data; gate_status preview via `runGatePreview` |
| `registerActivate / runActivate` | `server/src/tools/activate.ts` | Parses skill_id, runs gate stack, calls `activateSkill`, appends to allow-list; supports `force_whitelist` |
| `registerDeactivate / runDeactivate` | `server/src/tools/deactivate.ts` | Removes skill from project (or scoped) allow-list; cache directory survives |
| `registerInvoke / runInvoke` | `server/src/tools/invoke.ts` | Reads materialized SKILL.md, substitutes `${SKILL_PATH}`, enumerates scripts/ + references/; drops stale entries when cache is missing |
| `registerList / runList` | `server/src/tools/list.ts` | Returns activated array (project / global / merged) |
| `registerAudit / runAuditTool` | `server/src/tools/audit.ts` | Returns cached audit data + gate preview without forcing a re-fetch |

### 2.3 Gate stack (server/src/gate/)

| Module / Function | File Path | Description |
| :--- | :--- | :--- |
| `compareRisk / effectiveRisk / riskExceedsMax` | `server/src/gate/risk.ts` | Risk severity comparator + max-of-partners conflict resolver per ADR-004 |
| `checkWhitelist / matchWhitelist / logWhitelistActivation / whitelistLogPath` | `server/src/gate/whitelist.ts` | Whitelist gate (skills/repos/orgs); writes JSONL via shared `logger.ts` |
| `checkAuditGate` | `server/src/gate/audit-gate.ts` | Audit gate; applies `effectiveRisk` against `risk_max`; honors `no_audit_data_policy` |
| `runHeuristic` | `server/src/gate/heuristic.ts` | Opt-in static scanner: 4 patterns (broad bash glob, write outside cwd, curl|sh, raw network egress) with per-file timeout |
| `checkInstallGate` | `server/src/gate/install-gate.ts` | Install + author gate; built-in `audited_authors_allowlist` |
| `runGate / runGatePreview` | `server/src/gate/index.ts` | Orchestrates the four-layer stack (whitelist → audit → heuristic → install); short-circuits on first BLOCK |

### 2.4 Vendored support layer (server/src/vendor/vercel-skills/)

Synced from `vendor/vercel-skills/` at build time by `server/scripts/sync-vendor.mjs`. See §2a for upstream metadata.

### 2.5 Tests (server/src/__tests__/)

| Path | Coverage |
| :--- | :--- |
| `__tests__/smoke.test.ts` | Smoke check that the test runner is wired up |
| `__tests__/cache.test.ts` | Cache primitive + lock semantics |
| `__tests__/env.test.ts` | Env-var validation, sandbox enforcement |
| `__tests__/audit.test.ts` | Audit client cache + error logging |
| `__tests__/materialize.test.ts` | blob.ts vs sparse-checkout dispatch + lock + safe-skill-id |
| `__tests__/search.test.ts` | search tool: cli/api/auto strategy, cache, audit decoration |
| `__tests__/migrations.test.ts` | Migration runner |
| `__tests__/skill-id.test.ts` | parseSkillId / formatSkillId |
| `__tests__/config.test.ts` | Config IO, merge, schema validation, atomic writes |
| `__tests__/activation.test.ts` | activateSkill + manifest fast-path |
| `__tests__/schema-limits.test.ts` | Ajv DoS guards |
| `__tests__/logger.test.ts` | **(Phase 6)** logger.ts: per-sink path, debug gating, fields shadowing, dir perms |
| `__tests__/tools.test.ts` | tools/index.ts registration |
| `__tests__/tools/{activate,invoke,list,deactivate,audit}.test.ts` | Per-tool unit tests |
| `__tests__/gate/{risk,whitelist,audit-gate,heuristic,install-gate,index}.test.ts` | Per-gate + composed-stack unit tests |
| `__tests__/integration/activate-invoke-deactivate.test.ts` | Roundtrip with mocked materialize |
| `__tests__/integration/gate-stack.test.ts` | Full gate stack via runActivate |
| `__tests__/integration/full-roundtrip.test.ts` | **(Phase 6)** search → activate → invoke → deactivate via real runners |
| `__tests__/integration/concurrent-activation.test.ts` | **(Phase 6)** 2 + 5 concurrent activateSkill calls; lock asserts single materialize |
| `__tests__/integration/hook-script.test.ts` | **(Phase 6)** drives real `inject-reminders.sh` from Node at 0/20/25 skills |
| `__tests__/integration/log-sinks.test.ts` | **(Phase 6)** end-to-end JSONL shape across all three sinks |

### 2.6 Build + harness scripts (server/scripts/)

| Script | Description |
| :--- | :--- |
| `server/scripts/sync-vendor.mjs` | Build prebuild step: copies `vendor/vercel-skills/*.ts` into `server/src/vendor/vercel-skills/` so tsc compiles vendored sources without widening rootDir |
| `server/scripts/run-tests.mjs` | **(Phase 6)** Discovers every `dist/__tests__/**/*.test.js` and dispatches to `node --test` — replaces the brittle hard-coded list |

### 2.7 Repo-level scripts (scripts/)

| Script | Description |
| :--- | :--- |
| `scripts/inject-reminders.sh` | ADR-005 hook script for `PostCompact` / `SessionStart` / `UserPromptSubmit`; emits `<system-reminder>` blocks; writes hook.log via shared logger format |
| `scripts/tests/inject-reminders.test.sh` | Bash test harness for the hook script (16 scenarios / 49 assertions) |
| `scripts/phase0-api-verify.sh` | RISK-FIRST CI smoke-test for skills.sh `/api/search` and add-skill.vercel.sh `/audit` |
| `scripts/phase0-npx-verify.sh` | RISK-FIRST CI smoke-test for `skills add --target` (currently fails: flag absent in v1.5.1) |
| `scripts/phase0-lock-test.sh` | Lock-primitive concurrency check (5 workers; backed by `.github/workflows/phase0-lock-test.yml`) |
| `scripts/check-vendor-drift.sh` | Re-fetches vendored modules from upstream at the pinned SHA and diffs |
| `scripts/e2e.sh` | **(Phase 6)** MCP-server stdio E2E roundtrip wrapper |
| `scripts/tests/e2e-stdio.mjs` | **(Phase 6)** Node JSON-RPC driver used by `e2e.sh` |
| `scripts/e2e-claude-keyword.sh` | **(Phase 6)** Real `claude --plugin-dir` keyword-flow E2E (gated behind `CI_E2E_CLAUDE=1`) |
| `scripts/e2e-claude-config.sh` | **(Phase 6)** Real `claude --plugin-dir` config-matrix E2E (gated behind `CI_E2E_CLAUDE=1`) |
| `scripts/e2e-plugin-load.sh` | Manifest-schema E2E: `claude plugin marketplace add` + `claude plugin install` against this repo to catch `.claude-plugin/marketplace.json` and `plugin.json` schema drift |

---

## 📦 2a. Vendored Modules (vercel-labs/skills)

Source-of-truth lives at `vendor/vercel-skills/` (committed). Copied into
`server/src/vendor/vercel-skills/` (gitignored) at build time. Full
attribution and per-file modification log at `vendor/vercel-skills/ATTRIBUTION.md`.

| Vendored module | Upstream path | Modifications | Purpose |
| :--- | :--- | :--- | :--- |
| `vendor/vercel-skills/types.ts` | `src/types.ts` | none | Shared types: `ParsedSource`, `Skill`, `AgentConfig`, `RemoteSkill`, `AgentType` |
| `vendor/vercel-skills/telemetry.ts` | `src/telemetry.ts` | telemetry tracking stripped | Audit API client: `fetchAuditData`, `PartnerAudit`, `AuditResponse` |
| `vendor/vercel-skills/source-parser.ts` | `src/source-parser.ts` | import-extension only | URL/source parsing: `parseSource`, `getOwnerRepo`, `parseOwnerRepo`, `sanitizeSubpath`, `isRepoPrivate` |
| `vendor/vercel-skills/blob.ts` | `src/blob.ts` | inlined `parseFrontmatter`; import-extension | Blob materialization: `tryBlobInstall`, `fetchRepoTree`, `findSkillMdPaths`, `toSkillSlug`; adds `yaml` runtime dep |
| `vendor/vercel-skills/find.ts` | `src/find.ts` | extracted only `searchSkillsAPI` | skills.sh search API client: `searchSkillsAPI`, `SearchSkill` |

Sync state: SHA `bc21a37a12b90fcb5aec051c91baf5b227b704b1` (tag v1.5.1), 2026-04-23.
Drift check workflow tracked in beads task `hotskills-35o`.
Upstream PR tracking (drop vendor in v1): `docs/plans/vendor-upstream-pr-tracking.md`.

---

## 🔌 3. External Integrations (Facades)

All external surfaces are wrapped behind a local module so vendor swaps and behavioral overrides stay in one place.

| Facade Name | File Path | Wrapped Library/API | Purpose |
| :--- | :--- | :--- | :--- |
| `AuditApiClient` | `server/src/audit.ts` | `add-skill.vercel.sh/audit` (via vendored `fetchAuditData`) | Cache-first audit lookups with error logging and no-data sentinel |
| `SkillsApiSearch` | `server/src/tools/search.ts` (via vendored `find.ts`) | skills.sh `/api/search?q=` | Search API for `find_strategy` `api`/`auto` |
| `NpxSkillsCli` | `server/src/tools/search.ts` | `npx skills find` (optional) | Search CLI shell-out for `find_strategy` `cli`/`auto` |
| `BlobMaterializer` | `server/src/materialize.ts` | skills.sh `/api/download/...` (via vendored `blob.ts`) | Fetches SKILL.md tree as a blob snapshot, atomic-rename into cache layout |
| `GitSparseCheckoutMaterializer` | `server/src/materialize.ts` | `git` CLI (clone + sparse-checkout) | Materializes only the requested skill subdirectory from a github repo |
| `StructuredLogger` | `server/src/logger.ts` | `node:fs/promises.appendFile` | Single sink router for the three JSONL log files; canonical `{ts, level, event, ...}` shape |

---

## 📝 4. Global State & Conventions

* **Log Location:** `${HOTSKILLS_CONFIG_DIR}/logs/` (Structured JSON lines only).
* **Config Dir:** `~/.config/hotskills/` (default; overridable via `HOTSKILLS_CONFIG_DIR` env var).
* **Debug Flag:** Set `HOTSKILLS_DEBUG=true` in `.env.local` (Never commit this file).
* **Max Retries:** 3 attempts per subagent before circuit breaker triggers and escalates to user.
* **Schema Version:** `config.v1.json`, `state.v1.json` — JSON Schema draft 2020-12.
* **Skill ID Format:** `<source>:<owner>/<repo>:<slug>` (e.g., `skills.sh:vercel-labs/agent-skills:react-best-practices`).
