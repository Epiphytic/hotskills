# ADR-003: Activation lifecycle, dispatcher contract, and per-project state

**Date:** 2026-04-23
**Status:** Accepted
**Decision makers:** liam.helmer@gmail.com (user), local subagent, star-chamber

## Context

Two coupled questions from the Phase-1 questionnaire:

1. **Q1 — Activation model.** Claude Code does not honor MCP `notifications/tools/list_changed`. The user-stated "MCP dynamic tool registration" model does not work. The chosen approach (Q1.D) is a **dispatcher tool + system-reminder injection** of activated-skill names: a single fixed `hotskills.invoke(skill_id, args)` returns the skill's body and materialized path; a `UserPromptSubmit` hook prepends a compact list of activated skills so the model knows what's available.
2. **Q2 — Per-project state storage.** Activated-skill lists, mode defaults, threshold overrides, and whitelist additions need durable, structured per-project state. The chosen approach (Q2.A) is `<project>/.hotskills/config.json`.

The user also raised: *"does this allow for execution of skill dependencies, like scripts or other things included in a skill?"* — answered yes, by materializing the full skill directory and returning paths so the model uses its existing Bash/Read tools.

## Decision

The MCP server registers six fixed tools at connect (per ADR-001). Activation is **metadata-only** — it materializes the skill directory to a deterministic cache path, runs the security gates (per ADR-004), and appends to the project allow-list in `.hotskills/config.json`. Invocation goes through `hotskills.invoke`, which returns the materialized SKILL.md body + path + script/reference enumeration. The model executes via its existing tools — hotskills NEVER runs scripts itself.

Per-project state lives in `<project>/.hotskills/config.json`. Schema is versioned with explicit migration support. State that mutates per session (opportunistic flag, session id) lives in a separate `<project>/.hotskills/state.json`.

## Requirements (RFC 2119)

### Tool surface

- `hotskills.search({query, limit?, sources?}) → {results, cached, cache_age_seconds}` MUST return ranked candidates including audit data (per ADR-004) and gate status.
- `hotskills.activate({skill_id, force_whitelist?}) → {skill_id, path, manifest}` MUST: resolve `skill_id`; run gate stack (ADR-004); on pass, materialize skill directory under cache; write manifest; append to project (or global) allow-list; return materialized path.
- `hotskills.deactivate({skill_id})` MUST remove the skill from the project allow-list (NOT global unless explicitly scoped); MUST NOT delete the cached directory.
- `hotskills.list({scope?})` MUST return activated skills for `"project"`, `"global"`, or `"merged"` (default `"merged"`).
- `hotskills.invoke({skill_id, args?})` MUST: verify `skill_id` is in the merged allow-list; read SKILL.md from cache; substitute `${SKILL_PATH}` placeholders with the absolute cache directory; enumerate `scripts/` (executable files) and `references/` (markdown files); return `{body, path, scripts, references, args_passed}`.
- `hotskills.invoke` MUST NOT execute any script, command, or external program. Script execution MUST be performed by the calling model via its existing tools (Bash, etc.) and is subject to the existing Claude Code permission model.
- `hotskills.audit({skill_id}) → AuditResponse` MUST return the cached audit data (per ADR-004 schema), surfacing it for the picker without forcing a re-fetch.

### Skill ID format

- Skill IDs MUST be of the form `<source>:<owner>/<repo>:<slug>`. Sources: `skills.sh`, `github`, `git`.
- The dispatcher MUST reject any tool call with a malformed or ambiguous skill ID.
- Activation calls referencing a skill not yet in any source MUST return an explicit error; the server MUST NOT auto-add sources.

### Materialization

- The materialized cache path MUST be `${HOTSKILLS_CONFIG_DIR}/cache/skills/<source>/<owner>/<repo>/<slug>/`.
- Materialization MUST acquire a `<dir>.lock` file before writing (per ADR-002 cache integrity rules).
- The manifest file `<dir>/.hotskills-manifest.json` MUST contain: `source`, `owner`, `repo`, `slug`, `version` (skills.sh version or git SHA), `content_sha256` (hash of SKILL.md + scripts/ + references/), `audit_snapshot` (frozen at activation time), `activated_at` (ISO8601 UTC).
- On re-activation, manifest content_sha256 mismatch MUST trigger re-materialization; matching MUST be a no-op (idempotent).

### Per-project state

