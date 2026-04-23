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
| `MCP server entry` | `server/src/index.ts` | Boots McpServer with stdio transport, registers 6 tools | `@modelcontextprotocol/sdk`, `tools/index.ts` | Y |
| `registerTools()` | `server/src/tools/index.ts` | Registers all 6 hotskills tools on a McpServer | per-tool `register*` modules | Y |
| `registerSearch/Activate/Deactivate/List/Invoke/Audit()` | `server/src/tools/{search,activate,deactivate,list,invoke,audit}.ts` | Phase-1 stub handlers returning `{stub: true}`; full implementations land in Phases 2–4 | `zod`, MCP SDK | Y |
| `validateConfig()` / `validateState()` | `server/src/schemas/index.ts` | ajv-compiled validators for config.v1 and state.v1 schemas | `ajv`, `ajv-formats` | Y |
| `phase0-api-verify.sh` | `scripts/phase0-api-verify.sh` | RISK-FIRST CI smoke-test for skills.sh `/api/search` and add-skill.vercel.sh `/audit` | `curl`, `node` | Y |
| `phase0-npx-verify.sh` | `scripts/phase0-npx-verify.sh` | RISK-FIRST CI smoke-test for `skills add --target` (currently fails: flag absent in v1.5.1; resolution tracked in beads `hotskills-ns3`) | `npx`, `skills` CLI | Y |

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
