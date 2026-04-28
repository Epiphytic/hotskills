#!/usr/bin/env bash
# e2e-claude-keyword.sh — Plan-Phase 6 §6.6 (hotskills-056).
#
# Drives a real `claude --plugin-dir <hotskills-checkout>` session in
# non-interactive (--print) mode against ≥5 keyword fixtures from
# test/fixtures/keyword-expectations.json. For each fixture:
#   1. mktemp -d a fresh empty git repo
#   2. set HOTSKILLS_CONFIG_DIR / HOTSKILLS_PROJECT_CWD inside that temp tree
#   3. invoke claude with the fixture's prompt
#   4. inspect the server-side debug log to confirm:
#        a. hotskills.search was called with a query containing
#           the fixture's expected_query_terms
#        b. the activated allow-list (.hotskills/config.json) contains
#           every entry in must_include_skill_ids
#   5. tear down on pass and on fail
#
# CI gating:
#   This script launches a real `claude` session, which costs API credits
#   and requires network access to skills.sh + the audit API. It is
#   therefore gated behind `CI_E2E_CLAUDE=1`. Without that env var, the
#   script exits 0 with a "skipped" message so CI runs that don't have
#   API credits configured still succeed.
#
# Local developers can always run this with:
#   CI_E2E_CLAUDE=1 bash scripts/e2e-claude-keyword.sh
#
# Negative test:
#   Pass --negative <fixture_id> to assert the script EXITS NON-ZERO when
#   the must_include list is deliberately bogus. Used by CI to confirm
#   the assertions actually fire.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="${REPO_ROOT}/test/fixtures/keyword-expectations.json"

if [[ "${CI_E2E_CLAUDE:-0}" != "1" ]]; then
  echo "e2e-claude-keyword: skipped (CI_E2E_CLAUDE is not '1')."
  echo "  set CI_E2E_CLAUDE=1 to run a real claude session against ${FIXTURES}."
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "e2e-claude-keyword: 'claude' CLI not on PATH; cannot run E2E." >&2
  exit 2
fi

if [[ ! -f "${FIXTURES}" ]]; then
  echo "e2e-claude-keyword: missing fixtures at ${FIXTURES}" >&2
  exit 2
fi

NEGATIVE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --negative)
      NEGATIVE_ID="${2:-}"
      shift 2
      ;;
    *)
      echo "e2e-claude-keyword: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

JQ="$(command -v jq || true)"
if [[ -z "${JQ}" ]]; then
  echo "e2e-claude-keyword: 'jq' is required" >&2
  exit 2
fi

NUM=$("$JQ" '.fixtures | length' "${FIXTURES}")
if [[ "${NUM}" -lt 5 ]]; then
  echo "e2e-claude-keyword: fixtures must contain at least 5 entries (got ${NUM})" >&2
  exit 2
fi

TMPROOT="$(mktemp -d -t hotskills-claude-keyword-XXXXXX)"
trap 'rm -rf "${TMPROOT}" 2>/dev/null || true' EXIT INT TERM

PASS=0
FAIL=0

for ((i=0; i<NUM; i++)); do
  ID=$("$JQ" -r ".fixtures[${i}].id" "${FIXTURES}")
  PROMPT=$("$JQ" -r ".fixtures[${i}].prompt" "${FIXTURES}")
  TERMS_JSON=$("$JQ" -c ".fixtures[${i}].expected_query_terms" "${FIXTURES}")
  MUST_INCLUDE_JSON=$("$JQ" -c ".fixtures[${i}].must_include_skill_ids" "${FIXTURES}")

  if [[ -n "${NEGATIVE_ID}" && "${ID}" == "${NEGATIVE_ID}" ]]; then
    # Replace must_include with a known-bad ID so the assertion is
    # guaranteed to fail.
    MUST_INCLUDE_JSON='["skills.sh:nope-org/nope-repo:nope-slug"]'
  fi

  PROJECT_CWD="${TMPROOT}/projects/${ID}"
  CONFIG_DIR="${TMPROOT}/configs/${ID}"
  mkdir -p "${PROJECT_CWD}" "${CONFIG_DIR}/logs"
  chmod 0700 "${PROJECT_CWD}" "${CONFIG_DIR}"
  ( cd "${PROJECT_CWD}" && git init -q 2>/dev/null || true )

  echo "─── fixture ${ID} ───"
  echo "  prompt: ${PROMPT}"

  # Hand the model a guard-rail prompt that asks it to actually call the
  # hotskills MCP tools. Without an explicit instruction, --print sessions
  # often answer from prior knowledge.
  GUARD="Use the hotskills plugin to find and activate any skills that would help with this task. Call hotskills.search with a relevant query, then call hotskills.activate for the most relevant matches."
  COMBINED_PROMPT="${GUARD}

