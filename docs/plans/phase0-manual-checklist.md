# Phase 0 — Manual smoke-test checklist

This document tracks Phase 0 verification items that **require a live
Claude Code session** and cannot be automated in CI. Each item names
the load-bearing assumption, the source ADR, the procedure, the
pass/fail criteria, and a sign-off line for the verifier.

The CI-automated Phase 0 items live elsewhere:
- API smoke tests → `scripts/phase0-api-verify.sh`
  + `.github/workflows/phase0-api-verify.yml`
- `npx skills` behavior → `scripts/phase0-npx-verify.sh`
  + `.github/workflows/phase0-npx-verify.yml`
- Lock primitive under concurrent acquires → `scripts/phase0-lock-test.sh`
  + `.github/workflows/phase0-lock-test.yml`

**Sign-off rule:** all five items below MUST be signed off
(verifier name + ISO8601 UTC timestamp on the sign-off line) before
phase 5 nurture closure. The hook script tests in CI cover the
mechanical correctness; this checklist covers the assumptions about
how Claude Code surfaces hook stdout.

---

## Item 1 — `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_PLUGIN_ROOT}` env-var resolution

**ADR:** [ADR-001 §Phase 0 verification items](../adr/2026-04-23-001-plugin-and-mcp-server-foundation.md)

**Procedure:**

1. Install the hotskills plugin into a real Claude Code session via the
   marketplace flow (or `claude --plugin-dir <hotskills-checkout>`).
2. Open a project at a known path (e.g., `/tmp/hotskills-phase0-env`).
3. From within Claude Code, run a hotskills MCP tool that prints its
   resolved env (e.g., `hotskills.list` after temporarily wrapping the
   handler with a `console.error` of `process.env.HOTSKILLS_PROJECT_CWD`
   and `process.env.HOTSKILLS_CONFIG_DIR`). Or inspect the running
   `node server/dist/index.js` process via `cat /proc/<pid>/environ`.

**Pass:** `HOTSKILLS_PROJECT_CWD` resolves to the project directory
opened in Claude Code; `HOTSKILLS_CONFIG_DIR` resolves to
`${HOME}/.config/hotskills` (or the user's override).

**Fail:** either var is empty, literally `${CLAUDE_PROJECT_DIR}`/
`${CLAUDE_PLUGIN_ROOT}` (substitution didn't run), or points to a
directory the user did not select.

**Sign-off:** `verifier=______ date=______ result=______`

---

## Item 2 — `PostCompact` hook stdout injection into post-compact context

**ADR:** [ADR-005 §Phase 0 verification items](../adr/2026-04-23-005-opportunistic-mode-and-compaction-survival.md)

This is the load-bearing assumption that makes the entire
compaction-survival design work. Hook stdout MUST be injected into the
model's context after the compaction event (not merely shown to the
user in the terminal).

**Procedure:**

1. In a Claude Code session with hotskills installed and at least one
   skill activated (e.g., `skills.sh:vercel-labs/skills:find-skills`),
   trigger a compaction.
2. After compaction, send a prompt: *"List the skills you currently
   have available via hotskills."*

**Pass:** the model's response cites the activated skill(s) by ID
(proving it received the activated-skills `<system-reminder>` block
from the `PostCompact` hook).

**Fail:** the model says it has no awareness of activated skills, or
asks the user what skills are available.

**Sign-off:** `verifier=______ date=______ result=______`

---

## Item 3 — `SessionStart` hook stdout injection at session start

**ADR:** [ADR-005 §Phase 0 verification items](../adr/2026-04-23-005-opportunistic-mode-and-compaction-survival.md)

**Procedure:**

1. Configure a project with at least one activated skill.
2. Quit Claude Code.
3. Re-open Claude Code at the same project (fresh session).
4. As the very first user prompt, ask: *"What skills do you have
   activated via hotskills?"*

**Pass:** the model cites the activated skill(s) by ID on its first
turn (proving the `SessionStart` hook injected the reminder).

**Fail:** the model has no awareness; only learns about the activated
skills after a `UserPromptSubmit` injection on a later turn.

**Sign-off:** `verifier=______ date=______ result=______`

---

## Item 4 — `/clear` triggers `SessionStart`?

**ADR:** [ADR-005 §Phase 0 verification items](../adr/2026-04-23-005-opportunistic-mode-and-compaction-survival.md)

**Procedure:**

1. In a Claude Code session with at least one skill activated, run
   `/clear`.
2. Send the same first-turn prompt as Item 3.

**Pass:** model cites activated skills (i.e., `/clear` IS treated as
SessionStart by Claude Code's hook engine).

**Acceptable fail:** model has no awareness on the first
post-`/clear` prompt but DOES on the second turn (UserPromptSubmit
fallback caught it). Document this case explicitly — the
`UserPromptSubmit` per-turn safety net in ADR-005 was designed for
exactly this gap.

**Hard fail:** model has no awareness on the second prompt either
(would mean `UserPromptSubmit` is also missing — re-investigate).

**Sign-off:** `verifier=______ date=______ result=______`

---

## Item 5 — `${SKILL_PATH}` substitution coverage on 20 popular skills

**ADR:** [ADR-003 §Phase 0 verification items](../adr/2026-04-23-003-activation-dispatcher-and-project-state.md)

The dispatcher substitutes `${SKILL_PATH}` in returned SKILL.md
bodies with the absolute cache directory path. We need to confirm
this covers every positional use across real-world skills.

**Procedure:**

1. List the top 20 install-count skills on skills.sh (use
   `hotskills.search` or `npx skills find`).
2. For each, run `hotskills.activate` then `hotskills.invoke` and
   inspect the returned `body`.
3. Confirm every literal `${SKILL_PATH}` string in the source SKILL.md
   was replaced with the absolute cache directory path in the response.

**Pass:** zero skills surface an unsubstituted `${SKILL_PATH}` token.

**Acceptable fail:** ≤2 skills have edge cases (e.g., `${SKILL_PATH}/`
inside a fenced bash block where substitution is intentionally not
done) — document as a known v1 follow-up.

**Hard fail:** common patterns like `${SKILL_PATH}/scripts/foo.sh` or
`${SKILL_PATH}/references/bar.md` go un-substituted — this would mean
the substitution implementation has a bug.

**Sign-off:** `verifier=______ date=______ result=______`

---

## Phase 5 nurture sign-off

After all 5 items above are signed off:

`Phase 5 nurture sign-off: verifier=______ date=______`
