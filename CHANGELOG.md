# Changelog

All notable changes to the `hotskills` MCP server (npm package). The plugin
manifest tracks separately in `.claude-plugin/plugin.json`.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-04-28

### Fixed
- **`hotskills.audit` returned a misleading install-gate decision.** When the
  caller didn't pass an install count, the gate preview fabricated
  `install_threshold:0:1000` — implying a real block when the layer simply
  hadn't been evaluated. The tool now accepts an optional `install_count`;
  when provided, the install layer is evaluated against `min_installs`; when
  omitted, the layer is reported as `'skipped'` and no `details.install` is
  emitted, so callers can tell "not evaluated" apart from a real block.

### Changed
- New `skipInstallGate?: boolean` option on `runGatePreview` — used by the
  audit tool but available to any caller that wants to omit the install layer
  from a gate preview.
- `/hotskills` slash command's `--whitelist` flow now passes the search-time
  `installs` value through to `hotskills.audit({ install_count })` so the
  warning's "Current risk" line is computed honestly.

## [0.1.3] — 2026-04-28

### Fixed
- **Search returned irrelevant low-install skills for multi-word queries.** The
  skills.sh API returns a schema stub for any query containing whitespace
  (`q=code+review` → empty `skills` array), so phrases like `"code review"`
  hit the cache as zero-result responses. `runSearch` now normalizes user
  queries (lowercase + collapse whitespace/`_`/`,` to `-`) before the API call,
  so `"code review"` resolves to `code-review` and surfaces e.g.
  `obra/superpowers/requesting-code-review` (~64K installs) as the top result.
- **Canonical skill IDs were malformed.** The vendored `searchSkillsAPI` mapped
  the API's `skill.id` (full `owner/repo/slug` path) onto the `slug` field,
  producing IDs like `skills.sh:obra/superpowers:obra/superpowers/requesting-code-review`.
  Replaced with a local API client that uses `skill.skillId` for the slug.
- **Schema-stub sentinel `owner/repo:skill` was the top result on some queries.**
  Now filtered out before ranking.

### Changed
- **`find_strategy: "auto"` now always picks the API**, regardless of whether
  `npx` is on PATH. The `npx skills find` CLI does substring matching on the
  slug only and misses high-install skills the API surfaces via fuzzy matching
  across name + source + slug. Set `find_strategy: "cli"` explicitly to opt back
  in.

## [0.1.2] — 2026-04-28

### Fixed
- `npx -y hotskills` failed with `sh: hotskills: Permission denied` because tsc
  emits `dist/index.js` with mode 0644 and the npm tarball preserved that mode
  through to consumers. The build now `chmod 0755 dist/index.js` before pack.

## [0.1.1] — 2026-04-28

### Fixed
- `Failed to connect` when launched via `npx -y hotskills` from a `.mcp.json`
  whose `${CLAUDE_PROJECT_DIR}` / `${HOME}` placeholders weren't expanded by
  the MCP client. The server now defaults `HOTSKILLS_PROJECT_CWD` to
  `process.cwd()` and `HOTSKILLS_CONFIG_DIR` to the home-derived default when
  the values are unset, blank, or contain unsubstituted `${...}` placeholders.

### Changed
- `.mcp.json` simplified — no env block needed; defaults cover both values.

### Added
- `scripts/e2e-npx.sh`: full JSON-RPC roundtrip against the registry tarball
  via `npx -y hotskills`, run from a blank temp project.
- `scripts/tests/e2e-stdio.mjs`: parameterized via `HOTSKILLS_E2E_CMD` /
  `HOTSKILLS_E2E_ARGS_JSON` so the same runner drives either the local node
  build or the published bin.

## [0.1.0] — 2026-04-28

### Added
- Initial public release on npm. Six MCP tools (`search`, `activate`,
  `deactivate`, `list`, `invoke`, `audit`), four-layer security gate stack,
  three Claude Code hooks, two slash commands.

[0.1.4]: https://github.com/Epiphytic/hotskills/releases/tag/v0.1.4
[0.1.3]: https://github.com/Epiphytic/hotskills/releases/tag/v0.1.3
[0.1.2]: https://github.com/Epiphytic/hotskills/releases/tag/v0.1.2
[0.1.1]: https://github.com/Epiphytic/hotskills/releases/tag/v0.1.1
[0.1.0]: https://github.com/Epiphytic/hotskills/releases/tag/v0.1.0
