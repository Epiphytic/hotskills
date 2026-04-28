import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '../index.js');

// Shared temp dir for the server's env-var validation (env.ts). We create it
// once per test run, hand it to every spawned server, and clean up on exit.
const SANDBOX_ROOT = mkdtempSync(path.join(tmpdir(), 'hotskills-mcp-test-'));
const PROJECT_CWD = path.join(SANDBOX_ROOT, 'project');
const CONFIG_DIR = path.join(SANDBOX_ROOT, '.config', 'hotskills');
const DEV_OVERRIDE = SANDBOX_ROOT;
import { mkdirSync } from 'node:fs';
mkdirSync(PROJECT_CWD, { recursive: true });
process.on('exit', () => rmSync(SANDBOX_ROOT, { recursive: true, force: true }));

const SERVER_ENV = {
  ...process.env,
  HOTSKILLS_PROJECT_CWD: PROJECT_CWD,
  HOTSKILLS_CONFIG_DIR: CONFIG_DIR,
  HOTSKILLS_DEV_OVERRIDE: DEV_OVERRIDE,
};

function runMcpSession(messages: object[], expectedIds: number[]): Promise<Map<number, object>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env: SERVER_ENV });
    const byId = new Map<number, object>();
    let buf = '';
    let stderr = '';
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.kill();
      if (err) reject(err);
      else resolve(byId);
    };

    const timer = setTimeout(() => {
      const missing = expectedIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        finish(new Error(`Timeout: missing JSON-RPC ids ${missing.join(',')}; stderr=${stderr.slice(0, 500)}`));
      } else {
        finish();
      }
    }, 15000);

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { id?: number };
          if (typeof r.id === 'number') {
            byId.set(r.id, r);
            if (expectedIds.every((id) => byId.has(id))) finish();
          }
        } catch { /* ignore non-JSON */ }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => finish(err));

    proc.on('exit', (code, signal) => {
      const missing = expectedIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        finish(new Error(`Server exited (code=${code}, signal=${signal}) before all expected ids arrived; missing=${missing.join(',')}; stderr=${stderr.slice(0, 500)}`));
      }
    });

    for (const msg of messages) {
      proc.stdin.write(JSON.stringify(msg) + '\n');
    }
  });
}

const INIT_MSG = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } };
const INITIALIZED_NOTIF = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };

test('tools/list returns exactly 6 hotskills tools', async () => {
  const responses = await runMcpSession(
    [INIT_MSG, INITIALIZED_NOTIF, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }],
    [1, 2]
  );

  const r = responses.get(2) as { result?: { tools?: Array<{ name: string }> } } | undefined;
  assert.ok(r, 'tools/list response received');
  assert.ok(Array.isArray(r?.result?.tools), 'result.tools is an array');

  const tools = r!.result!.tools!;
  assert.strictEqual(tools.length, 6, `expected 6 tools, got ${tools.length}`);

  const expectedNames = ['hotskills.search', 'hotskills.activate', 'hotskills.deactivate', 'hotskills.list', 'hotskills.invoke', 'hotskills.audit'];
  const actualNames = tools.map((t) => t.name);
  for (const name of expectedNames) {
    assert.ok(actualNames.includes(name), `tool ${name} missing from tools/list`);
  }
});

