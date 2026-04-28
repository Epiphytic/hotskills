---
description: "Setup hotskills — initialize global config, activate find-skills, verify dependencies"
allowed-tools: Bash, Read, Write, Edit
---

# /hotskills-setup

First-time setup for the hotskills plugin: initializes the global config,
auto-activates the discovery skill (`find-skills`), patches `.gitignore`
in the current project (if any), and verifies external dependencies and
APIs are reachable.

This command is **idempotent** — running it again on a configured machine
must not duplicate activations and must not error on already-existing
files. Per-user config defaults follow ADR-004 (security gating).

## Steps for the LLM

Execute these steps in order. Surface a short progress line after each.

### 1. Resolve the global config dir

The MCP server publishes the config dir via the `HOTSKILLS_CONFIG_DIR`
env var. Default is `${HOME}/.config/hotskills`. Use Bash to compute:

```bash
echo "${HOTSKILLS_CONFIG_DIR:-$HOME/.config/hotskills}"
```

Create the directory with mode `0700` if absent:

```bash
mkdir -p "${HOTSKILLS_CONFIG_DIR:-$HOME/.config/hotskills}"
chmod 700 "${HOTSKILLS_CONFIG_DIR:-$HOME/.config/hotskills}" 2>/dev/null || true
```

### 2. Write the global config (idempotent)

Read `${CONFIG_DIR}/config.json`. If it does not exist, create it with
the v1 defaults below (matching `server/src/schemas/config.v1.json`).
If it already exists, **do not overwrite** — only proceed with later
steps.

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

Call the MCP tool `hotskills.activate` with:

```
{ "skill_id": "skills.sh:vercel-labs/skills:find-skills" }
```

This is idempotent (per ADR-003 §Allow-list semantics). If the activation
returns a gate-block, surface the reason to the user and continue — the
discovery skill is helpful but not required.

### 4. Initialize per-project config (only if invoked inside a git repo)

Detect whether we're in a git repo:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null
```

If yes, and `<project>/.hotskills/config.json` does not exist, create:

```json
{ "version": 1 }
```

The MCP server will fill in defaults via JSON Schema on read.

### 5. Patch `.gitignore` for the project (best-effort)

If `<project>/.gitignore` exists and does not already contain
`.hotskills/state.json`, append it. The server also patches this on
first state write — doing it here makes the intent explicit:

```bash
if [ -f .gitignore ] && ! grep -qxF '.hotskills/state.json' .gitignore; then
  printf '\n.hotskills/state.json\n' >> .gitignore
fi
```

### 6. Verify external tools and APIs

Check `npx skills` is on PATH (warn, not error, if absent — the
discovery `find_strategy: "auto"` falls back to the API):

```bash
command -v npx && npx --no-install skills --version 2>/dev/null || echo "npx skills not on PATH"
```

Verify reachability of the two external APIs (HEAD only, no body):

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  "https://skills.sh/api/skills?query=test"
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
  "https://add-skill.vercel.sh/audit?source=vercel-labs/agent-skills&skills=react-best-practices"
```

Both should return 2xx. Surface non-2xx responses clearly so the user
knows discovery or audit will be degraded.

### 7. Report

Print a short summary listing:
- The global config path and whether it was created vs. already present
- Whether `find-skills` was activated (and the gate decision)
- Whether the project was set up (git repo detected? `.gitignore`
  patched?)
- API reachability (skills.sh, audit)
- `npx skills` availability

End by suggesting the user try `/hotskills` to search for a skill.

## Notes

- This command never modifies an existing `config.json`. If the user
  needs to reset it, they can delete the file and re-run.
- Idempotency is mandatory: every step above checks for prior state
  before writing.
- The `session_id` in `state.json` is owned by the hook script
  (`SessionStart` event); this command does not write `state.json`.
