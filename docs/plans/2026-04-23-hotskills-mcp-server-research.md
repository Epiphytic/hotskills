# Hotskills MCP Server — Research

**Date:** 2026-04-23
**Status:** Research draft (input to Phase-1 architecture/ADR)
**Author:** research subagent

Hotskills is a Claude Code plugin wrapping a local MCP server. The plugin ships `/hotskills` and `hotskills-setup` commands; the server searches skills.sh + user-configured GitHub orgs/repos, exposes selected skills as MCP tools, and pulls skill content into context when invoked. This document captures ground truth so the Phase-1 ADR can decide transport, activation, and safety policy without re-doing the work.

---

## 1. Current stable versions

### `@modelcontextprotocol/sdk` (TypeScript)

- **Stable:** v1.x line — current **v1.29.0** (published ~late March 2026). v1.x is explicitly the recommended production line until stable v2 ships ([npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [README](https://github.com/modelcontextprotocol/typescript-sdk)).
- **Pre-release:** v2.0.0-alpha.x on `main` (pre-alpha; do not target).
- **Dynamic tool registration on the server:** `McpServer.registerTool()` / `unregisterTool()` exist, and the SDK can emit `notifications/tools/list_changed` ([DeepWiki: Tool Registration and Execution](https://deepwiki.com/modelcontextprotocol/typescript-sdk/3.2-tool-registration-and-execution)). Capability `tools.listChanged` must be declared at construction (before transport connect).

### Node.js LTS

- **Target:** Node.js **22 (Jod)** — Active LTS through 2027-04-30 ([endoflife.date](https://endoflife.date/nodejs)). Node 24 (Krypton) is acceptable (LTS through 2028-04-30). Avoid 20 — enters maintenance 2026-04-30.

### Claude Code plugin manifest

- No published numeric spec version; schema documented at [code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference). Components: skills, commands, agents, hooks, MCP servers, LSP servers, monitors. `plugin.json` metadata is `name`, `version`, `description`, `author`, `license`, `repository`.
- **MCP servers** declarable inline in `plugin.json` under `mcpServers` *or* in `.mcp.json` at plugin root. **KNOWN BUG** ([anthropics/claude-code#16143](https://github.com/anthropics/claude-code/issues/16143)): inline `mcpServers` is silently dropped during manifest parsing. Use `.mcp.json` until fixed. Use `${CLAUDE_PLUGIN_ROOT}` in `command`/`args`/`env`.

### `vercel-labs/skills`

- Repo live, **15.8k stars**, **MIT**, latest **v1.5.1** released 2026-04-17 ([github.com/vercel-labs/skills](https://github.com/vercel-labs/skills)).
- **Shape:** CLI only (`npx skills add|list|find|update|remove|init`). Targets 45+ agents. No documented Node API. Skills = directories with `SKILL.md` + YAML frontmatter (`name`, `description`, optional `metadata.internal`).
- **Discovery paths scanned:** `SKILL.md` at root, `skills/`, `.agents/skills/`, `.claude/skills/`, plus `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`. Falls back to recursive search.
- **Implication:** hotskills will shell out to `npx skills` *or* re-implement the small subset (search + git fetch SKILL.md) we need.

### skills.sh marketplace

- Live at [skills.sh](https://skills.sh); shows install counts (e.g., "find-skills: 1.2M") and trending leaderboards. **No security ratings on the public site.**
- **API backend** is open-source: [mastra-ai/skills-api](https://github.com/mastra-ai/skills-api) (MIT, ~20 commits). Endpoints: `GET /api/skills?query=`, `/api/skills/top`, `/api/skills/:skillId`, `/api/skills/:owner/:repo/:skillId`, plus `/sources`, `/owners`, `/agents`, `/stats`. **No security-rating endpoint.** Indexes 34,000+ skills from 2,800+ repos.
- Whether `skills.sh` itself hosts that API at a stable public URL is not explicitly documented — **smoke-test in Phase 0** (`curl https://skills.sh/api/skills?query=test`).
- No documented rate limits or auth. Hotskills should ship with TTL cache, descriptive User-Agent, exponential backoff.

### Deprecated / avoid

- **MCP SSE transport** — superseded by Streamable HTTP; deprecated upstream. Use stdio for local plugin-bundled servers.
- **Inline `mcpServers` in `plugin.json`** — broken (#16143).
- **MCP SDK v2-alpha.x** — pin `^1.29.0`.
- **Node.js 20** — entering maintenance.

---

## 2. Idiomatic patterns

### MCP server in Node/TS (2026)

For a Claude Code plugin-bundled server, transport is **stdio** (`StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`). Streamable HTTP is for *remote* servers; SSE is deprecated. Skeleton:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer(
  { name: "hotskills", version: "0.1.0" },
  { capabilities: { tools: { listChanged: true } } } // declare BEFORE connect
);
server.registerTool("hotskills.search", { description, inputSchema }, handler);
// later: server.registerTool(`skill.${slug}`, …) → SDK emits list_changed
await server.connect(new StdioServerTransport());
```

### Claude Code plugin layout

Mirror brains (`/home/liamhelmer/repos/epiphytic/brains/`):

- `.claude-plugin/plugin.json` — `name`, `version`, `description`, `author`, `license`, `repository`.
- `.claude-plugin/marketplace.json` — only when publishing to a marketplace.
- `skills/<name>/SKILL.md` — directory per skill, YAML frontmatter (`name`, `description`, `user-invocable`, `argument-hint`, `allowed-tools`).
- `commands/` — plain markdown commands (no SKILL.md wrapper).
- `agents/<role>.md`, `references/`, `scripts/` — see brains.
- `hooks/hooks.json` — hook declarations ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)).
- `.mcp.json` at plugin root for the bundled MCP server.

### Dynamic tool registration flow

1. Server declares `tools.listChanged: true`.
2. Client calls `tools/list` once at connect → seed tools (`hotskills.search`, `hotskills.activate`, etc.).
3. On activation, server calls `registerTool` → SDK emits `notifications/tools/list_changed`.
4. A *correct* MCP client re-calls `tools/list`. **Claude Code currently does not** — see §5.

### Plugin-shipped MCP server

`.mcp.json`:

```json
{ "mcpServers": { "hotskills": {
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"],
  "env": { "HOTSKILLS_CONFIG_DIR": "${HOME}/.config/hotskills" }
}}}
```

---

## 3. Prior art

- **[intellectronica/skillz](https://github.com/intellectronica/skillz)** (MIT, Python, 388 stars, v0.1.14, Nov 2025) — closest prior art. MCP server exposing `SKILL.md` skills as tools to any MCP client. Static discovery; no dynamic registration. Borrow the SKILL.md→tool mapping shape.
- **[bobmatnyc/mcp-skillset](https://github.com/bobmatnyc/mcp-skillset)** — Python MCP server, hybrid vector+graph RAG over skills, runtime discovery, lazy load. Patterns for context-aware recommendation and per-project state in `~/.claude/skills/`.
- **[modelcontextprotocol/experimental-ext-skills](https://github.com/modelcontextprotocol/experimental-ext-skills)** — Skills-Over-MCP Working Group incubator. Drafting a Skills Extension SEP using MCP **Resources** (not Tools). If it lands, "skill = tool" becomes legacy — track this and plan migration. ([Charter](https://modelcontextprotocol.io/community/skills-over-mcp/charter))
- **[modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps)** — separate "MCP Apps" UI ext; defines an "Agent Skills" doc but UI-focused.
- **[sparesparrow/mcp-prompts](https://github.com/sparesparrow/mcp-prompts)** — MCP prompt-template server with file/in-memory/AWS backends. Useful storage-backend abstraction.
- **[microsoft/skills](https://github.com/microsoft/skills)** — MS skill collection; non-Vercel source to support out of the box.
- **Cline Skills System** ([docs](https://docs.cline.bot/customization/skills), [DeepWiki](https://deepwiki.com/cline/cline/7.4-skills-system)) — `SKILL.md` directories, progressive loading: agent sees name+description first, body on demand. **Validates the dispatcher pattern** (see §5 item 1).
- **Cline Marketplace** — app-store UX for MCP servers; UX inspiration for the interactive picker.
- **vercel-labs/skills consumers** — beyond `mastra-ai/skills-api`, no notable downstream library wrappers identified.

---

## 4. Codebase patterns

`/home/liamhelmer/repos/epiphytic/hotskills/` confirmed essentially empty (only `.git/` plus this `docs/plans/` tree). Greenfield.

**Brains templates to copy directly:**
- `/home/liamhelmer/repos/epiphytic/brains/.claude-plugin/plugin.json` — manifest skeleton.
- `/home/liamhelmer/repos/epiphytic/brains/.claude-plugin/marketplace.json` — marketplace shape.
- `/home/liamhelmer/repos/epiphytic/brains/skills/brains/SKILL.md` — exemplary SKILL.md (frontmatter + step-structured body).
- `/home/liamhelmer/repos/epiphytic/brains/skills/setup/SKILL.md` — analogue for `hotskills-setup` (skill + `references/`).
- `/home/liamhelmer/repos/epiphytic/brains/scripts/manifest-lint.sh` — script convention.
- `/home/liamhelmer/repos/epiphytic/brains/docs/adr/2026-04-16-001-brains-token-efficiency-v03.md` — ADR template + naming.
- `/home/liamhelmer/repos/epiphytic/brains/skills/brains/references/research-summary-schema.md` — schema this doc complies with.

**Conventions:** kebab-case skill/dir names; YAML frontmatter on every SKILL.md; ADRs `YYYY-MM-DD-NNN-slug.md`; plans `YYYY-MM-DD-slug-{research,map}.md`.

---

## 5. Constraints, gotchas, open questions

**1. LOAD-BEARING: Claude Code does not honor `notifications/tools/list_changed`.** Per [#13646](https://github.com/anthropics/claude-code/issues/13646) (closed dup of [#4118](https://github.com/anthropics/claude-code/issues/4118)) and [#2722](https://github.com/anthropics/claude-code/issues/2722): the schema is defined but no handler is registered; `listTools()` runs once at connect. The "activate skill → it appears as a callable tool this turn" model **does not work** today. Fallback options: (a) seed a fixed dispatcher tool `hotskills.invoke(skill_name, args)` that internally routes — no dynamic registration needed; (b) require session restart after activation; (c) inject skill body via `UserPromptSubmit` hook on next prompt; (d) wait for upstream fix. **Recommend (a) for v0.**

**2. Opportunistic mode plumbing.** `PostCompact` exists ([hooks docs](https://code.claude.com/docs/en/hooks)) — fires after auto/manual compaction with a `compaction_trigger` field; matchers `manual`/`auto`/`*`. Combine with `SessionStart`. Hooks are shell commands and can't directly mutate MCP tool state — they should write a marker file the server polls, *or* prepend a system reminder telling the model to call `hotskills.search` on the next prompt.

**3. Filesystem access.** Plugin-bundled MCP servers run as child processes with the user's permissions; can read/write `~/.config/hotskills/` and project `.hotskills/` ([sandboxing docs](https://code.claude.com/docs/en/sandboxing)). Sandboxing protects critical-path `rm` and respects deny-rules; does not block normal IO from MCP children.

**4. skills.sh ToS / rate limits — undocumented.** Mitigations: TTL on-disk cache (~6h); descriptive User-Agent (`hotskills/<ver> (+repo)`); exponential backoff; self-host `mastra-ai/skills-api` as escape hatch.

**5. Security risk scoring on skills.sh — DOES NOT EXIST.** Confirmed: `mastra-ai/skills-api` exposes no security endpoint; skills.sh UI shows none. The "≤medium security risk" threshold is **unimplementable as stated.** Options: (a) drop for v0 and gate on install count + whitelist; (b) ship a heuristic (flag SKILL.md referencing `Bash`/`Write` with broad globs, network egress patterns); (c) integrate a third-party scanner. **Recommend (a) for v0, (b) follow-up.**

**6. Multi-source name collisions.** Same skill name from skills.sh + user-configured repo. Proposed rule: namespace by source (`skills.sh:vercel-labs/find-skills` vs. `github:myorg/myrepo:find-skills`); user-configured sources win on tie; explicit per-project pin wins absolutely.

**7. Per-project vs. global config precedence.** Project `.hotskills/config.json` overrides `~/.config/hotskills/config.json`. Activated-skill lists stored per-scope and merged (project ∪ global). Whitelisted orgs/repos union; thresholds project-overrides-global.

**8. MCP SDK v2 migration risk.** v2 stable expected within months. Pin v1.29.x; budget a follow-up ADR for v2 migration when stable.

**9. Activation latency.** Prefetch SKILL.md content at activation (not invoke); cache in `~/.config/hotskills/cache/`.

**10. Skills-Over-MCP WG draft.** The Resources-based Skills Extension SEP would make "skill = tool" legacy. Track [experimental-ext-skills](https://github.com/modelcontextprotocol/experimental-ext-skills); plan migration ADR.

**Verification failures:** `https://skills.sh/api/...` public hostname not confirmed in this pass; MCP TypeScript SDK release-page fetch returned only pre-alpha entries (the v1.29.0 number comes from npm + the README). Both should be smoke-tested in implementation Phase 0.

---

```yaml
research-summary:
  libraries-and-versions: |
    - @modelcontextprotocol/sdk 1.29.0 (TypeScript MCP SDK; pin ^1.29.0; v2 is pre-alpha)
    - Node.js 22 LTS (Jod, supported through 2027-04-30); Node 24 LTS acceptable
    - vercel-labs/skills 1.5.1 (CLI; MIT; shell out — no Node API)
    - mastra-ai/skills-api (skills.sh backend; MIT; self-host fallback)
    - Claude Code plugin manifest: no numeric spec version; see §1
  deprecated-apis-to-avoid: |
    - MCP SSE transport (deprecated; use stdio for local, Streamable HTTP for remote)
    - Inline mcpServers in plugin.json (silently dropped — anthropics/claude-code#16143; use .mcp.json)
    - @modelcontextprotocol/sdk v2.0.0-alpha.x (pre-alpha; breaking changes)
    - Node.js 20 (enters maintenance 2026-04-30)
  codebase-patterns: |
    - Greenfield repo (only .git/); mirror brains plugin layout
    - Templates: brains/.claude-plugin/{plugin,marketplace}.json, brains/skills/{brains,setup}/SKILL.md
    - Conventions: kebab-case skills, SKILL.md + YAML frontmatter, docs/adr/YYYY-MM-DD-NNN-slug.md, docs/plans/YYYY-MM-DD-slug-{research,map}.md
    - .mcp.json at plugin root for MCP server declaration; ${CLAUDE_PLUGIN_ROOT} for paths
  prior-art: |
    - intellectronica/skillz — MCP server exposing SKILL.md as tools (closest prior art; static)
    - bobmatnyc/mcp-skillset — RAG-driven dynamic skill discovery
    - modelcontextprotocol/experimental-ext-skills — Skills-Over-MCP WG (Resources-based draft; future-proof concern)
    - Cline Skills System — progressive loading: name+description first, body on demand (validates dispatcher pattern)
    - sparesparrow/mcp-prompts — backend-abstraction pattern for prompt storage
  constraints: |
    - LOAD-BEARING: Claude Code does NOT honor notifications/tools/list_changed (#13646, #4118, #2722) — must use a fixed dispatcher tool, not true dynamic registration
    - skills.sh has NO security-rating API — "≤medium security risk" threshold unimplementable as stated; gate on install count + whitelist for v0
    - Use PostCompact + SessionStart hooks for opportunistic mode (PostCompact now exists)
    - skills.sh public hostname/rate-limits unverified; need TTL cache + polite client + self-host escape hatch
    - Multi-source name collisions need explicit namespacing rule (source:owner/repo:name)
```

## §6. Addendum 2026-04-23 — Audits and Leaderboard

Targeted re-verification of two surfaces missed in the first pass.

### A. Audits — `https://skills.sh/audits`

The page **does exist** (HTTP 200; `<title>Security Audits | Skills</title>`; canonical `https://skills.sh/audits`). It is a Next.js-rendered table titled "Combined security audit results from Gen Agent Trust Hub, Socket, and Snyk." Each row shows: skill name, repo (`owner/repo`), Trust Hub verdict (e.g. "Safe"), Socket alert count (almost all "0 alerts"), and Snyk risk level (categorical: **Low / Medium / High / Critical**). No CVE refs, no scope ratings (filesystem/network/shell), no free-form notes — just three vendor verdicts plus the categorical Snyk level. Counts in the rendered HTML: 61× "Safe", 49× "0 alerts", 31× Low, 4× Critical, 3× High, 0 Medium visible.

**Coverage is small.** Only 50 audit rows render and `?page=2` returns the same payload (no pagination). Audited repos span exactly 8 sources: `anthropics/skills`, `microsoft/azure-skills`, `microsoft/github-copilot-for-azure`, `remotion-dev/skills`, `soultrace-ai/soultrace-skill`, `vercel-labs/{agent-browser,agent-skills,skills}`. Against a 91,024-skill corpus this is **<0.1% coverage** — effectively a curated badge list for a few vendor repos, not a corpus-wide gate. Per-skill URL pattern is `/<owner>/<repo>/<skillId>` (e.g. `/microsoft/azure-skills/azure-prepare` → 200, embeds the same Trust-Hub/Socket/Snyk badges); there is no `/audits/<owner>/<repo>/<skillId>` route (404).

**No JSON API.** All probed endpoints 404: `/api/audits`, `/api/audits/:owner/:repo/:skillId`, `/api/skills/:owner/:repo/:skillId/audit`, `/api/v1/audits`, `api.skills.sh/audits`. The `mastra-ai/skills-api` source (`src/routes/{admin,index,skills}.ts`) contains zero matches for "audit" — confirmed via `gh api search/code`. README enumerates every endpoint; none are audit-related. **Audits are skills.sh frontend-only; HTML scrape is the only path.** Auditor identity (Snyk, Socket, Gen Agent Trust Hub) implies automated third-party scans, not community submissions.

### B. Leaderboard / "recommended"

`https://skills.sh/leaderboard` **404s.** The leaderboard *is* the home page (`https://skills.sh/`) with three tabs: **All Time** (`/`, 91,024 skills, ranked by total installs), **Trending (24h)** (`/trending`), and **Hot** (`/hot`, format `N+Δ` showing 1-hour delta). **There is no category/area axis** — no security/frontend/code-review tabs, no `?category=` filter, only free-text search. "Recommended" is not a separate concept anywhere on the site.

The backing API endpoint `GET /api/skills/top` exists in `mastra-ai/skills-api` `src/routes/skills.ts:128` but accepts only `limit` — **no category/area parameter, no trending or hot routes**. Ranking signal everywhere is install count (with time-window variants for trending/hot). `/api/skills?sortBy=installs&sortOrder=desc` is the documented equivalent.

### Updated v0 recommendations

- **Security gate:** Drop "≤ medium severity" as a corpus-wide filter — it is unenforceable for ~99.9% of skills. Instead: (1) hard-block any skill where the audits page shows Snyk **High/Critical** (scrape the 50-row table on cold start, cache 24h); (2) prefer install-count threshold + author allowlist (anthropics, vercel-labs, microsoft, mastra-ai) as the real trust signal; (3) keep a user-extensible deny/allow list in plugin settings.
- **`--auto` ranking:** "Highest-ranked skill" = top result of `GET /api/skills?query=<intent>&sortBy=installs&sortOrder=desc&pageSize=10`, not `/api/skills/top` (which ignores the query). For intent-to-skill matching, do client-side semantic re-rank over the top-N install-sorted matches; do not rely on a category taxonomy because skills.sh has none.

---

## §7. CORRECTION 2026-04-23 — Audit API exists at add-skill.vercel.sh

**§6's "no audit API" claim is WRONG.** The real audit endpoint lives on a different host: `https://add-skill.vercel.sh/audit?source=<owner/repo>&skills=<csv-of-slugs>` (smoke-tested OK; Phase-1 questionnaire). Implementation: `vercel-labs/skills` `src/telemetry.ts:97` (`fetchAuditData`); types at `src/telemetry.ts:80-89`.

**Schema:**
```ts
type PartnerAudit = { risk: 'safe'|'low'|'medium'|'high'|'critical'|'unknown'; alerts?: number; score?: number; analyzedAt: string };
type SkillAuditData = Record<string /*partner: ath|socket|snyk|zeroleaks*/, PartnerAudit>;
type AuditResponse = Record<string /*skillSlug*/, SkillAuditData>;
```

**Confirmed partners in live responses:** `ath` (Gen Agent Trust Hub), `socket`, `snyk`, `zeroleaks`. Coverage is partial — many skills return `{}`, but it extends well beyond the 50 rows on the HTML `/audits` page (the per-skill audit displayed inside vercel-labs/skills's `add` flow works for arbitrary `source` values).

**Implication for v0:** the full `safe|low|medium|high|critical` scale is queryable per skill. The user's stated "max medium risk scope" gate is **implementable as stated** — it was unimplementable only under the wrong-endpoint assumption. v0 hard-blocks when ANY partner reports above the configured `risk_max` (default `medium`). Conflict resolution: max-of-partners (worst signal wins). Skills returning `{}` (no audit data) fall back to install-count + author-allowlist gate.

## §8. CORRECTION 2026-04-23 — vercel-labs/skills as a library

`vercel-labs/skills` (MIT, v1.5.1) ships with no `main`/`exports` field in `package.json` — it's a CLI binary only (`bin: skills, add-skill`). Direct npm import does not work. Two viable consumption strategies:

1. **Vendor the needed modules** under `vendor/vercel-skills/` with attribution headers (MIT-permitted): `telemetry.ts` (audit subset), `types.ts`, `source-parser.ts`, `blob.ts` (skills.sh download API), `find.ts` (search). ~5-6 files, ~500-1000 LOC.
2. **Upstream PR adding `exports`** for those modules; consume as a normal npm dep once merged. Cleaner long-term but depends on upstream merge timing.

**Recommended hybrid:** ship v0 with vendored modules + upstream PR in flight. CLI actions (`add`, `list`, `update`, `find`) shell out to `npx skills` since reimplementing install/symlink/lock logic is 80% of the package. Cache wrapper around `npx skills find` provides the 1h-TTL search cache.
