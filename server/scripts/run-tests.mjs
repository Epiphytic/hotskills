#!/usr/bin/env node
// Runs every dist/__tests__/**/*.test.js file via `node --test`.
//
// Why a custom runner: `node --test` accepts file globs only on Node 22.6+,
// and we want to avoid silently dropping test files when contributors add
// new ones (which is exactly what happened pre-Phase-6 when the test
// command was a hard-coded list).
//
// Discovery rule: any *.test.js under dist/__tests__/ (any depth) is picked
// up. Tests are passed to node --test in lexicographic order so output is
// stable across runs.

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(here, '..', 'dist', '__tests__');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(distRoot).sort();
} catch (err) {
  console.error(`run-tests: cannot scan ${distRoot}: ${err.message}`);
  console.error('run-tests: did you forget `npm run build`?');
  process.exit(2);
}

if (files.length === 0) {
  console.error('run-tests: no .test.js files found under dist/__tests__');
  process.exit(2);
}

const result = spawnSync('node', ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
