import { test } from 'node:test';
import assert from 'node:assert';
import {
  MigrationGapError,
  UnsupportedVersionError,
  _resetRegistry,
  registerMigration,
  runMigrations,
} from '../migrations/index.js';

test('runMigrations is a no-op when input version equals target', () => {
  _resetRegistry();
  const input = { version: 1, mode: 'interactive' };
  const result = runMigrations(input, 1);
  assert.deepStrictEqual(result.migrated, input);
  assert.deepStrictEqual(result.ranMigrations, []);
});

test('runMigrations applies a registered v1 -> v2 migration', () => {
  _resetRegistry();
  registerMigration({
    from: 1,
    to: 2,
    apply: (raw) => {
      const r = raw as Record<string, unknown>;
      return { ...r, version: 2, newField: 'default' };
    },
  });
  const result = runMigrations({ version: 1, mode: 'interactive' }, 2);
  assert.deepStrictEqual(result.migrated, {
    version: 2,
    mode: 'interactive',
    newField: 'default',
  });
  assert.deepStrictEqual(result.ranMigrations, [2]);
});

test('runMigrations chains multiple migrations in order', () => {
  _resetRegistry();
  registerMigration({
    from: 1,
    to: 2,
    apply: (raw) => ({ ...(raw as object), version: 2, step1: true }),
  });
  registerMigration({
    from: 2,
    to: 3,
    apply: (raw) => ({ ...(raw as object), version: 3, step2: true }),
  });
  const result = runMigrations({ version: 1 }, 3);
  assert.deepStrictEqual(result.migrated, {
    version: 3,
    step1: true,
    step2: true,
  });
  assert.deepStrictEqual(result.ranMigrations, [2, 3]);
});

test('runMigrations throws UnsupportedVersionError when input is newer than target', () => {
  _resetRegistry();
  assert.throws(
    () => runMigrations({ version: 99 }, 1),
    (err: unknown) => {
      assert.ok(err instanceof UnsupportedVersionError);
      assert.strictEqual(err.found, 99);
      assert.strictEqual(err.target, 1);
      return true;
    }
  );
});

test('runMigrations throws MigrationGapError when a step is missing', () => {
  _resetRegistry();
  registerMigration({
    from: 1,
    to: 2,
    apply: (raw) => ({ ...(raw as object), version: 2 }),
  });
  // Missing 2->3 step.
  assert.throws(
    () => runMigrations({ version: 1 }, 3),
    (err: unknown) => {
      assert.ok(err instanceof MigrationGapError);
      assert.strictEqual(err.missingFrom, 2);
      assert.strictEqual(err.missingTo, 3);
      return true;
    }
  );
});

test('runMigrations defaults missing version field to 1', () => {
  _resetRegistry();
  // No registered migrations; target=1; missing version is treated as v1.
  const result = runMigrations({ mode: 'auto' }, 1);
  assert.deepStrictEqual(result.migrated, { mode: 'auto' });
  assert.deepStrictEqual(result.ranMigrations, []);
});

test('registerMigration rejects multi-version jumps', () => {
  _resetRegistry();
  assert.throws(
    () =>
      registerMigration({
        from: 1,
        to: 3,
        apply: (raw) => raw,
      }),
    /must increment by 1/
  );
});

test('registerMigration rejects duplicate from versions', () => {
  _resetRegistry();
  registerMigration({ from: 1, to: 2, apply: (raw) => raw });
  assert.throws(
    () => registerMigration({ from: 1, to: 2, apply: (raw) => raw }),
    /already registered/
  );
});

test('runMigrations does not mutate the input object', () => {
  _resetRegistry();
  registerMigration({
    from: 1,
    to: 2,
    apply: (raw) => ({ ...(raw as object), version: 2, added: true }),
  });
  const input = { version: 1, mode: 'interactive' };
  const result = runMigrations(input, 2);
  // Input unchanged.
  assert.deepStrictEqual(input, { version: 1, mode: 'interactive' });
  // Output is a new object.
  assert.notStrictEqual(result.migrated, input);
});
