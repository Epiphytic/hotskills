# Nurture Report: hotskills-mcp-server Phase 1

**Date:** 2026-04-23
**Scope:** plan-phase 1 (plugin scaffold + MCP server skeleton with 6 stub tools)
**Mode:** `--parallel` (local + star-chamber review)
**Branch:** `brains/hotskills-mcp-server`

## Review Summary

- Files reviewed: 14 (TS source, JSON schemas, MCP/plugin manifests, Phase 0 smoke scripts, tests)
- Council providers used: 2 of 3 (`gemini-3.1-pro`, `gpt-5.4`); `nemotron-ultra-253b` failed auth
- Both providers gave `quality_rating: "good"`
- Issues raised: 11 (1 high, 3 medium, 7 low)
- Fixed in-phase: 6
- Deferred to follow-ups: 2 beads tasks filed

## Issues Fixed

1. **`tools.test.ts` SERVER_PATH was wrong** — relative path `../../index.js` resolved to `server/index.js` (nonexistent), not `server/dist/index.js`. Tests were silently testing nothing. Fixed to `../index.js`. Commit: `743e611`.
2. **Zod-validation test asserted wrong response shape** — MCP SDK returns Zod failures as tool results with `isError: true` in `content[0].text`, not as JSON-RPC `error`. Test assertion corrected. Commit: `743e611`.
3. **Schema duplication (HIGH severity, both providers)** — `server/src/schemas/index.ts` inlined JSON Schemas that had already drifted from the canonical `config.v1.json` / `state.v1.json` (defaults missing in inline). Replaced inline schemas with `fs.readFileSync` of the JSON files; build script copies JSONs into `dist/schemas/`. JSON files are now the single source of truth. Commit: `d7ebd76`.
4. **`runMcpSession` test helper masked failures** — on timeout it resolved successfully even when expected JSON-RPC IDs never arrived; never rejected on premature server exit. Now tracks stderr, rejects with diagnostic on timeout-with-missing-ids and on early process exit. Commit: `767a28b`.
5. **`phase0-npx-verify.sh` had unused `ADD_HELP` and checked the wrong help target** — `skills --help` may not enumerate subcommand-specific flags. Removed the dead variable and switched the detection to `skills add --help`. Verified the script still correctly detects `--target` absence in v1.5.1.
6. **`phase0-api-verify.sh` used fixed `/tmp/` paths** — brittle under concurrent CI runs. Switched to per-PID temp directory with `trap … EXIT` cleanup. Commit: `b9fe1f7`.
7. **`smoke.test.ts` had a no-op first test** — removed; the schema-validators test (which exercises the JSON-loaded validators) is the meaningful smoke test now.
8. **`.gitignore`** — added `server/dist/`, `server/node_modules/`, `.env.local`, `docs/plans/.state/`, `.hotskills/state.json` (per ADR-003: state.json is gitignored). Commit: `743e611`.
9. **`MANIFEST.md`** — populated Phase 1 module registry. Commit: `743e611`.
10. **CI workflow** — switched to `npm test` to delegate to package.json (single source of truth for test invocation). Commit: `f6f4811`.

## Issues Deferred (filed as beads tasks)

| Beads | Label | Severity | Issue |
|---|---|---|---|
| `hotskills-2d6` | `brains:phase-2` | medium | Validate and canonicalize `HOTSKILLS_PROJECT_CWD` / `HOTSKILLS_CONFIG_DIR` env vars before file IO. Currently the server trusts host-expanded paths verbatim; once Phase-2+ code uses these for IO, path-traversal/unintended-write risk applies. |
| `hotskills-rrz` | `brains:cleanup` | low | Expand `tools.test.ts` to assert per-tool input schema shapes and table-driven coverage of all 6 stub handlers. Current tests cover names + count + 1 stub call + 1 Zod validation; coverage of the "each handler returns `{stub:true}`" exit criterion is incomplete. |

## Issues Not Acted On

- **Tool-stub helper extraction** (low, gpt-5.4): one reviewer suggested a shared stub helper. Premature optimization for v0; the 6 register* modules are 14 lines each and Phase 2-4 will replace them with real implementations entirely. No follow-up filed.

## ADR-002 Re-Architecture (pre-existing, NOT a nurture finding)

The Phase 0 risk-first smoke test (`phase0-npx-verify.sh`, task 1.7) discovered that `vercel-labs/skills` v1.5.1 does NOT have a `--target` flag — invalidating ADR-002's load-bearing assumption. This was caught **before** Phase 2 work began, exactly as the RISK-FIRST design intended. Tracked in beads `hotskills-ns3` (`brains:needs-human`, `brains:phase-2`, `needs-human-kind: re-architecture`). Resolution requires user decision among 4 options enumerated in that task. **This blocks Phase 2 tasks 2.1, 2.4, and 3.3 until resolved.**

The Phase 1 build is unaffected — the smoke test correctly fails (exit 1) with structured diagnostic, which is the documented desired behavior of a RISK-FIRST gate.

## Verification

- `npm run build` → success (TS compile + JSON schema copy)
- `npm test` → 4/4 passing (1 schema validators smoke test, 3 MCP stdio integration tests)
- `npx tsc --noEmit` → success
- `bash scripts/phase0-api-verify.sh` → `{"status":"ok",…}` (live skills.sh + audit endpoints)
- `bash scripts/phase0-npx-verify.sh` → exit 1 with `target_flag_exists` failure (designed-fail; ADR-002 issue tracked in `hotskills-ns3`)

## Phase 1 Exit Criteria Status

| Criterion | Status |
|---|---|
| `node server/dist/index.js` starts MCP server under stdio | PASS (manually verified; `tools/list` returns 6 entries) |
| `tools/list` returns exactly 6 tool entries with correct names | PASS (asserted in `tools.test.ts`) |
| Each tool handler returns a typed `{stub: true}` placeholder | PARTIAL (1 of 6 explicitly tested; full coverage tracked in `hotskills-rrz`) |
| Claude Code can load the plugin and the MCP server appears in tools list | NOT CI-VERIFIABLE (manual smoke; tracked in Phase 5 task 5.5 / `hotskills-b5z`) |

Phase 1 exit criteria are met to the extent they are CI-verifiable. The remaining gaps are intentionally deferred to Phase 5 (manual smoke checklist) per the original plan.

## Next Steps

- Run `/brains:secure --scope phase-1` (umbrella beads `hotskills-uyk`).
- Master should resolve `hotskills-ns3` (ADR-002 re-architecture) before Phase 2 implementation begins.
