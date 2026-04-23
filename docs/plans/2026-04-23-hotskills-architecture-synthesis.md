# Hotskills — Architecture Synthesis (Phase 1, pre-ADR)

**Date:** 2026-04-23
**Status:** Draft for star-chamber review
**Source:** Questionnaire answers + research doc + addendum corrections

This document synthesizes the architecture for hotskills v0. It is the input to the star-chamber review pass and the source for the ADR set. Decisions below are locked unless flagged DRAFT.

---

## 1. Product shape

Hotskills is a **Claude Code plugin** that ships a **bundled local MCP server** plus slash commands, hooks, and a built-in `find-skills` skill (auto-activated on setup). It does **not** reimplement skill discovery — that work lives in `vercel-labs/skills/skills/find-skills/SKILL.md`. Hotskills' value is the *pre-configuration layer* around it: persistent per-project activation, security gating against the audit API, opportunistic-mode hooks, and a dispatcher tool that lets the LLM invoke activated skills mid-turn.

### What ships in the plugin

```
hotskills/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── .mcp.json                       # declares the bundled MCP server
├── commands/
│   ├── hotskills.md                # /hotskills slash command
│   └── hotskills-setup.md          # /hotskills-setup first-time setup
├── hooks/
│   └── hooks.json                  # PostCompact, SessionStart, UserPromptSubmit
├── skills/
│   └── (none initially — find-skills is auto-activated from upstream)
├── server/                         # the MCP server (Node/TS)
│   ├── package.json
│   ├── src/
│   │   ├── index.ts                # MCP server entry; stdio transport
│   │   ├── dispatcher.ts           # hotskills.invoke routing
│   │   ├── search.ts               # cache-fronted search; wraps npx skills find
│   │   ├── activate.ts             # activation lifecycle + materialization
│   │   ├── audit.ts                # add-skill.vercel.sh/audit client
│   │   ├── heuristic.ts            # opt-in static heuristic scanner
│   │   ├── cache.ts                # TTL cache
│   │   ├── config.ts               # global + project config merge
│   │   ├── hooks-state.ts          # opportunistic-mode flag IO
│   │   └── reminders.ts            # system-reminder rendering
│   └── dist/                       # compiled output
├── vendor/
│   └── vercel-skills/              # vendored MIT-attributed modules
│       ├── ATTRIBUTION.md
│       ├── telemetry.ts            # fetchAuditData + types
│       ├── source-parser.ts
│       ├── blob.ts
│       └── types.ts
├── scripts/
│   └── npx-skills-wrapper.sh       # cache-fronted npx skills find
└── docs/{adr,plans}/
```

### Plugin → server contract

`.mcp.json`:
```json
{
  "mcpServers": {
    "hotskills": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"],
      "env": {
        "HOTSKILLS_CONFIG_DIR": "${HOME}/.config/hotskills",
        "HOTSKILLS_PROJECT_CWD": "${CLAUDE_PROJECT_DIR}"
      }
    }
  }
}
```

