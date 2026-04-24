#!/usr/bin/env bash
# inject-reminders.sh — Hotskills hook script
#
# Per ADR-005: invoked from three Claude Code hook events
# (PostCompact, SessionStart, UserPromptSubmit) via hooks/hooks.json.
# Reads <project>/.hotskills/{config,state}.json and emits up to two
# <system-reminder> blocks to stdout, which Claude Code injects into
# the model's context.
#
# Invariants (ADR-005 §Performance + safety):
#   - MUST complete in <200ms typical case.
#   - MUST be idempotent.
#   - MUST NOT block on network.
#   - MUST atomically replace state.json (write .tmp + sync + rename).
#   - All IO failures MUST log to ${HOTSKILLS_CONFIG_DIR}/logs/hook.log
#     and exit 0 (a hook MUST NOT block prompts).
#   - If <project>/.hotskills/ does not exist, MUST exit 0 with no output.
#
# Activated-skills reminder caps at 20 entries (most-recently-activated
# first); descriptions truncated to 80 chars; appends
# "... and N more — call hotskills.list for the full list." if exceeded.

set -u
# NOTE: no `set -e`. We trap and swallow every error per ADR-005 hook safety.

# Always exit 0 on any unexpected error path.
trap '_log_exception "trap" "${BASH_COMMAND:-?}" "${LINENO:-?}"' ERR
trap 'exit 0' EXIT

# ─── Argument parsing ───

EVENT=""
for arg in "$@"; do
  case "$arg" in
    --event=PostCompact|--event=SessionStart|--event=UserPromptSubmit)
      EVENT="${arg#--event=}"
      ;;
    --event=*)
      _log_event_unknown "${arg#--event=}"
      exit 0
      ;;
    *)
      # Unknown argument — log and exit clean.
      :
      ;;
  esac
done

if [[ -z "$EVENT" ]]; then
  _log_event_unknown "<missing>"
  exit 0
fi

# ─── Path resolution ───

PROJECT_CWD="${HOTSKILLS_PROJECT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"
CONFIG_DIR="${HOTSKILLS_CONFIG_DIR:-$HOME/.config/hotskills}"
PROJECT_HOTSKILLS="${PROJECT_CWD%/}/.hotskills"
PROJECT_CONFIG="${PROJECT_HOTSKILLS}/config.json"
PROJECT_STATE="${PROJECT_HOTSKILLS}/state.json"
GLOBAL_CONFIG="${CONFIG_DIR%/}/config.json"
LOG_DIR="${CONFIG_DIR%/}/logs"
LOG_FILE="${LOG_DIR}/hook.log"

# If the project never set up hotskills, exit silently. ADR-005 explicit.
if [[ ! -d "$PROJECT_HOTSKILLS" ]]; then
  exit 0
fi

# ─── Logging helpers ───

# Append a single JSON line to LOG_FILE. Best-effort, never fails.
_log_json() {
  local level="$1"; shift
  local event="$1"; shift
  local extra="$1"  # already-formatted "key":value,"key":value (or empty)
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  local line
  if [[ -n "$extra" ]]; then
    line="{\"ts\":\"${ts}\",\"level\":\"${level}\",\"event\":\"${event}\",${extra}}"
  else
    line="{\"ts\":\"${ts}\",\"level\":\"${level}\",\"event\":\"${event}\"}"
  fi
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || return 0
}

_log_exception() {
  local where="$1"
  local cmd="${2//\"/\\\"}"
  local line="$3"
  _log_json "error" "hook_exception" "\"hook_event\":\"${EVENT:-unknown}\",\"where\":\"${where}\",\"command\":\"${cmd}\",\"line\":\"${line}\""
}

_log_event_unknown() {
  local got="${1//\"/\\\"}"
  _log_json "warn" "unknown_event_arg" "\"got\":\"${got}\""
}

_log_io() {
  local what="${1//\"/\\\"}"
  local path="${2//\"/\\\"}"
  _log_json "warn" "io_failure" "\"what\":\"${what}\",\"path\":\"${path}\""
}

# ─── jq availability ───
#
# We require jq for safe JSON read/write. If jq is missing, log a warning
# and emit no reminders (do not block the prompt).

if ! command -v jq >/dev/null 2>&1; then
  _log_json "warn" "jq_missing" ""
  exit 0
fi

