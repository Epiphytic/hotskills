# Hotskills config migrations

This directory holds the forward-only schema migration framework for
`<project>/.hotskills/config.json` and `<project>/.hotskills/state.json`.
Per ADR-003, configs ship with a `version` field; readers run any
registered migrations between the persisted version and the supported
target version before validation.

## When to add a migration

Add a migration when a schema change is **not** a pure-additive default:

- Renaming a field.
- Removing a field whose absence changes behavior.
- Changing the type or units of an existing field.
- Restructuring nested objects.

Pure-additive changes (a new optional field with a safe default applied at
read time in `config.ts`) do NOT require a migration — bump the supported
target version only when the new field's *presence* is load-bearing.

## How to add a migration

1. Add a new file `src/schemas/config.v<N>.json` describing the new shape.
2. Add a JSON Schema validator in `src/schemas/index.ts`.
3. Register the migration in this directory:

   ```ts
   import { registerMigration } from './index.js';

   registerMigration({
     from: 1,
     to: 2,
     apply: (raw) => {
       const r = raw as Record<string, unknown>;
       return {
         ...r,
         version: 2,
         newField: deriveDefaultFor(r),
       };
     },
   });
   ```

4. Bump the `targetVersion` constant in `src/config.ts`.
5. Add tests covering: a v1 config upgrades to v2 correctly, a v2 config is
   unchanged, a v3 config (future) throws `UnsupportedVersionError`.

## Constraints

- **Forward-only.** Once shipped, migrations are never edited. Add new
  migrations in front of the existing chain.
- **Single-step.** Each migration must increment `to` by exactly 1.
  Multi-version jumps split into a chain.
- **Pure.** `apply` must not touch the filesystem, network, or environment.
  It receives the raw post-`JSON.parse` object and returns the
  next-version shape.
- **Idempotent at target.** Reading a config that already matches the
  target version is a zero-cost identity operation.

## Where migrations are run

Every read in `src/config.ts` calls `runMigrations(raw, targetVersion)`
**before** schema validation. If the raw data was upgraded, the upgraded
form is atomically written back to disk after validation passes.
