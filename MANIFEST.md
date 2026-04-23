# Agent & Module Manifest

**Purpose:** This file acts as the single source of truth for all coding agents. It records the existing agents, available internal modules, and external integrations to prevent duplication of effort and maintain architectural consistency.
**Rule:** Agents MUST update this registry whenever a new reusable module, agent role, or external facade is created.

---

## 🤖 1. Active Agent Teams & Roles

| Agent Name | Primary Role | Trigger Condition | Capabilities / Scopes |
| :--- | :--- | :--- | :--- |
| `Grooming_Agent` | Fleshes out beads task descriptions and notes | `brains:ready-for-grooming` label on phase tasks | Read beads, write notes, swap labels |
| `Implementation_Agent` | Implements individual phase tasks | Task assigned and groomed | Read/write `server/`, `scripts/`, config files |
| `Nurture_Agent` | Post-phase quality review and cleanup | All phase impl tasks closed | Read/write repo, close beads tasks |
| `Secure_Agent` | Security review of phase changes | Nurture complete | Read-only code scan, write beads findings |

---

## 🧩 2. Module & Function Registry

| Module / Function | File Path | Description | Dependencies | Idempotent (Y/N) |
| :--- | :--- | :--- | :--- | :--- |
| *(Phase 1 modules added here as tasks complete)* | | | | |

---

## 🔌 3. External Integrations (Facades)

| Facade Name | File Path | Wrapped Library/API | Purpose |
| :--- | :--- | :--- | :--- |
| *(Phase 2 facades added here)* | | | |

---

## 📝 4. Global State & Conventions

* **Log Location:** `${HOTSKILLS_CONFIG_DIR}/logs/` (Structured JSON lines only).
* **Config Dir:** `~/.config/hotskills/` (default; overridable via `HOTSKILLS_CONFIG_DIR` env var).
* **Debug Flag:** Set `HOTSKILLS_DEBUG=true` in `.env.local` (Never commit this file).
* **Max Retries:** 3 attempts per subagent before circuit breaker triggers and escalates to user.
* **Schema Version:** `config.v1.json`, `state.v1.json` — JSON Schema draft 2020-12.
* **Skill ID Format:** `<source>:<owner>/<repo>:<slug>` (e.g., `skills.sh:vercel-labs/agent-skills:react-best-practices`).