test('hotskills.search returns {results, cached, cache_age_seconds} (real handler)', async () => {
  const responses = await runMcpSession(
    [INIT_MSG, INITIALIZED_NOTIF, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hotskills.search', arguments: { query: 'react' } } }],
    [1, 3]
  );

  const r = responses.get(3) as { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: object } | undefined;
  assert.ok(r, 'call response received');
  // The handler runs against a sandboxed cache with no network; the
  // upstream skills.sh API may or may not respond from this sandbox.
  // What we assert is the response *shape* (not the result count).
  const text = (r?.result?.content ?? [])[0]?.text;
  assert.ok(text, 'content[0].text present');
  const parsed = JSON.parse(text);
  if (r?.result?.isError) {
    assert.ok(parsed.error, `error response carries an error code: ${text}`);
  } else {
    assert.ok(Array.isArray(parsed.results), 'response has results array');
    assert.ok(typeof parsed.cached === 'boolean', 'response has cached flag');
    assert.ok(parsed.cache_age_seconds === null || typeof parsed.cache_age_seconds === 'number');
  }
});

test('hotskills.search Zod validation rejects missing query', async () => {
  const responses = await runMcpSession(
    [INIT_MSG, INITIALIZED_NOTIF, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hotskills.search', arguments: {} } }],
    [1, 4]
  );

  const r = responses.get(4) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: object } | undefined;
  assert.ok(r, 'response received');
  // MCP SDK returns Zod validation failures as tool results with isError:true (not JSON-RPC error)
  assert.strictEqual(r?.result?.isError, true, 'isError flag set on validation failure');
  const text = r?.result?.content?.[0]?.text ?? '';
  assert.ok(/query/i.test(text), `error message references missing "query" param: ${text}`);
});

// ─── hotskills-rrz: input-schema shape assertions for all 6 tools ───
//
// ADR-001 §Tool surface pins the six-tool surface as a versioned contract.
// These assertions make the JSON-Schema shape (required fields, types,
// enum values) load-bearing in CI so an accidental rename, type widening,
// or removed required field trips a red test before reaching users.

interface ToolSchema {
  name: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; enum?: unknown[]; default?: unknown }>;
    required?: string[];
  };
}

async function fetchToolsList(): Promise<Map<string, ToolSchema>> {
  const responses = await runMcpSession(
    [INIT_MSG, INITIALIZED_NOTIF, { jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }],
    [1, 99]
  );
  const r = responses.get(99) as { result?: { tools?: ToolSchema[] } } | undefined;
  const tools = r?.result?.tools ?? [];
  return new Map(tools.map((t) => [t.name, t]));
}

test('hotskills tools — input schemas declare expected required fields and types', async () => {
  const byName = await fetchToolsList();

  // Each row: tool name, required fields, all expected property names.
  // Optional/required come from the tool's z.object literal (see
  // server/src/tools/*.ts). Adjust this table when a tool surface changes
  // — that's the point.
  const expectations: Array<{
    name: string;
    required: string[];
    propsSubset: string[];
  }> = [
    { name: 'hotskills.search', required: ['query'], propsSubset: ['query', 'limit', 'sources'] },
    {
      name: 'hotskills.activate',
      required: ['skill_id'],
      propsSubset: ['skill_id', 'force_whitelist', 'install_count'],
    },
    { name: 'hotskills.deactivate', required: ['skill_id'], propsSubset: ['skill_id'] },
    { name: 'hotskills.list', required: [], propsSubset: ['scope'] },
    { name: 'hotskills.invoke', required: ['skill_id'], propsSubset: ['skill_id', 'args'] },
    { name: 'hotskills.audit', required: ['skill_id'], propsSubset: ['skill_id'] },
  ];

  for (const exp of expectations) {
    const tool = byName.get(exp.name);
    assert.ok(tool, `tool ${exp.name} present in tools/list`);
    const schema = tool!.inputSchema;
    assert.ok(schema, `tool ${exp.name} has inputSchema`);
    assert.strictEqual(schema!.type, 'object', `tool ${exp.name} inputSchema.type is "object"`);

    const actualRequired = new Set(schema!.required ?? []);
    for (const r of exp.required) {
      assert.ok(actualRequired.has(r), `tool ${exp.name} requires "${r}"`);
    }
    // Optional fields MUST NOT appear in required[].
    for (const p of exp.propsSubset) {
      if (!exp.required.includes(p)) {
        assert.ok(
          !actualRequired.has(p),
          `tool ${exp.name}: "${p}" is optional and must not be in required[]`
        );
      }
    }

    const props = schema!.properties ?? {};
    for (const p of exp.propsSubset) {
      assert.ok(p in props, `tool ${exp.name} declares property "${p}"`);
    }
  }
});