`.mcp.json` is used (NOT inline `mcpServers` in `plugin.json`) because the latter is silently dropped (anthropics/claude-code#16143).

---

## 2. Runtime + libraries

| Component | Choice | Why |
|---|---|---|
| Server runtime | Node.js 22 LTS | Active LTS through 2027-04-30; aligns with Claude Code; vercel-labs/skills is Node |
| Language | TypeScript 5.x | First-class MCP SDK; vendor compatibility |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.29.0 | Stable; v2 is pre-alpha |
| MCP transport | stdio (`StdioServerTransport`) | Plugin-bundled local server |
| Skill discovery | `vercel-labs/skills` find-skills SKILL.md (auto-activated) + shell-out to `npx skills find/add` | Don't reimplement; cache wrapper around it |
| Audit API client | Vendored `vercel-labs/skills/src/telemetry.ts` (`fetchAuditData`) | MIT-attributed; ~30 lines; stable schema |
| Cache | In-process LRU + on-disk JSON files under `~/.config/hotskills/cache/` | Simple; cross-session sharing |

**Vendor strategy:** copy the needed modules from `vercel-labs/skills` into `vendor/vercel-skills/` with attribution headers. In parallel, file an upstream PR adding a `package.json` `exports` field so v1 can replace the vendored copy with a normal npm dep.

---

## 3. MCP tool surface

Six fixed tools registered at server connect (no dynamic registration — Claude Code does not honor `notifications/tools/list_changed`):

| Tool | Purpose | Args |
|---|---|---|
| `hotskills.search` | Cache-fronted skill search; returns ranked candidates | `{ query, limit?, sources? }` |
| `hotskills.activate` | Run security gates, materialize skill to cache, add to project allow-list | `{ skill_id, force_whitelist? }` |
| `hotskills.deactivate` | Remove skill from project allow-list | `{ skill_id }` |
| `hotskills.list` | List active skills for current project | `{ scope?: "project"\|"global"\|"merged" }` |
| `hotskills.invoke` | Dispatcher: load skill body + materialized path; gate against allow-list | `{ skill_id, args? }` |
| `hotskills.audit` | Fetch audit data for a candidate (read-only; surfaces in picker) | `{ skill_id }` |

Tool naming uses `.` separator. Skill IDs are fully qualified: `<source>:<owner>/<repo>:<skill-slug>` (e.g., `skills.sh:vercel-labs/agent-skills:react-best-practices`).

---

## 4. Activation lifecycle (Q1.D + dependencies)

### Activation flow

```
hotskills.activate({ skill_id })
  ├─ resolve skill_id → source, owner, repo, slug
  ├─ check whitelist → if match, jump to materialize
  ├─ fetch audit (cached 24h) via add-skill.vercel.sh/audit
  ├─ apply security gate (§5)
  │   └─ on block: return error with explanation
  ├─ materialize skill directory to ~/.config/hotskills/cache/<source>/<owner>/<repo>/<slug>/
  │   └─ via npx skills add <source>@<slug> -g -y --target <cache-path>
  ├─ write manifest: {source, version, sha, audit_snapshot, activated_at}
  ├─ append to .hotskills/config.json activated[] (project) or global config
  └─ return { skill_id, path, manifest }
```

### Invocation flow (the dispatcher)

```
hotskills.invoke({ skill_id, args? })
  ├─ check skill_id is in merged allow-list (project ∪ global)
  │   └─ if not: return error "skill not activated"
  ├─ read SKILL.md from cache; substitute ${SKILL_PATH} → absolute cache dir
  ├─ enumerate scripts/ (executables) and references/ (markdown)
  ├─ return:
  │   {
  │     body: <SKILL.md body with substitutions>,
  │     path: <absolute cache dir>,
  │     scripts: [{ name, path, executable }],
  │     references: [{ name, path }],
  │     args_passed: <args>
  │   }
  └─ model uses Bash/Read tools to execute scripts and read references on its own
```

The dispatcher does NOT execute scripts itself — it returns paths and the model uses its existing tools (preserving Claude Code's existing Bash permission model and trust boundary).

### System-reminder injection (Q1.D's "C" half)

When activated skills exist for the current project, a `UserPromptSubmit` hook prepends a single compact system reminder per turn:

```
<system-reminder>
Activated hotskills (use hotskills.invoke to call):
- vercel-labs/agent-skills:react-best-practices — React + Next.js perf guidelines
- microsoft/azure-skills:azure-prepare — Azure deployment prep checklist
</system-reminder>
```

This costs ~1 line per activated skill. Cap at 20 activated skills before truncation; warn on over-cap.

---

## 5. Security gating (Q3.B)

### Default config schema (lives in `~/.config/hotskills/config.json`, overridable in project `.hotskills/config.json`)

```json
{
  "security": {
    "risk_max": "medium",
    "min_installs": 1000,
    "audit_partners": ["ath", "socket", "snyk", "zeroleaks"],
    "audit_conflict_resolution": "max",
    "no_audit_data_policy": "fallback_to_installs",
    "preferred_sources": [],
    "whitelist": { "orgs": [], "repos": [], "skills": [] },
    "heuristic": {
      "enabled": false,
      "patterns": {
        "broad_bash_glob": true,
        "write_outside_cwd": true,
        "curl_pipe_sh": true,
        "raw_network_egress": true
      }
    }
  }
}
```

### Gate stack (in order; first deny short-circuits)

1. **Whitelist:** if `skill_id` matches `whitelist.skills`, OR `owner` matches `whitelist.orgs`, OR `owner/repo` matches `whitelist.repos` → ALLOW (skips all checks; this is the user's "skip security checks" semantic)
2. **Audit fetch:** call `https://add-skill.vercel.sh/audit?source=<owner/repo>&skills=<slug>` (cached 24h)
   - If response has data for this slug:
     - Compute `effective_risk = max-by-severity(partner.risk for partner in audit_partners)`
     - If `effective_risk > risk_max` (default: `medium`) → BLOCK
   - If response has NO data for this slug (`{}`):
     - Apply `no_audit_data_policy`:
       - `fallback_to_installs` (default) → continue to step 3
       - `block` → BLOCK
       - `allow_with_warning` → continue with warning surfaced in picker
3. **Heuristic** (only if `heuristic.enabled: true`):
   - Scan `SKILL.md` `allowed-tools` frontmatter and `scripts/` content for enabled patterns
   - Map findings to synthetic `low|medium|high`
   - If `synthetic_risk > risk_max` → BLOCK with `source: "heuristic"` label
4. **Install + author gate:**
   - Allow if `installs >= min_installs`
   - OR `owner` in `preferred_sources`
   - OR `owner` in `audited_authors_allowlist` (built-in: `anthropics`, `vercel-labs`, `microsoft`, `mastra-ai`, `remotion-dev`)
   - Otherwise: BLOCK

Severity ordering: `safe < low < medium < high < critical < unknown`. `unknown` is treated as worst-case so it never auto-allows.

### Picker UX

When a user runs `/hotskills` and a candidate triggers a gate, the picker shows: `[BLOCKED — snyk:high]` and offers `--whitelist` flag to override per-skill (writes to per-project whitelist).

---

## 6. Per-project state (Q2.A)

### File: `<project>/.hotskills/config.json`

```json
{
  "version": 1,
  "mode": "interactive",
  "opportunistic": false,
  "activated": [
    {
      "skill_id": "skills.sh:vercel-labs/agent-skills:react-best-practices",
      "version": "1.5.1",
      "sha": "abc123...",
      "activated_at": "2026-04-23T10:00:00Z",
      "audit_snapshot": { "ath": "safe", "socket": "safe", "snyk": "low" }
    }
  ],
  "sources": [
    { "type": "github", "owner": "myorg", "repo": "internal-skills", "branch": "main", "preferred": true }
  ],
  "security": {
    "// override individual fields from global; merge per-key": null,
    "min_installs": 500
  }
}
```

### Precedence

- Global config: `~/.config/hotskills/config.json` (defaults; managed by `hotskills-setup`)
- Project config: `<project>/.hotskills/config.json` (overrides; managed by `/hotskills` and direct edits)
- Merge rules:
  - `activated`: union (project ∪ global), dedupe by `skill_id`
  - `sources`: union; project entries marked `preferred: true` shadow same `owner/repo` from global
  - `security.whitelist.{orgs,repos,skills}`: union
  - All other `security.*` fields: project value wins
  - `mode`, `opportunistic`: project wins
  - `cache.*`: project wins
- `.hotskills/` is in the project tree; `.hotskills/config.json` is the shareable team baseline (commit it). v1 may add `.hotskills/local.json` (gitignored) for per-user overrides.

### Hook state file: `<project>/.hotskills/state.json`

Separate from `config.json` (state is mutable per session; config is durable):

```json
{
  "opportunistic_pending": false,
  "session_id": "abc",
  "last_compact_at": "2026-04-23T10:30:00Z"
}
```

---

## 7. Discovery + caching

### find-skills as the discovery workflow

`hotskills-setup` auto-activates `skills.sh:vercel-labs/skills:find-skills` to global config. This puts the find-skills SKILL.md in the model's reach via `hotskills.invoke`, encoding the existing Step 1-6 ranking workflow (intent → leaderboard → `npx skills find` → verify install/source/stars → present → install). The dispatcher's `system-reminder` includes `find-skills` so the model is aware.

When the model calls `hotskills.search(query)`, the server **also** consults the cached find-skills output by shelling to a wrapper script:

```bash
# scripts/npx-skills-wrapper.sh
# Cache-fronted wrapper: hash query → check ~/.config/hotskills/cache/search/<hash>.json
# If fresh (<1h) return; else call npx skills find and store
```

`hotskills.search` returns:
```json
{
  "results": [
    {
      "skill_id": "skills.sh:vercel-labs/agent-skills:react-best-practices",
      "installs": 185000,
      "description": "...",
      "source_type": "skills.sh",
      "audit": { "ath": "safe", "socket": "safe", "snyk": "low" },
      "gate_status": "allow"
    }
  ],
  "cached": true,
  "cache_age_seconds": 320
}
```

### Cache TTLs (defaults; configurable per-project)

| Cache | TTL | Path |
|---|---|---|
| Search results (`hotskills.search`) | 3600s (1h) | `~/.config/hotskills/cache/search/<query-hash>.json` |
| Audit responses | 86400s (24h) | `~/.config/hotskills/cache/audit/<owner-repo>.json` |
| Materialized SKILL.md trees | 604800s (7d); manifest-checksum invalidates | `~/.config/hotskills/cache/skills/<source>/<owner>/<repo>/<slug>/` |
| Top/leaderboard | 1800s (30m) | `~/.config/hotskills/cache/top.json` |

### User-configured sources (`sources` in config)

Beyond skills.sh, users can specify GitHub orgs/repos. Discovery for these:
- `git ls-remote` to enumerate refs (cached 1h)
- Recursively walk for `SKILL.md` files at known paths (`SKILL.md`, `skills/`, `.claude/skills/`, `.agents/skills/`)
- Index minimally (slug, description from frontmatter)
- Marked `preferred: true` → win on naming collision against skills.sh; also bypass `min_installs`

---

## 8. Hooks (Q4.B + supporting)

### `hooks/hooks.json`

```json
{
  "hooks": [
    {
      "event": "PostCompact",
      "matcher": "*",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/set-opportunistic-pending.sh"
    },
    {
      "event": "SessionStart",
      "matcher": "*",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/set-opportunistic-pending.sh"
    },
    {
      "event": "UserPromptSubmit",
      "matcher": "*",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-reminders.sh"
    }
  ]
}
```

### `hooks/hooks.json` (revised — PostCompact and SessionStart now inject the reminder directly)

```json
{
  "hooks": [
    {
      "event": "PostCompact",
      "matcher": "*",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-reminders.sh --event=PostCompact"
    },
    {
      "event": "SessionStart",
      "matcher": "*",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-reminders.sh --event=SessionStart"
    },
    {
      "event": "UserPromptSubmit",
      "matcher": "*",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-reminders.sh --event=UserPromptSubmit"
    }
  ]
}
```

### Behavior

`inject-reminders.sh` is one shared script invoked from all three events. Per-event logic:

| Event | Activated-skills reminder? | Opportunistic reminder? | State change |
|---|---|---|---|
| `PostCompact` | YES — emit immediately so the model regains awareness right after context is rebuilt | YES if `opportunistic: true` (post-compaction is exactly when we want a fresh search) | Sets `opportunistic_pending: true` |
| `SessionStart` | YES — emit so the model knows from turn 1 | YES if `opportunistic: true` | Sets `opportunistic_pending: true` |
| `UserPromptSubmit` | YES — safety net; redundant with PostCompact/SessionStart on the first post-event prompt but cheap and idempotent | YES if `opportunistic_pending: true`, then clears the flag | Clears flag after firing once |

### Reminder content

**Activated-skills reminder** (always when activated skills exist for the project; emitted on all 3 events):

```
<system-reminder>
Hotskills activated for this project (call via `hotskills.invoke`):
- vercel-labs/agent-skills:react-best-practices — React + Next.js perf guidelines
- microsoft/azure-skills:azure-prepare — Azure deployment prep checklist
- vercel-labs/skills:find-skills — discover and install new skills

Use `hotskills.list` for the full list. Use `hotskills.search` to find more.
</system-reminder>
```

**Opportunistic reminder** (only when triggered):

```
<system-reminder>
Opportunistic skill discovery is enabled. If the user's prompt could benefit from
a skill you don't have activated, call `hotskills.search` with a query derived
from the prompt. If config has `mode: "auto"`, the dispatcher will activate the
top passing-gate result inline.
</system-reminder>
```

### Why this answers compaction/clear-context survival

| Scenario | What the model sees |
|---|---|
| User runs `/compact` or auto-compaction triggers | PostCompact hook fires immediately after; emits activated-skills reminder + opportunistic reminder if enabled. Model knows what's activated before its next reasoning step. |
| User runs `/clear` | If `/clear` triggers SessionStart, that hook emits the same reminders. If `/clear` does NOT trigger SessionStart (TBV in Phase 0), the next UserPromptSubmit hook still injects them. Worst case: one prompt of degraded awareness. |
| MCP server reconnects (e.g., `/restart`) | SessionStart fires; reminder emitted; activated skills are still on disk so dispatcher allow-list is intact. |
| Model continues autonomously (no user prompt) after compaction | PostCompact reminder is in context; model retains awareness. |

Hooks must be idempotent and fast (<200ms typical). All file IO uses atomic write (write temp + rename).

### Phase 0 verification items

- Confirm `PostCompact` hook stdout is injected into post-compaction context (not just shown to user). Per Claude Code hook docs this is the documented behavior; verify with a smoke test.
- Confirm `SessionStart` hook stdout is similarly injected at session-start.
- Confirm `/clear` triggers `SessionStart` (or document the gap and rely on UserPromptSubmit fallback).

---

## 9. Slash commands

### `/hotskills [query] [--auto] [--source <repo>]`

- Without args: opens picker showing already-activated skills + recent searches
- With query: runs `hotskills.search`, shows ranked candidates with audit/gate status, lets user multi-select to activate
- `--auto`: activates the top-ranked passing-gate result silently
- `--source`: scopes search to a configured source

### `/hotskills-setup`

First-time setup wizard:
- Creates `~/.config/hotskills/config.json` with defaults
- Auto-activates `find-skills` to global config
- Optionally configures sources (interactive prompt for git URLs)
- Optionally configures whitelist orgs (interactive prompt)
- Verifies the audit API + skills.sh API are reachable
- Tests `npx skills` is on PATH (warn if not)
- Writes a project-level `.hotskills/config.json` skeleton if invoked in a repo

---

## 10. Multi-source name collisions

Locked rule from research: namespace by source. Skill IDs are always fully qualified `<source>:<owner>/<repo>:<slug>`. The dispatcher rejects activate calls with ambiguous IDs. The picker disambiguates. `preferred: true` user-configured sources win on display ordering only — never on identity.

---

## 11. Failure modes + degradation

| Failure | Behavior |
|---|---|
| `add-skill.vercel.sh/audit` timeout (>3s) | Treat as no-data; apply `no_audit_data_policy`. Surface in picker. |
| `skills.sh` API unreachable | Return cached results if available; else error in picker; fall back to user-configured sources. |
| `npx skills` not on PATH | `hotskills-setup` warns; fall back to in-process git fetch via vendored `blob.ts` (limited functionality). |
| `~/.config/hotskills/` not writable | Server starts but read-only; activations refused; surface error. |
| Hook script fails | Log to `~/.config/hotskills/logs/hook.log`; continue (hooks must never block prompts). |
| Cache corruption | Detect on read (JSON parse + schema check); discard + repopulate. |
| Skill SKILL.md missing after activation | Drop from allow-list automatically; surface notice on next list call. |

---

## 12. Open items / deferred to v1

- **MCP SDK v2 migration ADR** — when v2 stable lands
- **Skills-Over-MCP WG draft** (Resources-based) — when it lands, add a Resources surface alongside the dispatcher
- **`.hotskills/local.json`** for per-user overrides on top of team-shared `config.json`
- **Heuristic scanner improvements** — feedback-driven false-positive triage; possibly LLM-assisted scoring
- **Telemetry opt-in** — usage stats to inform heuristic patterns
- **Webhook/file-watcher** for "freshness" beyond TTL cache
