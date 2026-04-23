import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '../index.js');

function runMcpSession(messages: object[], expectedIds: number[]): Promise<Map<number, object>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    }, 5000);

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

test('hotskills.search stub returns {stub: true}', async () => {
  const responses = await runMcpSession(
    [INIT_MSG, INITIALIZED_NOTIF, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hotskills.search', arguments: { query: 'react' } } }],
    [1, 3]
  );

  const r = responses.get(3) as { result?: { content?: Array<{ type: string; text: string }> }; error?: object } | undefined;
  assert.ok(r, 'call response received');
  assert.ok(!r?.error, `unexpected error: ${JSON.stringify(r?.error)}`);
  const text = (r?.result?.content ?? [])[0]?.text;
  assert.ok(text, 'content[0].text present');
  assert.deepStrictEqual(JSON.parse(text), { stub: true });
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
