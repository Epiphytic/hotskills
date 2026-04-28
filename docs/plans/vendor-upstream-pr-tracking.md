# Upstream PR tracking — vercel-labs/skills `exports` field

**Source:** ADR-002 §Vendoring requirement
> "An upstream PR adding `exports` for the vendored modules MUST be filed and tracked."

**Beads task:** `hotskills-4zz` (P3, Phase 2)
**Sync state at filing:** vercel-labs/skills@v1.5.1, SHA `bc21a37a12b90fcb5aec051c91baf5b227b704b1`

## Why this PR is needed

`vercel-labs/skills@1.5.1` ships no `main` or `exports` field in its
`package.json`. The package is distributed as a CLI binary (`bin: { skills:
./bin/skills.js }`) only, so direct `import` from the npm package does not
resolve any module path. Hotskills currently vendors a small subset of
source files under `vendor/vercel-skills/` (with MIT attribution and a
weekly drift-check workflow) to work around this.

Once upstream publishes an `exports` field for the modules we use,
hotskills v1 can drop the vendored copy and depend on the npm package
directly — eliminating the drift-check burden and license-attribution
surface.

## Target `exports` stanza

Add the following to upstream `package.json`:

```json
{
  "exports": {
    ".": {
      "default": "./bin/skills.js"
    },
    "./telemetry": {
      "types": "./dist/telemetry.d.ts",
      "import": "./dist/telemetry.js"
    },
    "./types": {
      "types": "./dist/types.d.ts",
      "import": "./dist/types.js"
    },
    "./source-parser": {
      "types": "./dist/source-parser.d.ts",
      "import": "./dist/source-parser.js"
    },
    "./blob": {
      "types": "./dist/blob.d.ts",
      "import": "./dist/blob.js"
    },
    "./find": {
      "types": "./dist/find.d.ts",
      "import": "./dist/find.js"
    },
    "./frontmatter": {
      "types": "./dist/frontmatter.d.ts",
      "import": "./dist/frontmatter.js"
    }
  }
}
```

Notes for the PR author:

- The `frontmatter` entry is included because hotskills currently inlines
  it (see `vendor/vercel-skills/patches/blob-inline-frontmatter.patch`);
  exporting it lets us drop the inline copy.
- `telemetry` exports the audit subset hotskills uses; the upstream
  module also contains the `track()` tracking surface, which we strip
  on vendor. Once exported, hotskills can do `import { fetchAuditData,
  type AuditResponse } from '@vercel-labs/skills/telemetry';` and let
  tree-shaking elide `track`.
- The `find` module exports the interactive `runFind` plus the pure
  `searchSkillsAPI`. Hotskills only uses `searchSkillsAPI`; we don't
  need `find` to be split, just exported.

## Upstream sources affected

| Vendored file | Upstream source | LOC | Purpose for hotskills |
| :--- | :--- | ---: | :--- |
| `telemetry.ts` | `src/telemetry.ts` | 154 | `fetchAuditData` audit-API client + `AuditResponse` types |
| `types.ts` | `src/types.ts` | 101 | `ParsedSource`, `Skill`, `RemoteSkill`, `AgentConfig`, `AgentType` |
| `source-parser.ts` | `src/source-parser.ts` | 419 | `parseSource`, `getOwnerRepo`, `parseOwnerRepo`, `sanitizeSubpath`, `isRepoPrivate` |
| `blob.ts` | `src/blob.ts` | 434 | `tryBlobInstall`, `fetchRepoTree`, `findSkillMdPaths`, `toSkillSlug` (skills.sh blob materialization, primary path per ADR-002 Amendment 1) |
| `find.ts` | `src/find.ts` | 353 | `searchSkillsAPI` (skills.sh search API client) |
| (inlined) | `src/frontmatter.ts` | 17 | `parseFrontmatter` (currently inlined into `vendor/vercel-skills/blob.ts`) |

## PR checklist

- [ ] **PR filed** against [vercel-labs/skills](https://github.com/vercel-labs/skills) with the `exports` stanza above. Link: ___
- [ ] **PR merged** to upstream main. Date: ___
- [ ] **Released** in a tagged version on npm. Version: ___
- [ ] **Hotskills v1 migration** — replace `vendor/vercel-skills/` imports with the npm dep, delete vendored modules, retire `server/scripts/sync-vendor.mjs`, retire `.github/workflows/vendor-drift.yml` (`hotskills-35o`).

## Open questions

- Will upstream maintain the `track()` tracking surface as part of the
  exported `telemetry` module? Hotskills explicitly removes it on
  vendor. If upstream keeps it on the export path, hotskills v1 will
  need either tree-shake reliance or a small wrapper module that
  re-exports only `fetchAuditData`.
- Does upstream prefer an `exports` shape that mirrors `src/` or one
  that consolidates internals into a single `./internals` namespace?
  Either works for hotskills; consult before opening the PR.

## Related

- ADR: `docs/adr/2026-04-23-002-discovery-and-vercel-skills-consumption.md`
- Vendor attribution: `vendor/vercel-skills/ATTRIBUTION.md`
- Drift workflow: beads task `hotskills-35o` (Phase 2, P3)
