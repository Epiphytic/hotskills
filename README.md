# hotskills

Pre-configured skill management for Claude Code — discover, activate, and invoke skills from [skills.sh](https://skills.sh) and GitHub with built-in security gating, audit-API integration, and per-project allow-lists.

## Status

v0 — usable on the development branch (`brains/hotskills-mcp-server`). All six MCP tools, the four-layer security gate stack, the three Claude Code hooks, and the two slash commands are wired up. Full test coverage: 274 server tests + 44 hook bash assertions + an automated stdio E2E.

## Install

In Claude Code:

```
/plugin install <path-to-this-repo>
```

Or for one-off use without permanent install:

```
claude --plugin-dir <path-to-this-repo>
```

You'll see five new things in the session:

- The `hotskills` MCP server with six tools (`hotskills.search`, `.activate`, `.deactivate`, `.list`, `.invoke`, `.audit`).
- Two slash commands: `/hotskills` and `/hotskills-setup`.
- Three hooks (`PostCompact`, `SessionStart`, `UserPromptSubmit`) that re-inject the activated-skills reminder so the model retains awareness across compaction.

## First-time setup

Run once per machine:

```
/hotskills-setup
```

This creates `~/.config/hotskills/config.json` with a sensible default security policy, auto-activates `vercel-labs/skills:find-skills` globally, patches your project's `.gitignore` to exclude `.hotskills/state.json`, and verifies that the audit API + skills.sh API are reachable.

## Prerequisites

- **Node.js ≥ 22** — the MCP server is ESM with native node:test.
- **`git` ≥ 2.25** — only required if you configure GitHub-typed sources (uses `--filter=blob:none --sparse`).
- **`npx` (optional)** — when present, hotskills.search prefers `npx skills find` for local-first discovery; falls back to the skills.sh search API otherwise.
- **`jq`** — required by the hook script (`scripts/inject-reminders.sh`).

## How it works

1. **Discovery.** `hotskills.search "react"` queries skills.sh (via API or `npx skills find`) and decorates each result with audit data and a gate preview. Results are cached on disk for 1 hour.
2. **Security gating.** `hotskills.activate` runs the four-layer gate stack: whitelist → audit (snyk/socket/etc.) → heuristic (opt-in static scanner) → install threshold + author allowlist. First BLOCK short-circuits.
3. **Materialization.** Allowed skills are materialized to `~/.config/hotskills/cache/skills/<source>/<owner>/<repo>/<slug>/` — using vendored `blob.ts` for `skills.sh:` IDs or `git sparse-checkout` for `github:` IDs.
4. **Manifest fast-path.** Re-activation with the same content SHA-256 returns `reused: true` without any network. Concurrent activators converge on a single materialization via O_EXCL locks.
5. **Allow-list persistence.** Activated skills are written to `<project>/.hotskills/config.json`. State (opportunistic flag, session id) lives in `state.json` (gitignored).
6. **Compaction-survival.** A hook script emits `<system-reminder>` blocks on `PostCompact`, `SessionStart`, and `UserPromptSubmit` so the model keeps awareness of activated skills after `/clear` or context compaction.

## Tools

| Tool | Purpose |
| :--- | :--- |
| `hotskills.search { query, sources?, limit? }` | Cache-first ranked search; returns skill_id, installs, audit, gate_status |
| `hotskills.activate { skill_id, install_count?, force_whitelist? }` | Gate → materialize → manifest → allow-list. Returns `{skill_id, path, manifest, reused}` |
| `hotskills.invoke { skill_id }` | Reads SKILL.md, substitutes `${SKILL_PATH}`, enumerates scripts/ + references/ |
| `hotskills.list { scope? }` | Activated skills (`project`, `global`, or `merged`) |
| `hotskills.deactivate { skill_id, scope? }` | Removes from allow-list; cache directory is preserved |
| `hotskills.audit { skill_id }` | Cached audit data + gate preview |

## Slash commands

- `/hotskills` (no args) — show activated skills for the current project, prompt for a query.
- `/hotskills [query]` — ranked search with audit/gate status.
- `/hotskills [query] --auto` — auto-activate the top gate-passing result.
- `/hotskills [query] --source <owner/repo>` — restrict search to a single source.
- `/hotskills --whitelist <skill_id>` — bypass all gates for one skill (with mandatory warning).
- `/hotskills-setup` — first-time onboarding (idempotent on re-run).

## Hooks

| Event | Behavior |
| :--- | :--- |
| `PostCompact` | Emit activated-skills reminder; emit opportunistic reminder if `opportunistic: true`; update `last_compact_at` |
| `SessionStart` | Same as PostCompact, plus refresh `session_id`, update `last_session_start_at` |
| `UserPromptSubmit` | Emit activated-skills reminder (always when allow-list non-empty); emit opportunistic reminder if `opportunistic_pending: true` then clear flag |

The hook script (`scripts/inject-reminders.sh`) caps enumeration at 20 entries (most-recently-activated first), truncates descriptions to 80 chars, and runs in <200ms typical case. All IO failures log to `~/.config/hotskills/logs/hook.log` and exit zero — a hook MUST NOT block prompts.

## Security model (v0)

The gate stack runs in a fixed order; the first BLOCK short-circuits subsequent layers.

1. **Whitelist** — `security.whitelist.{skills,repos,orgs}`. Match → ALLOW; logs to `whitelist-activations.log`.
2. **Audit** — fetches partner data (Snyk/Socket/etc.) from `add-skill.vercel.sh/audit`. `effectiveRisk = max(partners)`; compared against `security.risk_max`. Honors `no_audit_data_policy` (`fallback_to_installs` default, `block`, `allow_with_warning`).
3. **Heuristic (opt-in)** — `security.heuristic.enabled: true` runs a 4-pattern static scanner: broad bash globs, write-outside-cwd, `curl|sh`, raw network egress. 100ms per-file timeout.
4. **Install + author** — `installs >= security.min_installs`, `owner` in `security.preferred_sources`, or built-in `audited_authors_allowlist` (`anthropics`, `vercel-labs`, `microsoft`, `mastra-ai`, `remotion-dev`).

Audit responses are cached for 24h. Whitelist matches are append-only logged. Block reasons are surfaced to the tool caller and to the model so the user can see exactly which layer fired.

## Configuration

Two files; project wins for scalars, union wins for lists.

**Global** — `~/.config/hotskills/config.json`:

```json
{
  "version": 1,
  "mode": "interactive",
  "opportunistic": false,
  "discovery": { "find_strategy": "auto" },
  "security": {
    "min_installs": 1000,
    "risk_max": "medium",
    "audit_conflict_resolution": "max",
    "no_audit_data_policy": "fallback_to_installs",
    "heuristic": { "enabled": false },
    "whitelist": { "skills": [], "repos": [], "orgs": [] }
  },
  "sources": [
    { "type": "skills.sh", "preferred": false }
  ],
  "activated": []
}
```

**Per-project** — `<repo>/.hotskills/config.json` (same shape; only override what you need to). The merge rules (per ADR-003 §Per-project state):

- `activated`, `sources`, `security.whitelist.{skills,repos,orgs}` → union (project ∪ global), deduped.
- `security.{min_installs,risk_max,heuristic.enabled,...}` and `mode`, `opportunistic`, `discovery.find_strategy` → project-wins-when-defined.

`<repo>/.hotskills/state.json` is gitignored and tracks the opportunistic flag, session id, and timestamps.

## Troubleshooting

| Symptom | Probable cause | Fix |
| :--- | :--- | :--- |
| `audit API unreachable` | `add-skill.vercel.sh` is down or DNS-blocked | Set `security.no_audit_data_policy: "fallback_to_installs"` (default) — activation continues using install threshold alone |
| `npx not on PATH` warning at setup | Node is installed without npm shims | hotskills falls back to `find_strategy: "api"` automatically; ignore the warning |
| `lock timeout (30000ms)` | A previous activation crashed mid-write | Remove the stale lock: `rm ~/.config/hotskills/cache/skills/<source>/<owner>/<repo>/<slug>.lock` |
| `git --version too old (need >= 2.25)` | System git is older than sparse-checkout support | Upgrade git, or remove `github:` sources from your config |
| `gate_blocked: install_threshold:N:M` | Skill has fewer than `min_installs` and isn't in the author allowlist | Lower `security.min_installs` for that project, or add `force_whitelist: true` to the activate call (after reviewing the warning) |
| Activated skills disappear after `/clear` | Hook script not loading | Verify `hooks/hooks.json` is loaded: `claude --plugin-dir <repo> --print "/hotskills"` should show the activated list |
| `cache_missing` on invoke | User deleted `~/.config/hotskills/cache/...` | Re-activate: `hotskills.activate { skill_id }` |

## Development

```sh
cd server
npm install
npm run build
npm test          # runs all 274 tests
```

End-to-end against the real MCP server over stdio:

```sh
npm --prefix server run build
bash scripts/e2e.sh
```

The two `claude --plugin-dir` E2E flows are gated behind `CI_E2E_CLAUDE=1`:

```sh
CI_E2E_CLAUDE=1 bash scripts/e2e-claude-keyword.sh
CI_E2E_CLAUDE=1 bash scripts/e2e-claude-config.sh
```

## ADRs

The design decisions are documented in `docs/adr/`:

- ADR-001 — Plugin and MCP server foundation
- ADR-002 — Discovery and Vercel skills consumption (with materialization Amendment)
- ADR-003 — Activation dispatcher and project state
- ADR-004 — Security gating policy v0
- ADR-005 — Opportunistic mode and compaction survival (with hook-format Amendment)

Read them in order if you want the rationale; the README above is sufficient to use the plugin.

## License

MIT.
