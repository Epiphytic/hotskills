# Wrap-up: hotskills v0 (MCP server + Claude Code plugin)

**Slug:** hotskills-mcp-server
**Paused:** false
**Branch:** brains/hotskills-mcp-server
**Started:** 2026-04-23
**Finished:** 2026-04-28
**ADRs:**
- ADR-001: Plugin and MCP server foundation (`docs/adr/2026-04-23-001-plugin-and-mcp-server-foundation.md`)
- ADR-002: Discovery and vercel-skills consumption (Amendment 1: blob.ts + git sparse-checkout) (`docs/adr/2026-04-23-002-discovery-and-vercel-skills-consumption.md`)
- ADR-003: Activation dispatcher and per-project state (`docs/adr/2026-04-23-003-activation-dispatcher-and-project-state.md`)
- ADR-004: Security gating policy v0 (`docs/adr/2026-04-23-004-security-gating-policy-v0.md`)
- ADR-005: Opportunistic mode and compaction-survival hooks (Amendment 1: corrected hook format) (`docs/adr/2026-04-23-005-opportunistic-mode-and-compaction-survival.md`)

## Per-Phase Summary

### Phase 1 — Plugin scaffolding + MCP skeleton

- Tasks completed: 7/7 (1.1–1.7) + Nurture + Secure
- Highlight: phase-0 risk-first smoke tests caught the `npx skills add --target` assumption violation that drove ADR-002 Amendment 1 (materialization router via vendored `blob.ts` + git sparse-checkout instead of the skills CLI).
- Output: plugin shell + `.mcp.json` + 6 fixed tools registered as stubs; baseline MCP-stdio handshake verified.

### Phase 2 — Vendoring + skill discovery + cache layer

- Tasks completed: 9/9 + Nurture + Secure
- Highlights: materialization router (vendored `blob.ts` + git sparse-checkout) replaces skills-CLI shell-out per ADR-002 Amendment 1; 65 new tests landed; weekly `check-vendor-drift.sh` job tracks upstream `vercel-labs/skills` against pinned SHA.

### Phase 3 — Activation lifecycle + dispatcher + per-project state

- Tasks completed: 12/12 + Nurture + Secure
- Highlights: `hotskills.{activate, invoke, list, deactivate}` wired end-to-end with manifest-based idempotent re-activation; 92 new tests; URL-injection defense in github-source enumerator; `<project>/.hotskills/{config,state}.json` schemas under JSON-Schema draft 2020-12 with forward-only migration framework.

### Phase 4 — Security gate stack

- Tasks completed: 11/11 + Nurture + Secure
- Highlights: 4-layer gate (whitelist → audit → heuristic → install+author) wired into `hotskills.activate`; 95 new tests; Ajv depth/node bounds (`hotskills-kih`); CWE-117 sanitization on all log writers.

### Phase 5 — Hooks + slash commands + setup flow

- Tasks completed: 6/6 + Nurture + Secure (1 needs-human surfaced + resolved → ADR-005 Amendment 1)
- Highlights: `scripts/inject-reminders.sh` with a 14-scenario / 44-assertion bash harness (later expanded to 16 / 49 in cleanup); `commands/hotskills.md` + `commands/hotskills-setup.md`; phase-0 manual checklist for live-Claude smoke. The needs-human escalation produced ADR-005 Amendment 1 after inspecting real Claude Code plugins under `~/.claude/plugins/marketplaces/claude-plugins-official/` revealed the original hooks.json format was guesswork and the loader requires a nested-object shape.

### Phase 6 — E2E + integration tests + logging + MANIFEST + README (FINAL implementation phase)

- Tasks completed: 7/7 (6.1–6.7) + Nurture + Secure
- Highlights: `logger.ts` consolidated audit/whitelist/hook sinks; cross-component integration tests; stdio E2E (`scripts/e2e.sh` + `scripts/tests/e2e-stdio.mjs`, 8 assertions, in CI); `claude --plugin-dir` keyword + config-matrix E2Es (10 scenarios, gated behind `CI_E2E_CLAUDE=1`); MANIFEST.md fully restructured into 7 sections; one-doc README replaces scattered onboarding bits.

### Cleanup phase

- Closed: 5
  - `hotskills-rfc` — `server/scripts/run-tests.mjs` already implements recursive `*.test.js` discovery (closed as already-resolved).
  - `hotskills-wc1` — `_json_escape()` in `inject-reminders.sh` now escapes backslashes before quotes; covered by per-line JSON-validity assertion with a literal backslash in `HOTSKILLS_CONFIG_DIR`.
  - `hotskills-pzt` — 1MB cap (override via `HOTSKILLS_HOOK_MAX_JSON_BYTES`) on JSON reads in the hook script; oversize files log `config_too_large` and short-circuit; covered by 64-byte-cap assertion.
  - `hotskills-4vi` — `runActivate` now performs a single `writeProjectConfig` per call. Whitelist append + activated upsert batched at end-of-flow; whitelist-activations.log audit entry still fires upfront.
  - `hotskills-rrz` — `tools.test.ts` asserts all 6 input schemas (object type, required-field set, optional-field exclusion, `hotskills.list` scope enum + merged default) and table-driven required-field validation across activate/deactivate/invoke/audit + empty-args coverage of list.

