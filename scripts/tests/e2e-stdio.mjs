#!/usr/bin/env node
// E2E driver for the MCP server over stdio. Spawns
// `node server/dist/index.js`, talks JSON-RPC, asserts protocol shape.
//
// To stay hermetic (no network in CI), we pre-stage:
//   - the search cache for the query "react"
//   - the materialized cache directory + .hotskills-manifest.json so
//     `hotskills.activate` hits the manifest fast-path
//   - a project .hotskills/config.json that whitelists the org so the
//     gate stack short-circuits without an audit lookup
//
// Required env:
//   HOTSKILLS_CONFIG_DIR — temp config dir
//   HOTSKILLS_PROJECT_CWD — temp project dir
//   HOTSKILLS_DEV_OVERRIDE — temp prefix (covers the two paths above)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const SERVER = join(repoRoot, 'server', 'dist', 'index.js');

const CONFIG_DIR = process.env.HOTSKILLS_CONFIG_DIR;
const PROJECT_CWD = process.env.HOTSKILLS_PROJECT_CWD;
if (!CONFIG_DIR || !PROJECT_CWD) {
  console.error('e2e-stdio: HOTSKILLS_CONFIG_DIR and HOTSKILLS_PROJECT_CWD must be set');
  process.exit(2);
}

const SKILL_ID = 'skills.sh:vercel-labs/agent-skills:react-best-practices';
const PARSED = {
  source: 'skills.sh',
  owner: 'vercel-labs',
  repo: 'agent-skills',
  slug: 'react-best-practices',
};

// ─── pre-stage search cache ───
//
// Cache key per server/src/tools/search.ts:buildCacheKey:
//   sha256(`${strategy} ${query} ${sortedSources}`)
function buildSearchCacheKey(query, strategy, sources) {
  const sorted = sources ? [...sources].sort().join(',') : '';
  return createHash('sha256').update(`${strategy} ${query} ${sorted}`).digest('hex');
}

const searchKey = buildSearchCacheKey('react', 'auto', undefined);
const searchCachePath = join(CONFIG_DIR, 'cache', 'search', `${searchKey}.json`);
mkdirSync(dirname(searchCachePath), { recursive: true, mode: 0o700 });
writeFileSync(
  searchCachePath,
  JSON.stringify([
    {
      skill_id: SKILL_ID,
      name: 'react-best-practices',
      installs: 5_000_000,
      source: 'vercel-labs/agent-skills',
      slug: 'react-best-practices',
      audit: null,
      gate_status: 'unknown',
    },
  ]),
  { mode: 0o600 }
);

// ─── pre-stage materialized cache + manifest ───
const materializedDir = join(
  CONFIG_DIR,
  'cache',
  'skills',
  'skills.sh',
  PARSED.owner,
  PARSED.repo,
  PARSED.slug
);
mkdirSync(materializedDir, { recursive: true, mode: 0o700 });
const skillMdBody = '# React best practices\nUse ${SKILL_PATH}/scripts/run.sh and ${SKILL_PATH}/references/style.md.\n';
writeFileSync(join(materializedDir, 'SKILL.md'), skillMdBody, { mode: 0o600 });
mkdirSync(join(materializedDir, 'scripts'), { recursive: true, mode: 0o700 });
writeFileSync(join(materializedDir, 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
mkdirSync(join(materializedDir, 'references'), { recursive: true, mode: 0o700 });
writeFileSync(join(materializedDir, 'references', 'style.md'), '# style guide\n', { mode: 0o600 });

// Reuse the server's own content-sha algorithm so this E2E never drifts
// from production logic.
const { computeContentSha } = await import(
  pathToFileURL(join(repoRoot, 'server', 'dist', 'activation.js')).href
);
const contentSha = computeContentSha(materializedDir);
const manifest = {
  source: PARSED.source,
  owner: PARSED.owner,
  repo: PARSED.repo,
  slug: PARSED.slug,
  version: 'e2e-fixture',
  content_sha256: contentSha,
  audit_snapshot: { audit: null, cached_at: new Date().toISOString() },
  activated_at: new Date().toISOString(),
};
writeFileSync(join(materializedDir, '.hotskills-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

// ─── pre-stage project config ───
mkdirSync(join(PROJECT_CWD, '.hotskills'), { recursive: true, mode: 0o700 });
writeFileSync(
  join(PROJECT_CWD, '.hotskills', 'config.json'),
  JSON.stringify({
    version: 1,
    security: { whitelist: { orgs: ['vercel-labs'] } },
  }),
  { mode: 0o600 }
);

// ─── JSON-RPC client over stdio ───
//
// By default we spawn the locally-built server with the current node
// binary. The "published-via-npx" E2E sets HOTSKILLS_E2E_CMD=npx and
// HOTSKILLS_E2E_ARGS_JSON='["-y","hotskills"]' to spawn the registry
// version instead — same protocol, different launcher.
const spawnCmd = process.env.HOTSKILLS_E2E_CMD ?? process.execPath;
const spawnArgs = process.env.HOTSKILLS_E2E_ARGS_JSON
  ? JSON.parse(process.env.HOTSKILLS_E2E_ARGS_JSON)
  : [SERVER];
const child = spawn(spawnCmd, spawnArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production' },
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`e2e-stdio: cannot parse server line: ${line}`);
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve: r } = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  }
});

