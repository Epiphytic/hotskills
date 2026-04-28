#!/usr/bin/env bash
# e2e-claude-config.sh — Plan-Phase 6 §6.7 (hotskills-q7s).
#
# Exercises the documented config options end-to-end against a real
# `claude --plugin-dir <hotskills-checkout>` session for each fixture in
# test/fixtures/config-scenarios/. The fixtures cover the 10 scenarios
# in §6.7: mode (interactive/auto/opportunistic), security overrides
# (min_installs, risk_max), whitelist (orgs, repos), sources preferred,
# discovery.find_strategy, and per-project override of global.
#
# Mechanism:
#   - For each fixture, mktemp a fresh repo + temp HOTSKILLS_CONFIG_DIR.
#   - Write global_config to ${HOTSKILLS_CONFIG_DIR}/config.json.
#   - Write project_config (when non-null) to <repo>/.hotskills/config.json.
#   - Launch claude --plugin-dir <hotskills-checkout> --print with the
#     scripted prompt; capture stdout/stderr.
#   - Apply the fixture's assertions against the session log + the
#     resulting on-disk state.
#   - Tear down (rm -rf) the temp paths regardless of pass/fail.
#
# CI gating:
#   Same as e2e-claude-keyword.sh — gated behind CI_E2E_CLAUDE=1 because
#   it spends API credits and requires network access. Without that env
#   var the script exits 0 with a "skipped" message.
#
# Negative test:
#   Pass --negative <scenario_id> to flip one of the fixture's assertions
#   to a guaranteed-bad value, ensuring the failure-path actually fires.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIOS_DIR="${REPO_ROOT}/test/fixtures/config-scenarios"

if [[ "${CI_E2E_CLAUDE:-0}" != "1" ]]; then
  echo "e2e-claude-config: skipped (CI_E2E_CLAUDE is not '1')."
  echo "  set CI_E2E_CLAUDE=1 to run real claude sessions against ${SCENARIOS_DIR}."
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "e2e-claude-config: 'claude' CLI not on PATH; cannot run E2E." >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "e2e-claude-config: 'jq' is required" >&2
  exit 2
fi

if [[ ! -d "${SCENARIOS_DIR}" ]]; then
  echo "e2e-claude-config: missing scenarios dir at ${SCENARIOS_DIR}" >&2
  exit 2
fi

NEGATIVE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --negative) NEGATIVE_ID="${2:-}"; shift 2 ;;
    *) echo "e2e-claude-config: unknown arg: $1" >&2; exit 2 ;;
  esac
done