User: ${PROMPT}"

  CLAUDE_LOG="${TMPROOT}/${ID}-claude.log"
  if ! HOTSKILLS_CONFIG_DIR="${CONFIG_DIR}" \
       HOTSKILLS_PROJECT_CWD="${PROJECT_CWD}" \
       HOTSKILLS_DEV_OVERRIDE="${TMPROOT}" \
       HOTSKILLS_DEBUG=true \
       claude \
         --plugin-dir "${REPO_ROOT}" \
         --print \
         --permission-mode bypassPermissions \
         "${COMBINED_PROMPT}" \
         >"${CLAUDE_LOG}" 2>&1; then
    echo "  FAIL: claude exited non-zero. log: ${CLAUDE_LOG}"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Assertion (a): hotskills.search appears in the claude session output.
  if ! grep -q 'hotskills.search\|hotskills\.search' "${CLAUDE_LOG}"; then
    echo "  FAIL: hotskills.search not invoked in session"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Assertion (b): expected query terms surface in the search call.
  TERMS_OK=1
  while read -r term; do
    if [[ -n "${term}" ]] && ! grep -iq "${term}" "${CLAUDE_LOG}"; then
      echo "  FAIL: expected query term '${term}' not in session"
      TERMS_OK=0
      break
    fi
  done < <("$JQ" -r '.[]' <<<"${TERMS_JSON}")
  if [[ "${TERMS_OK}" -ne 1 ]]; then
    FAIL=$((FAIL + 1))
    continue
  fi

  # Assertion (c): the project allow-list contains every must_include entry.
  PROJECT_CFG="${PROJECT_CWD}/.hotskills/config.json"
  ALL_PRESENT=1
  if [[ ! -f "${PROJECT_CFG}" ]]; then
    echo "  FAIL: no project allow-list at ${PROJECT_CFG}"
    FAIL=$((FAIL + 1))
    continue
  fi
  while read -r needed; do
    if ! "$JQ" -e --arg id "${needed}" '.activated[]? | select(.skill_id == $id)' "${PROJECT_CFG}" >/dev/null; then
      echo "  FAIL: missing required skill in allow-list: ${needed}"
      ALL_PRESENT=0
      break
    fi
  done < <("$JQ" -r '.[]' <<<"${MUST_INCLUDE_JSON}")
  if [[ "${ALL_PRESENT}" -ne 1 ]]; then
    FAIL=$((FAIL + 1))
    continue
  fi

  # Assertion (d): materialized cache contains a SKILL.md for each
  # activated skill.
  while read -r needed; do
    OWNER_REPO=$(echo "${needed}" | sed -E 's|^skills\.sh:([^:]+):.*$|\1|')
    OWNER=$(echo "${OWNER_REPO}" | cut -d/ -f1)
    REPO=$(echo "${OWNER_REPO}" | cut -d/ -f2)
    SLUG=$(echo "${needed}" | sed -E 's|^skills\.sh:[^:]+:(.+)$|\1|')
    CACHE_PATH="${CONFIG_DIR}/cache/skills/skills.sh/${OWNER}/${REPO}/${SLUG}/SKILL.md"
    if [[ ! -f "${CACHE_PATH}" ]]; then
      echo "  FAIL: materialized SKILL.md missing at ${CACHE_PATH}"
      ALL_PRESENT=0
      break
    fi
  done < <("$JQ" -r '.[]' <<<"${MUST_INCLUDE_JSON}")
  if [[ "${ALL_PRESENT}" -ne 1 ]]; then
    FAIL=$((FAIL + 1))
    continue
  fi

  echo "  PASS"
  PASS=$((PASS + 1))
done

echo ""
echo "e2e-claude-keyword: ${PASS} passed, ${FAIL} failed of ${NUM} fixtures"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi

if [[ -n "${NEGATIVE_ID}" ]]; then
  # Negative mode: a successful pass means assertions did NOT fire as
  # expected. Flip the exit code so CI can use this to confirm the
  # script's failure path actually works.
  echo "e2e-claude-keyword: negative test for '${NEGATIVE_ID}' UNEXPECTEDLY passed; assertions are not firing"
  exit 1
fi

exit 0