child.stderr.on('data', (chunk) => {
  // Server logs configuration errors here; surface them to the test log.
  process.stderr.write(`[server] ${chunk}`);
});

function call(method, params) {
  return new Promise((resolveCall, rejectCall) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveCall });
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(payload);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rejectCall(new Error(`timeout waiting for ${method} (id=${id})`));
      }
    }, 15000);
  });
}

function assertOk(cond, msg) {
  if (!cond) {
    console.error(`E2E ASSERTION FAILED: ${msg}`);
    child.kill('SIGTERM');
    process.exit(1);
  }
}

function extractToolResult(rsp) {
  // Tool calls return content as MCP content blocks; parse the first JSON one.
  if (!rsp.result?.content) return null;
  for (const block of rsp.result.content) {
    if (block.type === 'text') {
      try {
        return JSON.parse(block.text);
      } catch {
        return block.text;
      }
    }
  }
  return null;
}

async function main() {
  // 1) initialize
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0.0.0' },
  });
  assertOk(init.result?.serverInfo?.name === 'hotskills', 'initialize: server name should be hotskills');
  // initialized is a notification (no response). Send manually rather than
  // through call() so we don't wait for a reply.
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 2) tools/list — must return exactly six hotskills tools
  const list = await call('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    'hotskills.activate',
    'hotskills.audit',
    'hotskills.deactivate',
    'hotskills.invoke',
    'hotskills.list',
    'hotskills.search',
  ];
  assertOk(JSON.stringify(names) === JSON.stringify(expected), `tools/list mismatch: ${JSON.stringify(names)}`);

  // 3) hotskills.search — served from pre-staged cache
  const search = await call('tools/call', { name: 'hotskills.search', arguments: { query: 'react' } });
  const searchData = extractToolResult(search);
  assertOk(Array.isArray(searchData?.results), 'search.results must be an array');
  assertOk(searchData.results.length >= 1, 'search.results must be non-empty');
  assertOk(searchData.results[0].skill_id === SKILL_ID, `search top result: ${searchData.results[0]?.skill_id}`);
  assertOk(searchData.cached === true, 'search must report cached: true (we pre-staged the cache)');

  // 4) hotskills.activate — fast-path because manifest sha matches
  const act = await call('tools/call', {
    name: 'hotskills.activate',
    arguments: { skill_id: SKILL_ID, install_count: 5_000_000 },
  });
  const actData = extractToolResult(act);
  assertOk(actData?.skill_id === SKILL_ID, `activate.skill_id: ${actData?.skill_id}`);
  assertOk(actData?.reused === true, `activate.reused must be true (fast-path), got ${actData?.reused}`);
  assertOk(typeof actData?.path === 'string' && actData.path.includes('react-best-practices'), `activate.path: ${actData?.path}`);

  // 5) hotskills.list — must include the activated skill
  const lst = await call('tools/call', { name: 'hotskills.list', arguments: { scope: 'project' } });
  const lstData = extractToolResult(lst);
  assertOk(Array.isArray(lstData?.activated), 'list.activated must be an array');
  assertOk(lstData.activated.some((e) => e.skill_id === SKILL_ID), `list missing activated skill`);

  // 6) hotskills.invoke — body has ${SKILL_PATH} substituted, scripts + refs populated
  const inv = await call('tools/call', { name: 'hotskills.invoke', arguments: { skill_id: SKILL_ID } });
  const invData = extractToolResult(inv);
  assertOk(typeof invData?.body === 'string', 'invoke.body must be string');
  assertOk(invData.body.includes(materializedDir), `invoke.body missing absolute path substitution`);
  assertOk(!invData.body.includes('${SKILL_PATH}'), 'invoke.body must NOT contain unresolved ${SKILL_PATH}');
  assertOk(Array.isArray(invData.scripts) && invData.scripts.some((s) => s.name === 'run.sh'), `invoke.scripts: ${JSON.stringify(invData.scripts)}`);
  assertOk(Array.isArray(invData.references) && invData.references.some((r) => r.name === 'style.md'), `invoke.references: ${JSON.stringify(invData.references)}`);

  // 7) hotskills.deactivate — removes from allow-list
  const deact = await call('tools/call', {
    name: 'hotskills.deactivate',
    arguments: { skill_id: SKILL_ID },
  });
  const deactData = extractToolResult(deact);
  assertOk(deactData?.removed === true, `deactivate.removed: ${deactData?.removed}`);

  // 8) list again — should be empty
  const listAfter = await call('tools/call', { name: 'hotskills.list', arguments: { scope: 'project' } });
  const listAfterData = extractToolResult(listAfter);
  assertOk(Array.isArray(listAfterData?.activated), 'post-deactivate list.activated must be array');
  assertOk(listAfterData.activated.length === 0, `post-deactivate allow-list non-empty: ${JSON.stringify(listAfterData.activated)}`);

  // Materialized cache survives deactivate (we don't delete on deactivate).
  const cached = readFileSync(join(materializedDir, 'SKILL.md'), 'utf8');
  assertOk(cached.includes('React best practices'), 'cache must survive deactivate');

  console.log('E2E PASS — 8 protocol assertions');
  child.kill('SIGTERM');
  process.exit(0);
}

main().catch((err) => {
  console.error('E2E EXCEPTION:', err.stack ?? err);
  child.kill('SIGTERM');
  process.exit(1);
});
