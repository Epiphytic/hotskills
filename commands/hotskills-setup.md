---
description: "Setup hotskills — register MCP server, initialize global config, activate find-skills, verify dependencies"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# /hotskills-setup

First-time setup for the hotskills plugin: registers the MCP server with
Claude Code (asking once whether to scope it to the current project or to
the user), initializes the global config, auto-activates the discovery
skill (`find-skills`), patches `.gitignore`, and verifies external
dependencies and APIs are reachable.

The MCP server is published to npmjs as `hotskills`, so registration
points Claude Code at `npx -y hotskills` — no local build is needed.

This command is **idempotent** — running it again on a configured machine
must not duplicate registrations or activations and must not error on
already-existing files.

## Steps for the LLM

Execute these steps in order. Surface a short progress line after each.

### 1. Register the MCP server with Claude Code

First check whether `hotskills` is already registered:

```bash
claude mcp get hotskills 2>&1
```

Parse the output:

- **If "No MCP server found"** → not registered; continue to scope prompt.
- **If `Status: ✓ Connected`** → already registered and working; skip
  registration entirely. Note the scope from the output (`Scope:` line).
- **If `Status: ✗ Failed to connect`** → registered but unhealthy. Surface
  the scope and tell the user to run `/mcp` to reconnect (or restart the
  session) after this command finishes. Skip re-registration — the entry
  exists.

When **not registered**, ask the user (via `AskUserQuestion`) which scope
to use. Use this exact question and these two options:

- **Question**: `"Where should hotskills be registered?"`
- **Header**: `"Scope"`
- **Options**:
  - `"User (recommended)"` — `"Available across all your projects. Stored in your user MCP config."`
  - `"Project (this repo)"` — `"Committed to this repo's .mcp.json — every collaborator gets hotskills when they open the repo."`

Then run the appropriate `claude mcp add` command. No env vars are
required — the server defaults `HOTSKILLS_PROJECT_CWD` to the launch
cwd (which is the project dir) and `HOTSKILLS_CONFIG_DIR` to
`${HOME}/.config/hotskills`. Override either by passing `-e KEY=value`
to `claude mcp add` only if you need a non-default location.

For **User scope** (recommended):

```bash
claude mcp add -s user hotskills -- npx -y hotskills
```

For **Project scope**:

```bash
claude mcp add -s project hotskills -- npx -y hotskills
```

After registration, **the server will not be reachable in the current
session** — Claude Code only spawns MCP servers at session boot. Tell
the user explicitly that they must run `/mcp` to reconnect, or restart
the session, before steps that need the MCP tools (e.g. step 3) can run.
Continue with the remaining filesystem-only steps.

### 2. Initialize the global config

Resolve the config dir:

```bash
CONFIG_DIR="${HOTSKILLS_CONFIG_DIR:-$HOME/.config/hotskills}"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR" 2>/dev/null || true
```

Read `${CONFIG_DIR}/config.json`. If it does not exist, create it with
the v1 defaults below (matching `server/src/schemas/config.v1.json`).
If it already exists, **do not overwrite** — only proceed.

```json
{
  "version": 1,
  "mode": "interactive",
  "opportunistic": false,
  "activated": [],
  "sources": [],
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
  },
  "cache": {
    "search_ttl_seconds": 3600,
    "audit_ttl_seconds": 86400,
    "skills_ttl_seconds": 604800
  },
  "discovery": { "find_strategy": "auto" }
}
```

### 3. Auto-activate the discovery skill

**Skip this step if step 1 just registered the server** (the server is
not reachable in this session yet — surface a one-line note to the user
and continue).

Otherwise, call the MCP tool `hotskills.activate` with:

```
{ "skill_id": "skills.sh:vercel-labs/skills:find-skills" }
```

This is idempotent (per ADR-003 §Allow-list semantics). If activation
returns a gate-block, surface the reason and continue — the discovery
skill is helpful but not required.

### 4. Initialize per-project config (only if invoked inside a git repo)

```bash
git rev-parse --is-inside-work-tree 2>/dev/null
```

If yes, and `<project>/.hotskills/config.json` does not exist, create:

```json
{ "version": 1 }
```

The MCP server fills in defaults via JSON Schema on read.

### 5. Patch `.gitignore` for the project (best-effort)

```bash
if [ -f .gitignore ] && ! grep -qxF '.hotskills/state.json' .gitignore; then
  printf '\n.hotskills/state.json\n' >> .gitignore
fi
```

### 6. Verify external tools and APIs

Check `npx` is on PATH (required to launch the MCP server):

```bash
command -v npx >/dev/null && echo "npx: $(npx --version)" || echo "npx not on PATH — install Node.js >= 22"
```

Verify reachability of the two external APIs:

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  "https://skills.sh/api/skills?query=test"
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  "https://add-skill.vercel.sh/audit?source=vercel-labs/agent-skills&skills=react-best-practices"
```

Surface non-2xx responses clearly so the user knows discovery or audit
will be degraded.

### 7. Report

Print a short summary listing:

- **MCP registration**: status (already-✓-connected / already-✗-failed /
  newly-registered-user / newly-registered-project / skipped). If a
  registration was just made or the existing entry is unhealthy, end the
  report with a callout: **"Run `/mcp` to reconnect, or restart Claude
  Code, before using hotskills tools."**
- **Global config**: path and whether it was created vs. already present.
- **find-skills activation**: invoked / skipped (with reason).
- **Project setup**: git repo detected? `.hotskills/config.json` created?
  `.gitignore` patched?
- **Dependencies**: `npx` available, skills.sh reachable, audit API
  reachable.

End with a one-line next-step suggestion: try `/hotskills` to search
for a skill once the MCP server is reconnected.

## Notes

- Never modify an existing `config.json`. To reset, delete the file and
  re-run.
- Idempotency is mandatory: every step checks for prior state before
  writing.
- The `session_id` in `state.json` is owned by the hook script
  (`SessionStart` event); this command does not write `state.json`.
- The MCP server is fetched from npmjs (`hotskills`) on first launch via
  `npx -y hotskills`, then cached. No local build is involved.