# ─── Read config (project + global merged) ───
#
# Per ADR-003 §Per-project state: activated = union (global ∪ project)
# deduped by skill_id (newer activated_at wins). For the reminder we only
# need the activated list and the opportunistic flag — the full merge
# logic lives in server/src/config.ts; we mirror enough of it here.

read_json_or_empty() {
  local path="$1"
  if [[ -f "$path" ]] && [[ -r "$path" ]]; then
    # cat then pipe so a parse failure returns {} not the contents
    if cat "$path" 2>/dev/null | jq -ec . >/dev/null 2>&1; then
      cat "$path" 2>/dev/null
      return 0
    else
      _log_io "config_parse_failed" "$path"
    fi
  fi
  printf '{}'
}

GLOBAL_JSON="$(read_json_or_empty "$GLOBAL_CONFIG")"
PROJECT_JSON="$(read_json_or_empty "$PROJECT_CONFIG")"

# Merge activated lists — newer activated_at wins, deduped by skill_id.
# Output: a JSON array of {skill_id, activated_at, description?} sorted
# by activated_at desc.
MERGED_ACTIVATED="$(
  jq -nec \
    --argjson g "$GLOBAL_JSON" \
    --argjson p "$PROJECT_JSON" \
    '
    def items(c): (c.activated // []);
    (items($g) + items($p))
    | group_by(.skill_id)
    | map(max_by(.activated_at // ""))
    | sort_by(.activated_at // "")
    | reverse
    ' 2>/dev/null || printf '[]'
)"

# Opportunistic flag: project wins when defined, else global.
OPPORTUNISTIC="$(
  jq -ner \
    --argjson g "$GLOBAL_JSON" \
    --argjson p "$PROJECT_JSON" \
    '
    if ($p.opportunistic // null) != null then $p.opportunistic
    elif ($g.opportunistic // null) != null then $g.opportunistic
    else false
    end
    ' 2>/dev/null || printf 'false'
)"

# ─── Read state ───

STATE_JSON="$(read_json_or_empty "$PROJECT_STATE")"

OPP_PENDING="$(
  jq -ner --argjson s "$STATE_JSON" \
    'if ($s.opportunistic_pending // null) == true then "true" else "false" end' \
    2>/dev/null || printf 'false'
)"

# ─── Per-event state mutations ───

# new_session_id: "<random-hex>-<unix-ns>"; avoids network deps
new_session_id() {
  local rand
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen 2>/dev/null && return 0
  fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid 2>/dev/null && return 0
  fi
  rand="$(printf '%s%s' "${RANDOM}${RANDOM}" "$(date +%N 2>/dev/null || echo 0)")"
  printf '%s-%s' "$rand" "$(date +%s 2>/dev/null || echo 0)"
}

# Atomically replace state file. Write .tmp, fsync (best-effort), rename.
write_state_atomic() {
  local content="$1"
  local target="$PROJECT_STATE"
  local tmp="${target}.tmp.$$"
  mkdir -p "$PROJECT_HOTSKILLS" 2>/dev/null || { _log_io "mkdir_state_dir" "$PROJECT_HOTSKILLS"; return 0; }
  if ! printf '%s\n' "$content" >"$tmp" 2>/dev/null; then
    _log_io "write_tmp_state" "$tmp"
    return 0
  fi
  # fsync best-effort; non-fatal if `sync` missing
  command -v sync >/dev/null 2>&1 && sync "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$target" 2>/dev/null; then
    _log_io "rename_state" "$target"
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  return 0
}

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 1970-01-01T00:00:00Z)"

mutate_state_for_event() {
  local event="$1"
  local set_pending="$2"   # true/false — should we flip pending to true?
  local update_compact="$3"   # true/false
  local update_session_start="$4" # true/false
  local clear_pending="$5"    # true/false

  # Build new state with jq. Defaults applied where fields missing.
  local sid="$STATE_JSON"
  if [[ "$update_session_start" == "true" ]]; then
    local new_sid
    new_sid="$(new_session_id)"
    sid="$(jq -nec --argjson s "$sid" --arg id "$new_sid" --arg ts "$NOW_ISO" '
      ($s + {version: ($s.version // 1), opportunistic_pending: ($s.opportunistic_pending // false), session_id: $id, last_session_start_at: $ts})
    ' 2>/dev/null || printf '%s' "$STATE_JSON")"
  fi
  if [[ "$update_compact" == "true" ]]; then
    sid="$(jq -nec --argjson s "$sid" --arg ts "$NOW_ISO" '
      ($s + {version: ($s.version // 1), opportunistic_pending: ($s.opportunistic_pending // false), session_id: ($s.session_id // ""), last_compact_at: $ts})
    ' 2>/dev/null || printf '%s' "$sid")"
  fi
  if [[ "$set_pending" == "true" ]]; then
    sid="$(jq -nec --argjson s "$sid" '
      ($s + {version: ($s.version // 1), opportunistic_pending: true, session_id: ($s.session_id // "")})
    ' 2>/dev/null || printf '%s' "$sid")"
  fi
  if [[ "$clear_pending" == "true" ]]; then
    sid="$(jq -nec --argjson s "$sid" '
      ($s + {version: ($s.version // 1), opportunistic_pending: false, session_id: ($s.session_id // "")})
    ' 2>/dev/null || printf '%s' "$sid")"
  fi
  # Always ensure required fields exist before writing.
  sid="$(jq -nec --argjson s "$sid" '
    {version: ($s.version // 1),
     opportunistic_pending: ($s.opportunistic_pending // false),
     session_id: ($s.session_id // "")}
    + (if $s.last_compact_at != null then {last_compact_at: $s.last_compact_at} else {} end)
    + (if $s.last_session_start_at != null then {last_session_start_at: $s.last_session_start_at} else {} end)
  ' 2>/dev/null || printf '%s' "$sid")"

  write_state_atomic "$sid"
}

# ─── Reminder rendering ───

emit_activated_reminder() {
  local count
  count="$(jq -ner --argjson a "$MERGED_ACTIVATED" '$a | length' 2>/dev/null || printf '0')"
  if [[ "$count" -eq 0 ]]; then
    return 0
  fi
  local first20 overflow more
  first20="$(jq -nec --argjson a "$MERGED_ACTIVATED" '$a[0:20]' 2>/dev/null || printf '[]')"
  if [[ "$count" -gt 20 ]]; then
    more=$((count - 20))
    overflow="... and ${more} more — call hotskills.list for the full list."
  else
    overflow=""
  fi

  printf '<system-reminder>\n'
  printf 'Hotskills activated for this project (call via `hotskills.invoke`):\n'
  # render bullet lines: skill_id — description (truncated to 80 chars)
  jq -ner --argjson a "$first20" '
    $a[] |
    (.skill_id // "?") as $sid |
    (.description // "") as $desc |
    if ($desc | length) > 80 then
      "- \($sid) — \($desc[0:79])…"
    elif ($desc | length) > 0 then
      "- \($sid) — \($desc)"
    else
      "- \($sid)"
    end
  ' 2>/dev/null
  if [[ -n "$overflow" ]]; then
    printf '%s\n' "$overflow"
  fi
  printf '\nUse `hotskills.list` for the full list. Use `hotskills.search` to find more.\n'
  printf '</system-reminder>\n'
}

emit_opportunistic_reminder() {
  printf '<system-reminder>\n'
  printf 'Opportunistic skill discovery is enabled. If the user'\''s prompt could benefit\n'
  printf 'from a skill you don'\''t have activated, call `hotskills.search` with a query\n'
  printf 'derived from the prompt. If config has `mode: "auto"`, the dispatcher will\n'
  printf 'activate the top passing-gate result inline.\n'
  printf '</system-reminder>\n'
}

# ─── Per-event dispatch ───

case "$EVENT" in
  PostCompact)
    emit_activated_reminder
    if [[ "$OPPORTUNISTIC" == "true" ]]; then
      emit_opportunistic_reminder
      mutate_state_for_event "PostCompact" "true" "true" "false" "false"
    else
      mutate_state_for_event "PostCompact" "false" "true" "false" "false"
    fi
    ;;

  SessionStart)
    emit_activated_reminder
    if [[ "$OPPORTUNISTIC" == "true" ]]; then
      emit_opportunistic_reminder
      mutate_state_for_event "SessionStart" "true" "false" "true" "false"
    else
      mutate_state_for_event "SessionStart" "false" "false" "true" "false"
    fi
    ;;

  UserPromptSubmit)
    emit_activated_reminder
    if [[ "$OPP_PENDING" == "true" ]]; then
      emit_opportunistic_reminder
      mutate_state_for_event "UserPromptSubmit" "false" "false" "false" "true"
    fi
    ;;
esac

exit 0