mapfile -t FIXTURES < <(ls -1 "${SCENARIOS_DIR}"/*.json | sort)

if [[ "${#FIXTURES[@]}" -lt 10 ]]; then
  echo "e2e-claude-config: expected at least 10 scenarios (got ${#FIXTURES[@]})" >&2
  exit 2
fi

TMPROOT="$(mktemp -d -t hotskills-claude-config-XXXXXX)"
trap 'rm -rf "${TMPROOT}" 2>/dev/null || true' EXIT INT TERM

PASS=0
FAIL=0

for FIXTURE in "${FIXTURES[@]}"; do
  ID="$(jq -r '.id' "${FIXTURE}")"
  PROMPT="$(jq -r '.prompt' "${FIXTURE}")"

  echo "─── scenario ${ID} ───"

  PROJECT_CWD="${TMPROOT}/projects/${ID}"
  CONFIG_DIR="${TMPROOT}/configs/${ID}"
  mkdir -p "${PROJECT_CWD}" "${CONFIG_DIR}/logs"
  chmod 0700 "${PROJECT_CWD}" "${CONFIG_DIR}"
  ( cd "${PROJECT_CWD}" && git init -q 2>/dev/null || true )

  # Write global_config (always required, even if empty).
  GLOBAL=$(jq -c '.global_config // {} | (. + {version: 1})' "${FIXTURE}")
  echo "${GLOBAL}" >"${CONFIG_DIR}/config.json"
  chmod 0600 "${CONFIG_DIR}/config.json"

  # Write project_config when non-null.
  if jq -e '.project_config != null' "${FIXTURE}" >/dev/null; then
    PROJECT=$(jq -c '.project_config | (. + {version: 1})' "${FIXTURE}")
    mkdir -p "${PROJECT_CWD}/.hotskills"
    chmod 0700 "${PROJECT_CWD}/.hotskills"
    echo "${PROJECT}" >"${PROJECT_CWD}/.hotskills/config.json"
    chmod 0600 "${PROJECT_CWD}/.hotskills/config.json"
  fi

  # Optionally scrub npx from PATH (find_strategy=api).
  EXTRA_ENV=()
  if [[ "$(jq -r '.scrub_npx_from_path // false' "${FIXTURE}")" == "true" ]]; then
    SCRUBBED_PATH=""
    IFS=':' read -ra DIRS <<<"${PATH}"
    for d in "${DIRS[@]}"; do
      if [[ -e "${d}/npx" ]]; then continue; fi
      SCRUBBED_PATH="${SCRUBBED_PATH}:${d}"
    done
    EXTRA_ENV+=("PATH=${SCRUBBED_PATH#:}")
  fi

  CLAUDE_LOG="${TMPROOT}/${ID}-claude.log"
  # NOTE: keep claude's full inherited env (HOME, OAuth tokens, etc.) and
  # add the HOTSKILLS_* + scrubbed PATH on top. `env` without `-i`
  # preserves anything the running shell already exports.
  if ! env \
       HOTSKILLS_CONFIG_DIR="${CONFIG_DIR}" \
       HOTSKILLS_PROJECT_CWD="${PROJECT_CWD}" \
       HOTSKILLS_DEV_OVERRIDE="${TMPROOT}" \
       HOTSKILLS_DEBUG=true \
       "${EXTRA_ENV[@]}" \
       claude \
         --plugin-dir "${REPO_ROOT}" \
         --print \
         --permission-mode bypassPermissions \
         "${PROMPT}" \
         >"${CLAUDE_LOG}" 2>&1; then
    echo "  FAIL: claude exited non-zero. log: ${CLAUDE_LOG}"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Apply assertions.
  OK=1

  # search_called: hotskills.search must appear in claude session log.
  if [[ "$(jq -r '.assertions.search_called // false' "${FIXTURE}")" == "true" ]]; then
    if ! grep -q 'hotskills\.search' "${CLAUDE_LOG}"; then
      echo "  FAIL [${ID}]: assertion search_called: hotskills.search not invoked"
      OK=0
    fi
  fi

  # activate_called.
  if [[ "$(jq -r '.assertions.activate_called // false' "${FIXTURE}")" == "true" ]]; then
    if ! grep -q 'hotskills\.activate' "${CLAUDE_LOG}"; then
      echo "  FAIL [${ID}]: assertion activate_called: hotskills.activate not invoked"
      OK=0
    fi
  fi

  # activation_blocked: project allow-list must NOT contain the
  # synthetic skill, and the session log should mention a block reason.
  WANT_BLOCKED="$(jq -r '.assertions.activation_blocked // empty' "${FIXTURE}")"
  if [[ "${WANT_BLOCKED}" == "true" ]]; then
    BLOCK_PATTERN="$(jq -r '.assertions.block_reason_matches // empty' "${FIXTURE}")"
    if [[ -n "${BLOCK_PATTERN}" ]]; then
      if ! grep -q "${BLOCK_PATTERN}" "${CLAUDE_LOG}"; then
        echo "  FAIL [${ID}]: expected block reason '${BLOCK_PATTERN}' not in session"
        OK=0
      fi
    fi
  elif [[ "${WANT_BLOCKED}" == "false" ]]; then
    EXPECTED="$(jq -r '.synthetic_skill.skill_id // empty' "${FIXTURE}")"
    if [[ -n "${EXPECTED}" ]] && [[ -f "${PROJECT_CWD}/.hotskills/config.json" ]]; then
      if ! jq -e --arg id "${EXPECTED}" '.activated[]? | select(.skill_id == $id)' \
           "${PROJECT_CWD}/.hotskills/config.json" >/dev/null; then
        echo "  FAIL [${ID}]: expected ${EXPECTED} in allow-list, missing"
        OK=0
      fi
    fi
  fi

  # whitelist_log_contains.
  WL_NEEDS="$(jq -r '.assertions.whitelist_log_contains // empty' "${FIXTURE}")"
  if [[ -n "${WL_NEEDS}" ]]; then
    WL="${CONFIG_DIR}/logs/whitelist-activations.log"
    if [[ ! -f "${WL}" ]] || ! grep -q "${WL_NEEDS}" "${WL}"; then
      echo "  FAIL [${ID}]: whitelist log missing '${WL_NEEDS}' (path: ${WL})"
      OK=0
    fi
  fi

  # opportunistic_reminder_emitted: claude session output should contain
  # the opportunistic reminder text from inject-reminders.sh.
  if [[ "$(jq -r '.assertions.opportunistic_reminder_emitted // false' "${FIXTURE}")" == "true" ]]; then
    if ! grep -q 'Opportunistic skill discovery' "${CLAUDE_LOG}"; then
      echo "  FAIL [${ID}]: opportunistic reminder not emitted"
      OK=0
    fi
  fi

  # Negative-mode assertion flip: if this scenario matches NEGATIVE_ID,
  # we expect FAIL. Invert OK.
  if [[ -n "${NEGATIVE_ID}" && "${ID}" == "${NEGATIVE_ID}" ]]; then
    if [[ "${OK}" -eq 1 ]]; then
      echo "  NEG-FAIL [${ID}]: negative test passed positively (assertions did not fire)"
      OK=0
    else
      echo "  NEG-PASS [${ID}]: negative test correctly failed"
      OK=1
    fi
  fi

  if [[ "${OK}" -eq 1 ]]; then
    echo "  PASS"
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "e2e-claude-config: ${PASS} passed, ${FAIL} failed of ${#FIXTURES[@]} scenarios"

if [[ "${FAIL}" -gt 0 ]]; then exit 1; fi
exit 0
