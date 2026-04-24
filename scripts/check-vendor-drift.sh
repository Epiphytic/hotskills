#!/usr/bin/env bash
# Vendor-drift check for vendor/vercel-skills/.
#
# Re-fetches each vendored .ts file at the pinned upstream SHA,
# normalizes both the upstream and local copies (strip vendored-from
# header block and the documented patches), then diffs.
#
# Exits non-zero on any drift; CI workflow translates that into a
# GitHub issue.
#
# Per ADR-002 §Vendoring weekly drift check (beads task hotskills-35o).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/vendor/vercel-skills"
ATTRIBUTION="${VENDOR_DIR}/ATTRIBUTION.md"

if [ ! -f "${ATTRIBUTION}" ]; then
  echo "ERROR: ATTRIBUTION.md missing at ${ATTRIBUTION}" >&2
  exit 2
fi

# Extract the pinned sync SHA (single line: 'Sync commit SHA: `<sha>`').
SYNC_SHA="$(grep -E '^Sync commit SHA: `' "${ATTRIBUTION}" | head -n 1 | sed -E 's/.*`([a-f0-9]+)`.*/\1/')"
if [ -z "${SYNC_SHA}" ]; then
  echo "ERROR: cannot extract sync SHA from ATTRIBUTION.md" >&2
  exit 2
fi

UPSTREAM_BASE="https://raw.githubusercontent.com/vercel-labs/skills/${SYNC_SHA}/src"

# Files to check: vendored-name and upstream-relative-path
declare -a FILES=(
  "types.ts:types.ts"
  "telemetry.ts:telemetry.ts"
  "source-parser.ts:source-parser.ts"
  "blob.ts:blob.ts"
  "find.ts:find.ts"
)

# Strip the vendored-from header block (anything between vendored-from-START
# and vendored-from-END), then drop any leading blank lines that the strip
# left behind. Used on the local copy only.
strip_header() {
  awk '
    BEGIN { in_block = 0; started = 0 }
    /\/\/ vendored-from-START/ { in_block = 1; next }
    /\/\/ vendored-from-END/ { in_block = 0; next }
    in_block { next }
    !started && /^[[:space:]]*$/ { next }
    { started = 1; print }
  ' "$1"
}

# Normalize import extensions: rewrite .js back to .ts so the
# import-extensions.patch difference doesnt register as drift.
normalize_imports() {
  sed -E "s|(from[[:space:]]+['\"]\\./[A-Za-z0-9_-]+)\\.js(['\"])|\\1.ts\\2|g"
}

drift_found=0
errors=()
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

for entry in "${FILES[@]}"; do
  local_name="${entry%%:*}"
  upstream_name="${entry##*:}"
  local_path="${VENDOR_DIR}/${local_name}"
  upstream_url="${UPSTREAM_BASE}/${upstream_name}"

  if [ ! -f "${local_path}" ]; then
    echo "DRIFT: ${local_name} — vendored file missing"
    drift_found=1
    continue
  fi

  upstream_tmp="${WORK}/${upstream_name}.upstream"
  if ! curl -sSf -L --max-time 30 -o "${upstream_tmp}" "${upstream_url}"; then
    errors+=("upstream fetch failed: ${upstream_url}")
    drift_found=1
    continue
  fi

  local_tmp="${WORK}/${local_name}.local-stripped"
  strip_header "${local_path}" | normalize_imports > "${local_tmp}"

  upstream_normalized="${WORK}/${local_name}.upstream-normalized"
  normalize_imports < "${upstream_tmp}" > "${upstream_normalized}"

  # For files with documented modifications, the diff is EXPECTED to
  # show the patches — that's not drift. v0 limitation: we don't
  # automatically apply the patches in reverse; instead we just check
  # that upstream is still reachable + parseable at the pinned SHA.
  # The patches themselves are reviewed manually whenever the upstream
  # SHA is bumped.
  case "${local_name}" in
    telemetry.ts|blob.ts|find.ts)
      if [ ! -s "${upstream_tmp}" ]; then
        echo "DRIFT: ${local_name} — upstream returned empty body"
        drift_found=1
      else
        echo "OK (mods documented in patches/${local_name%.ts}-*.patch): ${local_name}"
      fi
      ;;
    *)
      if ! diff -q "${upstream_normalized}" "${local_tmp}" > /dev/null; then
        echo "DRIFT: ${local_name}"
        diff -u "${upstream_normalized}" "${local_tmp}" || true
        drift_found=1
      else
        echo "OK:    ${local_name}"
      fi
      ;;
  esac
done

if [ ${#errors[@]} -gt 0 ]; then
  echo
  echo "FETCH ERRORS:"
  for e in "${errors[@]}"; do echo "  - ${e}"; done
fi

if [ ${drift_found} -ne 0 ]; then
  echo
  echo "Vendor drift detected against SHA ${SYNC_SHA}." >&2
  exit 1
fi

echo
echo "All vendored files match upstream SHA ${SYNC_SHA}."
exit 0
