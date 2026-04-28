import { test } from 'node:test';
import assert from 'node:assert';

test('smoke: schema validators work', async () => {
  const { validateConfig, validateState } = await import('../schemas/index.js');

  const configResult = validateConfig({ version: 1 });
  assert.strictEqual(configResult.valid, true);

  const stateResult = validateState({
    version: 1,
    opportunistic_pending: false,
    session_id: 'test-session',
  });
  assert.strictEqual(stateResult.valid, true);

  const badConfig = validateConfig({ version: 99 });
  assert.strictEqual(badConfig.valid, false);
  assert.ok(badConfig.errors.length > 0);
});