- `<project>/.hotskills/config.json` MUST exist as the per-project state file. The directory MAY be auto-created on first activation.
- The config MUST include a `version` field (currently `1`); the server MUST refuse to read configs with `version` greater than the supported version, surfacing an upgrade prompt.
- Migrations between schema versions MUST be implemented as forward-only transformations in `server/src/migrations/` and applied automatically on read.
- The config MUST be the shareable team baseline (commit it). A future v1 may add `<project>/.hotskills/local.json` (gitignored) for per-user overrides; v0 has no such file.
- `<project>/.hotskills/state.json` MUST hold mutable per-session state: `opportunistic_pending`, `session_id`, `last_compact_at`, `last_session_start_at`. State.json MUST be gitignored (added to `.gitignore` automatically by `hotskills-setup` if a `.gitignore` file is present and lacks the entry).
- Global config at `${HOTSKILLS_CONFIG_DIR}/config.json` MUST be merged with project config per these rules:
  - `activated`: union (project ∪ global), dedupe by `skill_id`
  - `sources`: union; project entries marked `preferred: true` shadow same `owner/repo` from global
  - `security.whitelist.{orgs,repos,skills}`: union
  - All other `security.*` fields: project value wins
  - `mode`, `opportunistic`, `cache.*`: project wins

### State schema (v1)

- `config.json` v1 schema MUST conform to `server/src/schemas/config.v1.json` (JSON Schema). The server MUST validate on read and write.
- `state.json` v1 schema MUST conform to `server/src/schemas/state.v1.json`.
- Both schemas MUST be published under the v1 path; future versions live alongside.

### Allow-list semantics

- A skill is "activated for this session" iff its `skill_id` is in the merged allow-list.
- `hotskills.invoke` against a non-allow-listed skill MUST return an error and MUST NOT auto-activate.
- Deactivation MUST persist immediately (no buffering) to the appropriate scope.

## Rationale

- **Dispatcher + reminder is the only design that works today.** Claude Code's `list_changed` gap is load-bearing; alternatives all require session restarts or hook-only injection (which loses argument schemas).
- **Materialize-then-return-paths preserves the trust boundary.** The model executes scripts via Bash, going through Claude Code's existing per-command permission prompts. Hotskills never gains script-execution authority of its own.
- **Versioned schema with migrations.** Star-chamber flagged "future-proof" as a concern; explicit `version` field + forward-only migrations + JSON Schema validation make this safe.
- **Separate config.json and state.json.** Conflating durable team config with mutable session flags would force contradictory gitignore behavior and risk leaking session ids into commits.

## Alternatives Considered

### Pre-registered "slot" tools (`hotskills.skill_1` … `hotskills.skill_N`)
- Pros: each skill looks like a real tool.
- Cons: hard cap on N; description rewrites still need reconnect; "dispatcher in a trench coat."
- Why rejected: see Q1.B in synthesis — strictly worse than D.

### Hook-only injection (no `hotskills.invoke`)
- Pros: aligns with Skills-Over-MCP WG Resources direction.
- Cons: skills can't take typed args; only fires at prompt boundary; invisible to non-CC clients.
- Why rejected: kills mid-turn invocation; chosen as a complement (system reminder) not a replacement.

### Single combined `.hotskills.json` for both config + state
- Pros: one file.
- Cons: gitignore can't selectively ignore parts of a file; concurrent writes from hooks vs server contend; mixes durable + ephemeral state.
- Why rejected: see Q2 synthesis.

### Symlink the materialized skill into the project's `.claude/skills/`
- Pros: leverages Claude Code's native skill loading.
- Cons: bypasses the dispatcher (model would invoke the skill via its native path); loses the gate enforcement; symlinks pollute the user's project tree.
- Why rejected: defeats the activation/dispatcher model.

## Assumed Versions (SHOULD)

- JSON Schema: draft 2020-12
- Lock file primitive: `proper-lockfile` ^4.x (npm) or equivalent (decision deferred to implementation)
- Hash algorithm: SHA-256 for content_sha256

## Diagram

<!-- brains:diagram populates this section if applicable. -->

## Consequences

- ADR-004 (security gates) plugs into the activation flow; gate failures short-circuit before materialization.
- ADR-005 (hooks) reads `state.json` for opportunistic flag and reads `config.json.activated` for the system-reminder content.
- A schema migration framework becomes part of v0 even though no migrations exist yet; future evolution stays safe.
- The materialized cache becomes a durable artifact; deletion logic (`hotskills clean`) is a v1 follow-up.

### Phase 0 verification items

- Confirm `proper-lockfile` (or chosen lock primitive) works correctly across concurrent Claude Code MCP child processes (one per session).
- Confirm `${SKILL_PATH}` substitution covers all positional uses in real-world SKILL.md files (sample 20 popular skills from skills.sh).
- Smoke-test the dispatcher under skill-not-in-allow-list, skill-cache-missing, and skill-manifest-corrupted scenarios.

## Council Input

Star-chamber flagged "dispatcher contract is underspecified for non-trivial skill layouts and provenance guarantees" — addressed by: (a) explicit `${SKILL_PATH}` substitution rule; (b) manifest with `content_sha256` provenance hash; (c) explicit `scripts`/`references` enumeration in the invoke return value. Also flagged "ambiguous override and trust boundaries" — addressed by: (a) hotskills NEVER executes scripts itself; (b) all script execution flows through Claude Code's existing Bash permission model. State schema versioning + JSON Schema validation added to address "future-proof" concern.