test('hotskills.list — scope enum offers project|global|merged with merged default', async () => {
  // ADR-003 §Tool surface pins these enum values; lock them in.
  const byName = await fetchToolsList();
  const list = byName.get('hotskills.list');
  assert.ok(list, 'hotskills.list present');
  const scope = list!.inputSchema?.properties?.scope;
  assert.ok(scope, 'scope property declared');
  const en = scope!.enum;
  assert.ok(Array.isArray(en), 'scope is an enum');
  assert.deepStrictEqual(
    [...(en as string[])].sort(),
    ['global', 'merged', 'project'],
    'scope enum values match ADR-003'
  );
  assert.strictEqual(scope!.default, 'merged', 'scope default is "merged"');
});

// ─── Table-driven stub coverage for tools that have a Zod-validation gate ───
//
// Each row exercises the tool's required-field validation by calling it
// with arguments missing a required field, asserting the MCP SDK reports
// isError:true and references the missing param name. Tools with no
// required field (hotskills.list) are exercised separately with empty args
// to confirm a non-error response shape.

test('hotskills tools — required-field validation rejects empty arguments', async () => {
  // Each tool that has a required field is called with arguments:{}; we
  // assert isError:true and an error text mentioning the missing field.
  const cases: Array<{ tool: string; missing: string }> = [
    { tool: 'hotskills.activate', missing: 'skill_id' },
    { tool: 'hotskills.deactivate', missing: 'skill_id' },
    { tool: 'hotskills.invoke', missing: 'skill_id' },
    { tool: 'hotskills.audit', missing: 'skill_id' },
  ];

  // Run all cases in one MCP session for speed (server spawn is the
  // expensive part). Each case gets a unique JSON-RPC id.
  const baseId = 200;
  const messages: object[] = [INIT_MSG, INITIALIZED_NOTIF];
  cases.forEach((c, i) => {
    messages.push({
      jsonrpc: '2.0',
      id: baseId + i,
      method: 'tools/call',
      params: { name: c.tool, arguments: {} },
    });
  });
  const expectedIds = [1, ...cases.map((_, i) => baseId + i)];
  const responses = await runMcpSession(messages, expectedIds);

  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const r = responses.get(baseId + i) as
      | { result?: { isError?: boolean; content?: Array<{ text: string }> } }
      | undefined;
    assert.ok(r, `${c.tool}: response received`);
    assert.strictEqual(
      r?.result?.isError,
      true,
      `${c.tool}: isError true on missing ${c.missing}`
    );
    const text = r?.result?.content?.[0]?.text ?? '';
    assert.ok(
      new RegExp(c.missing, 'i').test(text),
      `${c.tool}: error references missing "${c.missing}" — got: ${text.slice(0, 200)}`
    );
  }
});

test('hotskills.list — accepts empty arguments and returns a content[] envelope', async () => {
  // hotskills.list has no required field (scope defaults to "merged").
  // With an empty sandbox, runList returns an empty merged list.
  const responses = await runMcpSession(
    [INIT_MSG, INITIALIZED_NOTIF, { jsonrpc: '2.0', id: 300, method: 'tools/call', params: { name: 'hotskills.list', arguments: {} } }],
    [1, 300]
  );
  const r = responses.get(300) as
    | { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } }
    | undefined;
  assert.ok(r, 'list response received');
  assert.notStrictEqual(r?.result?.isError, true, 'list — no validation error on empty args');
  const text = r?.result?.content?.[0]?.text ?? '';
  assert.ok(text, 'list — content[0].text present');
  const parsed = JSON.parse(text);
  // Don't pin exact structure (kept loose intentionally — runList shape is
  // covered in tools/list unit tests). Just confirm the envelope routed.
  assert.strictEqual(typeof parsed, 'object', 'list — JSON-parseable response object');
});
