import { test } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

// We have to configure HOTSKILLS_CONFIG_DIR BEFORE importing the module,
// since audit.ts reads it when constructing cache paths. We also override
// the audit URL the vendored fetchAuditData hits — but it's a constant in
// the vendored module. Instead of mutating that module, we replace global
// `fetch` for the network tests.

const SANDBOX = mkdtempSync(join(tmpdir(), 'hotskills-audit-test-'));
process.env['HOME'] = SANDBOX;
process.env['HOTSKILLS_CONFIG_DIR'] = join(SANDBOX, '.config', 'hotskills');
process.env['HOTSKILLS_DEV_OVERRIDE'] = SANDBOX;

const { getAuditData } = await import('../audit.js');

type FetchMock = (input: unknown, init?: unknown) => Promise<Response>;
const realFetch = globalThis.fetch;

function installFetch(mock: FetchMock): void {
  globalThis.fetch = mock as unknown as typeof globalThis.fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

process.on('exit', () => rmSync(SANDBOX, { recursive: true, force: true }));

const SAMPLE_PARSED = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

const SAMPLE_RESPONSE = {
  'react-best-practices': {
    snyk: { risk: 'safe' as const, analyzedAt: '2026-04-01T00:00:00Z' },
    socket: { risk: 'low' as const, analyzedAt: '2026-04-01T00:00:00Z' },
  },
};

const cachePath = join(
  process.env['HOTSKILLS_CONFIG_DIR']!,
  'cache',
  'audit',
  `${SAMPLE_PARSED.owner}-${SAMPLE_PARSED.repo}.json`
);

function clearCache(): void {
  rmSync(cachePath, { force: true });
}

test('getAuditData — success response is cached and returned', async () => {
  clearCache();
  let calls = 0;
  installFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 });
  });
  try {
    const first = await getAuditData(SAMPLE_PARSED);
    assert.strictEqual(first.cached, false);
    assert.ok(first.audit, 'audit entry present on first call');
    assert.strictEqual(first.audit!['snyk']!.risk, 'safe');
    assert.strictEqual(calls, 1);

    // Verify the cache file was written.
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.deepStrictEqual(cached, SAMPLE_RESPONSE);

    // Second call must NOT hit the network.
    const second = await getAuditData(SAMPLE_PARSED);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(calls, 1, 'second call should not re-fetch');
    assert.strictEqual(second.audit!['snyk']!.risk, 'safe');
  } finally {
    restoreFetch();
  }
});

test('getAuditData — non-2xx response returns null and logs', async () => {
  clearCache();
  installFetch(async () => new Response('', { status: 500 }));
  try {
    const got = await getAuditData(SAMPLE_PARSED);
    assert.strictEqual(got.audit, null);
    assert.strictEqual(got.cached, false);

    // Log file exists and contains at least one line for this skill.
    const logPath = join(process.env['HOTSKILLS_CONFIG_DIR']!, 'logs', 'audit-errors.log');
    const log = readFileSync(logPath, 'utf8');
    assert.ok(/no_data_from_api/.test(log));
    assert.ok(/react-best-practices/.test(log));
  } finally {
    restoreFetch();
  }
});

test('getAuditData — malformed JSON returns null', async () => {
  clearCache();
  installFetch(async () => new Response('not json', { status: 200 }));
  try {
    const got = await getAuditData(SAMPLE_PARSED);
    assert.strictEqual(got.audit, null);
  } finally {
    restoreFetch();
  }
});

test('getAuditData — non-object JSON returns null (schema mismatch logged)', async () => {
  clearCache();
  installFetch(async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 }));
  try {
    const got = await getAuditData(SAMPLE_PARSED);
    assert.strictEqual(got.audit, null);

    const logPath = join(process.env['HOTSKILLS_CONFIG_DIR']!, 'logs', 'audit-errors.log');
    const log = readFileSync(logPath, 'utf8');
    assert.ok(/schema_mismatch/.test(log));
  } finally {
    restoreFetch();
  }
});

test('getAuditData — timeout treated as no-data (AbortError from vendored fn)', async () => {
  clearCache();
  // Simulate a fetch that throws AbortError. The vendored fetchAuditData
  // catches all throws and returns null, which audit.ts treats as
  // no_data_from_api.
  installFetch(async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  try {
    const got = await getAuditData(SAMPLE_PARSED);
    assert.strictEqual(got.audit, null);
    assert.strictEqual(got.cached, false);
  } finally {
    restoreFetch();
  }
});

test('getAuditData — integration round-trip against a local HTTP server', async () => {
  clearCache();
  let server: Server | null = null;
  try {
    server = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        // Upstream URL: /audit?source=<owner/repo>&skills=<csv>
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(SAMPLE_RESPONSE));
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${addr.port}`;

    // Intercept fetch: if request URL matches audit API, rewrite to our server.
    installFetch(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      const rewritten = url.replace('https://add-skill.vercel.sh', origin);
      return realFetch(rewritten);
    });

    const got = await getAuditData(SAMPLE_PARSED);
    assert.strictEqual(got.audit!['snyk']!.risk, 'safe');
    assert.strictEqual(got.cached, false);
  } finally {
    restoreFetch();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  }
});
