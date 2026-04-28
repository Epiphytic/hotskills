---
description: "Manage hotskills — search, activate, invoke, and audit Claude Code skills"
argument-hint: "[query] [--auto] [--source <repo>] [--whitelist <skill_id>]"
allowed-tools: Read, Write, Edit
---

# /hotskills

Browse, search, and manage Claude Code skills via the hotskills MCP
server. Without arguments, lists what's already activated for the current
project. With a query, searches skills.sh (and configured GitHub
sources) and presents a ranked picker.

## Argument parsing

`$ARGUMENTS` may contain a free-text query and/or any of the flags below
in any order. Parse them as follows:

- `--auto` — after a search, automatically call `hotskills.activate` on
  the highest-ranked result whose `gate_status === "allow"`. If none
  pass, surface the reason from the top result and do nothing.
- `--source <owner/repo>` — narrow the search via the `sources` argument
  to `hotskills.search`.
- `--whitelist <skill_id>` — bypass the security gate for `<skill_id>`
  by appending it to the per-project whitelist. **Requires explicit
  user confirmation** (see warning text below). After confirmation,
  edit `<project>/.hotskills/config.json` to add the entry to
  `security.whitelist.skills`.

Anything else in `$ARGUMENTS` is treated as the search query.

## Steps for the LLM

### Case A — no arguments

1. Call `hotskills.list({ scope: "merged" })`.
2. Render a table with columns: `skill_id`, `activated_at`,
   `description`.
3. If empty, suggest the user run `/hotskills <query>` to find a skill,
   or `/hotskills-setup` if this looks like a fresh install.
4. Otherwise, prompt: "What would you like to search for?"

### Case B — `--whitelist <skill_id>` flag present

This is a security-sensitive action. Per ADR-004 §Whitelist override
surface, you MUST display the warning below, get explicit user
confirmation, and only then mutate config.

1. Call `hotskills.audit({ skill_id, install_count })` to get the current risk
   picture. If a recent search produced an `installs` value for this skill,
   pass it as `install_count` so the install layer of the gate preview is
   evaluated honestly. Without it, the install layer is reported as
   `'skipped'` rather than fabricating a 0-count block.
2. Print this warning verbatim, filling in the bracketed slots:

   > **Whitelist warning** — you are about to bypass the security gate
   > for `[skill_id]`.
   >
   > Current risk: `[effective_risk_from_audit]` (per audit) /
   > `[heuristic_risk_or "(heuristic disabled)"]` (per heuristic).
   >
   > Adding this skill to the project whitelist will skip ALL gates —
   > audit, heuristic, install threshold — every time it is activated.
   > This is the user-controlled escape hatch from `risk_max`.
   >
   > Proceed? (y/n)

3. Wait for explicit `y`/yes response. On any other answer, abort with
   "Whitelist not modified."
4. On confirmation:
   - Read `<project>/.hotskills/config.json` (create skeleton
     `{ "version": 1 }` if absent).
   - Ensure `security.whitelist.skills` exists; append `skill_id` only
     if not already present (idempotent).
   - Write the updated config back atomically (use Write or Edit; the
     server will re-validate on next read).
5. Tell the user the whitelist entry was added and that subsequent
   `hotskills.activate` calls will bypass gates for this skill.

### Case C — query (with optional `--source` and `--auto`)

1. Call `hotskills.search({ query, sources?: [<owner/repo>], limit: 10 })`.
2. For each result, render: rank number, `skill_id`, install count,
   audit summary (e.g., `audit: snyk=safe, socket=low; effective=low`),
   `gate_status` (one of `allow` / `block` / `unknown`), one-line
   description.
3. If `--auto` was passed:
   - Find the first result with `gate_status === "allow"`.
   - If found, call `hotskills.activate({ skill_id })` and report the
     manifest path.
   - If none pass, surface the top result's gate reason and ask the
     user whether to retry with `--whitelist <skill_id>` or different
     search terms.
4. Otherwise (interactive picker):
   - Ask which to activate (by rank number or `skill_id`).
   - On selection, call `hotskills.activate({ skill_id })`.
   - If the gate returns `block`, surface the reason and offer
     `/hotskills --whitelist <skill_id>` as the override path.

## Examples

```
/hotskills react testing
/hotskills supabase --auto
/hotskills --source vercel-labs/skills
/hotskills --whitelist skills.sh:my-org/internal:custom-skill
/hotskills
```

## Notes

- This command never executes scripts itself. Activated skills produce
  materialized cache paths and SKILL.md bodies; the model invokes them
  via `hotskills.invoke`, which goes through Claude Code's standard
  Bash permission model.
- Searches are cached per ADR-002 (1h default TTL); repeated searches
  for the same query within the TTL window return `cached: true`
  without a network round-trip.
- The picker's gate-status preview is read-only — no materialization
  happens until the user (or `--auto`) calls `hotskills.activate`.
