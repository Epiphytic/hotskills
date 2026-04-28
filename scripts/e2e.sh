#!/usr/bin/env bash
# e2e.sh — full setup-to-invoke roundtrip against the real MCP server over
# stdio. Used by CI and `npm run e2e` locally.
#
# Per Plan-Phase 6 §6.3:
#   - Spawn `node server/dist/index.js` with HOTSKILLS_CONFIG_DIR /
#     HOTSKILLS_PROJECT_CWD pointed at temp paths.
#   - Send tools/list → expect 6 tools.
#   - Call hotskills.search (mocked at HTTP, so we use --skipCache and a
#     dev override to avoid live API).
#   - Call hotskills.activate with materialization mocked via a project
#     config that whitelists the org so the gate stack short-circuits.
#   - Call hotskills.invoke and assert ${SKILL_PATH} substitution +
#     scripts/references arrays.
#   - Call hotskills.deactivate and assert allow-list is empty.
#
# We delegate JSON-RPC framing to a Node helper because hand-rolling
# Content-Length headers in bash is fragile.
#
# Exits non-zero on any failed assertion. Cleans up temp dirs on both
# pass and fail.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="${REPO_ROOT}/scripts/tests/e2e-stdio.mjs"

if [[ ! -f "${RUNNER}" ]]; then
  echo "e2e.sh: missing runner at ${RUNNER}" >&2
  exit 2
fi

if [[ ! -f "${REPO_ROOT}/server/dist/index.js" ]]; then
  echo "e2e.sh: server is not built — run 'npm --prefix server run build' first" >&2
  exit 2
fi

TMPROOT="$(mktemp -d -t hotskills-e2e-XXXXXX)"
trap 'rm -rf "${TMPROOT}" 2>/dev/null || true' EXIT INT TERM

CONFIG_DIR="${TMPROOT}/.config/hotskills"
PROJECT_CWD="${TMPROOT}/project"
mkdir -p "${CONFIG_DIR}" "${PROJECT_CWD}"
chmod 0700 "${CONFIG_DIR}" "${PROJECT_CWD}"

export HOTSKILLS_CONFIG_DIR="${CONFIG_DIR}"
export HOTSKILLS_PROJECT_CWD="${PROJECT_CWD}"
export HOTSKILLS_DEV_OVERRIDE="${TMPROOT}"

node "${RUNNER}"
exit $?
