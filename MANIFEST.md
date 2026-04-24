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

| Module / Function | File Path | Description | Dependencies | Idempotent (Y/N) |
| :--- | :--- | :--- | :--- | :--- |
| `MCP server entry` | `server/src/index.ts` | Boots McpServer with stdio transport; validates env via `resolveEnv()` before binding; registers 6 tools | `@modelcontextprotocol/sdk`, `env.ts`, `tools/index.ts` | Y |
| `resolveEnv / getProjectCwd / getConfigDir` (+ `ConfigError`) | `server/src/env.ts` | Env-var trust boundary: canonicalize + validate HOTSKILLS_PROJECT_CWD and HOTSKILLS_CONFIG_DIR; enforces ${HOME}/.config sandbox unless HOTSKILLS_DEV_OVERRIDE covers the path | `node:fs`, `node:os`, `node:path` | Y |
| `registerTools()` | `server/src/tools/index.ts` | Registers all 6 hotskills tools on a McpServer | per-tool `register*` modules | Y |
| `registerSearch()` (+ `runSearch`, `resolveFindStrategy`) | `server/src/tools/search.ts` | Real handler: cache-first 1h TTL, dispatches to vendored `searchSkillsAPI` (api) or `npx skills find` shell-out (cli); merges audit data; gate_status placeholder until Phase 4 | `cache.ts`, `audit.ts`, vendored `find.ts` | Y |
| `registerActivate/Deactivate/List/Invoke/Audit()` | `server/src/tools/{activate,deactivate,list,invoke,audit}.ts` | Phase-1 stub handlers returning `{stub: true}`; full implementations land in Phases 3–4 | `zod`, MCP SDK | Y |
| `validateConfig()` / `validateState()` | `server/src/schemas/index.ts` | ajv-compiled validators for config.v1 and state.v1 schemas | `ajv`, `ajv-formats` | Y |
| `phase0-api-verify.sh` | `scripts/phase0-api-verify.sh` | RISK-FIRST CI smoke-test for skills.sh `/api/search` and add-skill.vercel.sh `/audit` | `curl`, `node` | Y |
| `phase0-npx-verify.sh` | `scripts/phase0-npx-verify.sh` | RISK-FIRST CI smoke-test for `skills add --target` (currently fails: flag absent in v1.5.1; resolution tracked in beads `hotskills-ns3`) | `npx`, `skills` CLI | Y |
| `sync-vendor.mjs` | `server/scripts/sync-vendor.mjs` | Build prebuild step: copies `vendor/vercel-skills/*.ts` into `server/src/vendor/vercel-skills/` so tsc compiles the vendored sources without widening rootDir | `node:fs` | Y |
| `cacheRead/cacheWrite/cacheAgeSeconds/cachePath` | `server/src/cache.ts` | On-disk JSON cache with TTL + optional schema validation; atomic .tmp+fsync+rename writes; 0700/0600 perms | `node:fs`, `node:fs/promises` | Y |
| `acquireLock/releaseLock/withLock` (+ `LockTimeoutError`) | `server/src/cache.ts` | Inter-process directory lock (`<dir>.lock` via O_EXCL); 30s default timeout, 50ms backoff; idempotent release; stale-lock cleanup deferred to v1 | `node:fs` | Y |
| `getAuditData` (+ type re-exports `AuditResponse`, `PartnerAudit`, `SkillAuditData`) | `server/src/audit.ts` | Audit-API client wrapper: cache-first lookup against `${HOTSKILLS_CONFIG_DIR}/cache/audit/<owner>-<repo>.json` (24h TTL); delegates network to vendored `fetchAuditData`; errors logged to `logs/audit-errors.log` | `cache.ts`, vendored `telemetry.ts` | Y |
| `materializeSkill` (+ `checkGitVersion`, `cacheSkillPath`, `assertSafeSkillId`, `defaultGit`, `MaterializationError`/`GitVersionError`/`UnsafeSkillIdError`) | `server/src/materialize.ts` | Source-typed materialization router per ADR-002 Amendment 1: `skills.sh:` → vendored `blob.ts`; `github:` → `git clone --depth 1 --filter=blob:none --sparse` + `sparse-checkout set <subdir>`; per-skill lock; atomic rename; subprocess args sanitized | `cache.ts`, vendored `blob.ts`, `node:child_process`, `git` >= 2.25 | Y |

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

| Facade Name | File Path | Wrapped Library/API | Purpose |
| :--- | :--- | :--- | :--- |
| `AuditApiClient` | `server/src/audit.ts` | `add-skill.vercel.sh/audit` (via vendored `fetchAuditData`) | Cache-first audit lookups with error logging and no-data sentinel |
| `SkillsApiSearch` | `server/src/tools/search.ts` (via vendored `find.ts`) | skills.sh `/api/search?q=` | Search API for `find_strategy` `api`/`auto` |
| `NpxSkillsCli` | `server/src/tools/search.ts` | `npx skills find` (optional) | Search CLI shell-out for `find_strategy` `cli`/`auto` |
| `BlobMaterializer` | `server/src/materialize.ts` | skills.sh `/api/download/...` (via vendored `blob.ts`) | Fetches SKILL.md tree as a blob snapshot, atomic-rename into cache layout |
| `GitSparseCheckoutMaterializer` | `server/src/materialize.ts` | `git` CLI (clone + sparse-checkout) | Materializes only the requested skill subdirectory from a github repo |

---

## 📝 4. Global State & Conventions

* **Log Location:** `${HOTSKILLS_CONFIG_DIR}/logs/` (Structured JSON lines only).
* **Config Dir:** `~/.config/hotskills/` (default; overridable via `HOTSKILLS_CONFIG_DIR` env var).
* **Debug Flag:** Set `HOTSKILLS_DEBUG=true` in `.env.local` (Never commit this file).
* **Max Retries:** 3 attempts per subagent before circuit breaker triggers and escalates to user.
* **Schema Version:** `config.v1.json`, `state.v1.json` — JSON Schema draft 2020-12.
* **Skill ID Format:** `<source>:<owner>/<repo>:<slug>` (e.g., `skills.sh:vercel-labs/agent-skills:react-best-practices`).
