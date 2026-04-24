// Sync vendored vercel-labs/skills modules into src/vendor/ before tsc runs.
//
// The vendored sources live under <repo>/vendor/vercel-skills/ (committed,
// authoritative, with attribution + patches per ADR-002). To keep the
// server's tsconfig rootDir at ./src, we copy the .ts files into
// src/vendor/vercel-skills/ on every build. The destination tree is
// .gitignored (server/.gitignore + repo .gitignore both exclude it) so
// the only source of truth remains <repo>/vendor/.
//
// Idempotent: re-running overwrites; missing source dir is a hard error.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..');

const src = resolve(repoRoot, 'vendor', 'vercel-skills');
const dst = resolve(serverRoot, 'src', 'vendor', 'vercel-skills');

if (!existsSync(src)) {
  console.error(`[sync-vendor] FATAL: source dir missing: ${src}`);
  process.exit(1);
}

// Wipe destination to mirror source exactly (no stale files from prior syncs).
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

cpSync(src, dst, {
  recursive: true,
  // Preserve everything; the vendor dir is small.
});

console.log(`[sync-vendor] copied ${src} -> ${dst}`);
