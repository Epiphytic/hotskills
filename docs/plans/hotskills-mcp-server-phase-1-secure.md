# Security Review: hotskills-mcp-server Phase 1

**Date:** 2026-04-23
**Scope:** Phase 1 implementation (plugin scaffold, MCP server skeleton, 6 stub tools, JSON schemas, CI pipeline, Phase 0 smoke tests)
**Mode:** `--parallel` (local + star-chamber review)
**Branch:** `brains/hotskills-mcp-server`

## Scope

Files reviewed (14 changed in phase-1 commits):
- `.mcp.json` — MCP server declaration + env var injection
- `server/src/index.ts` — MCP entry point
- `server/src/tools/*.ts` — 6 stub tool handlers
- `server/src/schemas/index.ts` — ajv schema validators (now JSON-loaded)
- `server/src/schemas/{config,state}.v1.json` — JSON Schema definitions
- `server/src/__tests__/{tools,smoke}.test.ts` — stdio integration + smoke tests
- `scripts/phase0-api-verify.sh` — external API smoke test
- `scripts/phase0-npx-verify.sh` — npx skills CLI smoke test
- `.github/workflows/{ci,phase0-api-verify,phase0-npx-verify}.yml` — CI workflows
- `hooks/hooks.json` — REMOVED in this phase (premature; see finding #2)

## Secrets Scan

**Result: Clean.** Grep for `api[_-]?key|secret|password|token|credential|private[_-]?key|bearer` matched zero source files (only references inside `docs/`). Environment variables (`HOTSKILLS_CONFIG_DIR`, `HOTSKILLS_PROJECT_CWD`) reference Claude Code-provided variables via `.mcp.json`, not hardcoded values.

## OWASP Assessment

| Category | Relevant? | Finding |
|----------|-----------|---------|
| Injection | Yes (shell scripts) | LOW: `node -e` invocations in phase0 scripts use `process.argv` not string interpolation; safe. |
| Broken Auth | No | MCP server is local stdio; no auth surface in Phase 1 |
| Sensitive Data | Low | No PII handled; schemas define structure only |
| XXE | No | No XML parsing |
| Broken Access Control | Deferred | Activation gating is Phase 4 |
| Security Misconfiguration | Yes | See findings #1 and #2 |
| XSS | No | No web surface |
| Insecure Deserialization | Low | ajv validates before use; no `eval` or `Function()` |
| Vulnerable Components | No | npm audit: 0 vulnerabilities (94 deps) |
| Insufficient Logging | Deferred | Logging module is Phase 6 |

## Dependency Audit

```
npm audit (server, 2026-04-23):
  info: 0, low: 0, moderate: 0, high: 0, critical: 0
  Total: 0 vulnerabilities across 94 deps (prod: 92, dev: 3)
```

Phase-1 deps: `@modelcontextprotocol/sdk ^1.29.0`, `ajv ^8.17.1`, `ajv-formats ^3.0.1`, `zod ^3.24.2`, `typescript ^5.8.3`, `@types/node ^22.0.0`. All current stable releases.

## Threat Model

**Assets:** Future config files at `${HOTSKILLS_CONFIG_DIR}`, project state at `<project>/.hotskills/`, cached skill content at `${HOTSKILLS_CONFIG_DIR}/cache/`. (Phase 1 does not yet read or write these.)

**Trust boundaries:**
1. Claude Code → MCP server (stdio): Claude Code controls env vars injected into the server process. `HOTSKILLS_PROJECT_CWD` = `${CLAUDE_PROJECT_DIR}` flows as untrusted path input (not yet consumed in Phase 1).
2. MCP server → external APIs (future Phase 2+): skills.sh and audit API responses will flow as untrusted data.
3. CI runner → external APIs: phase0 smoke tests reach live skills.sh + add-skill.vercel.sh from PR builds.
4. Local user → bash smoke scripts via `/tmp`: previously had a predictable-name race; now closed (see remediations).

**STRIDE attack vectors (Phase 1 only):**
- **S** (Spoofing): N/A — no auth surface yet.
- **T** (Tampering): predictable `/tmp` paths in smoke scripts allowed local symlink hijack pre-creation. **Fixed.** See remediation #2.
- **R** (Repudiation): no security event logging yet — deferred to Phase 6 logging module.
- **I** (Information Disclosure): npm audit clean; no secrets in source; CI workflows pass no secrets to phase0 jobs.
- **D** (Denial of Service): premature `hooks/hooks.json` referenced a missing script — would cause repeated 127-exit on every UserPromptSubmit/PostCompact/SessionStart event. **Fixed** by removing the file (see remediation #1). Future Ajv complexity limits tracked as `hotskills-kih`.
- **E** (Elevation of Privilege): N/A in Phase 1; activation gating is Phase 4.

## Findings

| # | Severity | Category | Finding | File(s) | Status |
|---|---|---|---|---|---|
| 1 | **MEDIUM** (consensus) | Invariants / DoS | `hooks/hooks.json` referenced `${CLAUDE_PLUGIN_ROOT}/scripts/inject-reminders.sh` which does not exist. Claude Code would invoke the missing script on UserPromptSubmit / PostCompact / SessionStart, causing 127-exit (Command Not Found) on every prompt. | `hooks/hooks.json` (commit `743e611`) | **FIXED** — file removed in this phase; re-creation in Phase 5 task 5.2 must be atomic with the inject-reminders.sh script (tracked in beads `hotskills-2u0`). |
| 2 | **MEDIUM** (consensus) | TOCTOU / Path predictability | Both `phase0-api-verify.sh` and `phase0-npx-verify.sh` used `/tmp/...-$$` (PID suffix) for temp dirs. PIDs are guessable on shared hosts; allows symlink pre-creation race. | `scripts/phase0-api-verify.sh`, `scripts/phase0-npx-verify.sh` | **FIXED** — switched both to `mktemp -d -t ...-XXXXXX` (atomic, unguessable). |
| 3 | LOW | Architecture / DoS (future) | `server/src/schemas/index.ts` uses `ajv` without depth/complexity limits. Once Phase 2+ accepts user/LLM-supplied JSON for validation, deeply nested recursive payloads could exhaust event loop. | `server/src/schemas/index.ts` | **DEFERRED** to Phase 4 (security gates initialization) — beads `hotskills-kih`. |
| 4 | LOW | Architecture / Path Traversal (future) | `.mcp.json` passes `${CLAUDE_PROJECT_DIR}` into `HOTSKILLS_PROJECT_CWD`. Phase 3 `config.ts` will use it for filesystem IO; needs canonicalization + containment checks before use. | `.mcp.json` (Phase 3 will consume it) | **DEFERRED** — beads `hotskills-rqw` (brains:phase-3) and `hotskills-2d6` (brains:phase-2 — broader env-var validation). |
| 5 | LOW | Maintainability | `server/src/schemas/index.ts` uses `as any` casts for Ajv2020 + `addFormats`. Weakens type guarantees at a security-sensitive boundary. | `server/src/schemas/index.ts` | **ACCEPTED** — current ajv 8.x types don't expose Ajv2020 ergonomically. Revisit when ajv 9 lands; not worth a wrapper module today. |
| 6 | LOW | Correctness | Schema loader assumes runtime artifact contains `dist/schemas/*.json`. Build script in `server/package.json` copies them, but no test asserts the invariant. | `server/src/schemas/index.ts`, build script | **ACCEPTED** — `npm test` exercises the validators which will fail loudly if JSONs are missing. Build covers this transitively. |
| 7 | LOW | Architecture | Phase 0 CI workflows execute bash from PR HEAD against live external services (skills.sh, add-skill.vercel.sh, npm registry). Acceptable for risk-discovery smoke tests but classifies as a non-hermetic CI dependency. | `.github/workflows/phase0-*.yml` | **ACCEPTED** — explicit design choice (RISK-FIRST). No secrets passed to these workflows; exfiltration mitigated. |
| 8 | LOW | Craftsmanship | `tools.test.ts` spawns the MCP server with ambient env inherited implicitly. Phase 1 stubs are env-independent, but tests may mask future env-sensitive behavior. | `server/src/__tests__/tools.test.ts` | **DEFERRED** — fold into `hotskills-rrz` (test coverage expansion) or revisit in Phase 3 when env vars are first consumed. |

## Remediations Applied

1. **Removed premature `hooks/hooks.json`** — `git rm hooks/hooks.json`. Phase 5 task 5.2 (beads `hotskills-nv9`) MUST re-add it in the same commit as `scripts/inject-reminders.sh` (Phase 5 task 5.1). Cleanup tracking: beads `hotskills-2u0`.
2. **Switched both phase0 smoke scripts to `mktemp -d`** — `scripts/phase0-api-verify.sh` and `scripts/phase0-npx-verify.sh` now use `mktemp -d -t ...-XXXXXX` for atomic, unguessable temp dir creation. Cleanup trap retained.

Both remediations verified:
- `npm test` → 4/4 passing (build copies schema JSONs to `dist/schemas/`).
- `bash scripts/phase0-api-verify.sh` → exit 0 (`{"status":"ok",...}`).
- `bash scripts/phase0-npx-verify.sh` → exit 1 (designed-fail, structured diagnostic per ADR-002 / `hotskills-ns3`).

## Remaining Risks

- **Future path validation** (LOW): `HOTSKILLS_PROJECT_CWD` and `HOTSKILLS_CONFIG_DIR` lack canonicalization/containment scaffolding. No exposure in Phase 1 (server doesn't consume them yet). Tracked in `hotskills-rqw` (Phase 3) and `hotskills-2d6` (Phase 2).
- **Future Ajv complexity limits** (LOW): no DoS surface today (handlers are stubs). Phase 4 must add Ajv depth/strict-type limits before accepting external JSON. Tracked in `hotskills-kih`.
- **Live-network CI** (LOW): explicit RISK-FIRST design; no secrets at risk.
- **ADR-002 re-architecture** (HIGH-impact, NOT a security issue): `skills add --target` flag absent in v1.5.1 blocks Phase 2 implementation work. Tracked in `hotskills-ns3` (`brains:needs-human`).

## Council Feedback

**Mode:** `--parallel` (star-chamber `review`).
**Providers used:** 2 of 3 — `gemini-3.1-pro` ("good"), `gpt-5.4` ("good"). `nemotron-ultra-253b` failed authentication.
**Files sent for review:** 10 (`.mcp.json`, MCP entry + schemas + tests + Phase 0 scripts + CI workflows + hooks.json).

**Convergence:** both reviewers independently flagged the same two MEDIUM-severity issues — premature `hooks/hooks.json` (DoS via missing script) and predictable `$$` PID temp dirs in phase0 scripts. Both fixed in this phase.

**Praise (representative):**
- "Clean, idiomatic TypeScript setup with precise JSON-RPC boundaries and solid test harness scaffolding via stdio."
- "JSON Schema module cleanly implements ADR-003 by evaluating single-source-of-truth JSON files at initialization time, preventing path traversal via safe `import.meta.url` resolution."
- "The Phase 1 threat model is broadly correct: the stdio MCP server exposes a small surface area, handlers are stubs with no meaningful I/O, and the highest-risk boundary remains future filesystem/network behavior rather than current tool execution."

## Verification

- `git status --porcelain` clean after this commit (modulo this report).
- `npm run build` ✓ | `npx tsc --noEmit` ✓ | `npm test` 4/4 ✓
- `bash scripts/phase0-api-verify.sh` ✓ exit 0 (live endpoints reachable)
- `bash scripts/phase0-npx-verify.sh` exit 1 (designed-fail for ADR-002 issue, tracked in `hotskills-ns3`)
- `npm audit`: 0 vulnerabilities (94 deps)
- Secrets grep: clean

## Next Steps

- Master to resolve `hotskills-ns3` (ADR-002 re-architecture) before Phase 2 implementation begins.
- Phase 5 task 5.2 must coordinate with task 5.1 to re-add `hooks/hooks.json` atomically with `inject-reminders.sh`. See `hotskills-2u0`.