- Deferred (with rationale captured as `bd note` on each bead):
  - `hotskills-cqz` — vendor-drift script reverse-applying patches before diffing. Non-trivial; current script already detects upstream-rename and shape-shift drift. Reopen as part of a vendor-sync improvement initiative.
  - `hotskills-may` — convert the hook bash harness to bats-core. Tooling-policy decision (adds dev dep + CI). Current 44/49-assertion bash harness is sufficient for v0 invariants and runs fast in CI. Reopen when bats becomes a project-wide standard.
  - `hotskills-40w` — stale-lock recovery semantics for `state.json` writes. Design exploration, not a bug. State.json fields are independent today (`last_compact_at`, `last_session_start_at`, `opportunistic_pending`); last-writer-wins is benign for v0. Revisit with a shared lock-primitive proposal when state grows counters or merged fields.

## Test Coverage at Final Close

- **Server (unit + integration):** 279 tests passing (`cd server && npm test`).
- **Hook script:** 49 assertions across 16 scenarios (`bash scripts/tests/inject-reminders.test.sh`).
- **Stdio E2E:** 8 protocol assertions (`bash scripts/e2e.sh`; runs in CI on every push).
- **Claude `--plugin-dir` E2E:** keyword fixtures + 10 config scenarios (`scripts/e2e-claude-keyword.sh` + `scripts/e2e-claude-config.sh`); gated behind `CI_E2E_CLAUDE=1` and not run in default CI.

## Outstanding Work

Beads still open with `brains:cleanup` (deferred):

- `hotskills-uzd` — Cleanup umbrella; closed by master after this wrap-up is acknowledged.
- `hotskills-cqz` — Vendor-drift script: reverse-apply patches before diffing. Reopen as part of vendor-sync improvements.
- `hotskills-may` — Convert hook bash tests to bats-core. Reopen when bats becomes a project-wide CI standard.
- `hotskills-40w` — Stale-lock recovery for `state.json`. Reopen with a shared lock-primitive proposal when state schema grows merged fields.

## Known Gaps and Limitations

- **Claude `--plugin-dir` E2Es are not run in default CI.** The 10-scenario suite is gated behind `CI_E2E_CLAUDE=1` because it needs a `claude` binary in PATH on the runner; phase-6 ships the wiring but live execution is opt-in.
- **Phase-0 manual smoke checklist sign-off pending.** The `docs/plans/2026-04-23-phase0-manual-smoke.md` checklist has not been executed against a live Claude Code install (no Phase-0 smoke run was attempted in this autopilot run; gates were satisfied by automated assertions).
- **Audit-API schema drift is not actively monitored.** `add-skill.vercel.sh/audit` is consumed via vendored types from `vercel-labs/skills/src/telemetry.ts`; weekly drift check covers the vendored source files but a malformed/changed audit response would only surface as a runtime parse failure (logged, then treated as no-data).
- **Skill materialization assumes well-formed SKILL.md trees.** No SHA verification against publisher signatures; `content_sha256` covers idempotency, not provenance.
- **No `hotskills clean` operation.** The materialized cache under `~/.config/hotskills/cache/` grows monotonically across activations; v1 follow-up.

## Suggested Follow-up Plans

- **Bats-based hook test harness** (revives `hotskills-may`) — once bats-core is a project-wide convention.
- **Stale-lock recovery semantics** (revives `hotskills-40w`) — couple with a shared lock-primitive abstraction extracted from `server/src/cache.ts` so the bash hook and the TS server reuse one implementation.
- **Vendor-drift reverse-apply** (revives `hotskills-cqz`) — pair with the upstream `exports`-field PR follow-up to delete vendoring entirely.
- **Live `skills.sh` integration smoke job in CI** when the API rate-limit posture allows; today the smoke scripts are gated to avoid burning the public quota.
- **v1: upstream PR for `vercel-labs/skills` `exports` field**, then swap vendoring → npm dep when merged. Tracked as a v1 work item; not a blocker for v0.
- **`hotskills clean` tool** for the materialized cache (size accounting + LRU eviction).
- **PostCompact + SessionStart live-injection verification** against a real Claude Code session (the phase-0 manual checklist), to convert the documented assumption into a recorded smoke result.
