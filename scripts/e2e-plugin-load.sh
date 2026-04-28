#!/usr/bin/env bash
# e2e-plugin-load.sh — assert that the Claude Code CLI can parse this
# repo's .claude-plugin/marketplace.json + plugin.json and successfully
# install/enable the plugin.
#
# This catches the class of bug where manifest schemas drift from what
# `claude plugin marketplace add` will accept (e.g. missing `owner` or
# `plugins`, `author` as a string instead of object, etc.).
#
# The CLI mutates the user's global Claude settings, so we register the
# marketplace + plugin and clean them up via trap on every exit path.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE_NAME="hotskills"
PLUGIN_REF="hotskills@hotskills"

if ! command -v claude >/dev/null 2>&1; then
  echo "e2e-plugin-load.sh: 'claude' CLI not found in PATH — skipping" >&2
  exit 0
fi

cleanup() {
  claude plugin uninstall "${PLUGIN_REF}" >/dev/null 2>&1 || true
  claude plugin marketplace remove "${MARKETPLACE_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# In case a previous run left state behind.
cleanup

fail=0

step() {
  printf '== %s\n' "$1"
}

assert_contains() {
  local needle="$1" haystack="$2" label="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    printf 'FAIL: %s — expected to contain %q\n--- output ---\n%s\n--------------\n' \
      "${label}" "${needle}" "${haystack}" >&2
    fail=1
    return 1
  fi
  printf 'PASS: %s\n' "${label}"
}

step "marketplace add"
out="$(claude plugin marketplace add "${REPO_ROOT}" 2>&1)"
assert_contains "Successfully added marketplace" "${out}" "marketplace.json parses"

step "marketplace list"
out="$(claude plugin marketplace list 2>&1)"
assert_contains "${MARKETPLACE_NAME}" "${out}" "marketplace appears in list"

step "plugin install"
out="$(claude plugin install "${PLUGIN_REF}" 2>&1)"
assert_contains "Successfully installed" "${out}" "plugin.json parses + plugin installs"

step "plugin enabled"
out="$(claude plugin list 2>&1)"
# Find the hotskills block and inspect its Status line.
hotskills_block="$(awk '/hotskills@hotskills/{flag=1} flag{print; if(/Status:/){flag=0}}' <<<"${out}")"
assert_contains "enabled" "${hotskills_block}" "plugin reports enabled status"

if [[ ${fail} -ne 0 ]]; then
  echo "e2e-plugin-load.sh: FAILED" >&2
  exit 1
fi

echo "e2e-plugin-load.sh: OK"
exit 0
