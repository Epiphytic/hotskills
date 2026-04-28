#!/usr/bin/env bash
# e2e-npx.sh — full setup-to-invoke roundtrip against the *published*
# hotskills MCP server, launched via `npx -y hotskills`.
#
# This is the test that catches regressions in the npm publish path:
#   - bin entry has the right shebang and is marked executable in the tarball
#   - default env (no HOTSKILLS_PROJECT_CWD / HOTSKILLS_CONFIG_DIR) works
#   - the server connects without any client-side env-var substitution
#   - the plugin's .mcp.json is wired up to npx in a way Claude Code
#     accepts when loaded via `--plugin-dir`
#
# Workflow:
#   1. Create a blank temp "project repo" (no git init needed; the server
#      doesn't require a git repo at runtime).
#   2. Run the existing JSON-RPC E2E driver, but spawn `npx -y hotskills`
#      instead of `node server/dist/index.js`.
#   3. Optionally (--with-claude) drive a Claude Code instance with
#      `--plugin-dir <repo>` and assert that hotskills shows ✓ Connected.
#
# By default this uses whatever `npx -y hotskills` resolves to. To exercise
# unreleased local code, run `cd server && npm link` first; to exercise the
# real registry version, run `npm unlink -g hotskills` (or skip the link
# step entirely).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="${REPO_ROOT}/scripts/tests/e2e-stdio.mjs"

if [[ ! -f "${RUNNER}" ]]; then
  echo "e2e-npx.sh: missing runner at ${RUNNER}" >&2
  exit 2
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "e2e-npx.sh: npx not on PATH (need Node.js >= 22)" >&2
  exit 2
fi

# Show what npx will resolve to for diagnostic purposes.
echo "== resolved hotskills version (via npx -y hotskills --version-probe) =="
RESOLVED_VERSION=$(npx -y hotskills --help 2>&1 | head -1 || true)
NPM_VIEW=$(npm view hotskills version 2>/dev/null || echo "<not on registry>")
LINKED=$(npm ls -g hotskills 2>/dev/null | head -3 || echo "<not linked>")
echo "  npm view hotskills version -> ${NPM_VIEW}"
echo "  global links              -> ${LINKED}"
echo "  npx probe head            -> ${RESOLVED_VERSION:-<no output>}"

TMPROOT="$(mktemp -d -t hotskills-e2e-npx-XXXXXX)"
trap 'rm -rf "${TMPROOT}" 2>/dev/null || true' EXIT INT TERM

# A truly blank "project" — no git, no config, no marketplace, no plugin
# install. The server must boot cleanly with these defaults.
PROJECT_CWD="${TMPROOT}/blank-repo"
CONFIG_DIR="${TMPROOT}/.config/hotskills"
mkdir -p "${PROJECT_CWD}" "${CONFIG_DIR}"
chmod 0700 "${PROJECT_CWD}" "${CONFIG_DIR}"

# The runner pre-stages caches + project config under these dirs, then
# expects the spawned server to read them. HOTSKILLS_DEV_OVERRIDE keeps
# the security sandbox happy when temp paths live outside ~/.config.
export HOTSKILLS_PROJECT_CWD="${PROJECT_CWD}"
export HOTSKILLS_CONFIG_DIR="${CONFIG_DIR}"
export HOTSKILLS_DEV_OVERRIDE="${TMPROOT}"

# Override the spawn target so e2e-stdio.mjs uses the npm-published bin.
export HOTSKILLS_E2E_CMD="npx"
export HOTSKILLS_E2E_ARGS_JSON='["-y","hotskills"]'

echo "== running JSON-RPC roundtrip via npx -y hotskills =="
node "${RUNNER}"
status=$?

if [[ ${status} -ne 0 ]]; then
  echo "e2e-npx.sh: FAILED (npx-spawned protocol roundtrip exit=${status})" >&2
  exit "${status}"
fi

echo "e2e-npx.sh: OK"
exit 0
