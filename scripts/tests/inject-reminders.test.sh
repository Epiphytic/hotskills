#!/usr/bin/env bash
# Tests for scripts/inject-reminders.sh
#
# Usage: bash scripts/tests/inject-reminders.test.sh
# Runs in CI; exits 0 on success, non-zero on first failure.
#
# Each test creates a fresh tmpdir for HOTSKILLS_CONFIG_DIR and
# HOTSKILLS_PROJECT_CWD, then invokes the script and asserts on stdout
# and on the resulting state.json.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK="$ROOT_DIR/scripts/inject-reminders.sh"

if [[ ! -x "$HOOK" ]]; then
  echo "FAIL: $HOOK is not executable" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILURES=()

# --- assertions ---
assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: want=[$want] got=[$got]")
    echo "FAIL: $name" >&2
    echo "  want: $want" >&2
    echo "  got:  $got" >&2
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: needle=[$needle] not in output")
    echo "FAIL: $name" >&2
    echo "  needle: $needle" >&2
    echo "  haystack: ${haystack:0:500}" >&2
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: needle=[$needle] should NOT appear")
    echo "FAIL: $name" >&2
    echo "  needle: $needle" >&2
  fi
}

assert_empty() {
  local got="$1" name="$2"
  if [[ -z "$got" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected empty got=[${got:0:200}]")
    echo "FAIL: $name" >&2
    echo "  expected empty, got: ${got:0:200}" >&2
  fi
}

# Setup fresh tmpdirs and env. Returns by setting global env vars.
setup_fresh() {
  TMPROOT="$(mktemp -d -t hotskills-hook.XXXXXX)"
  export HOTSKILLS_CONFIG_DIR="$TMPROOT/cfg"
  export HOTSKILLS_PROJECT_CWD="$TMPROOT/proj"
  mkdir -p "$HOTSKILLS_CONFIG_DIR" "$HOTSKILLS_PROJECT_CWD"
}

teardown_fresh() {
  if [[ -n "${TMPROOT:-}" && -d "$TMPROOT" ]]; then
    rm -rf "$TMPROOT"
  fi
  unset HOTSKILLS_CONFIG_DIR HOTSKILLS_PROJECT_CWD TMPROOT
}

# ─── Test 1: project has no .hotskills/ → exit 0, no stdout ───
test_no_hotskills_dir() {
  setup_fresh
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "no_hotskills_dir: exit code"
  assert_empty "$out" "no_hotskills_dir: stdout empty"
  teardown_fresh
}

# ─── Test 2: empty allow-list → exit 0, no stdout ───
test_empty_allowlist() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  printf '{"version":1}' > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json"
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "empty_allowlist: exit code"
  assert_empty "$out" "empty_allowlist: stdout empty"
  teardown_fresh
}

# ─── Test 3: 1-skill allow-list → correct reminder ───
test_one_skill_reminder() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json" <<'EOF'
{
  "version": 1,
  "activated": [
    {
      "skill_id": "skills.sh:vercel-labs/agent-skills:react-best-practices",
      "activated_at": "2026-04-23T10:00:00Z",
      "description": "Best practices for React"
    }
  ]
}
EOF
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "one_skill: exit code"
  assert_contains "$out" "<system-reminder>" "one_skill: contains opening tag"
  assert_contains "$out" "</system-reminder>" "one_skill: contains closing tag"
  assert_contains "$out" "skills.sh:vercel-labs/agent-skills:react-best-practices" "one_skill: contains skill_id"
  assert_contains "$out" "Best practices for React" "one_skill: contains description"
  assert_contains "$out" "hotskills.invoke" "one_skill: invoke hint"
  assert_contains "$out" "hotskills.list" "one_skill: list hint"
  teardown_fresh
}

# ─── Test 4: 25-skill allow-list → first 20 + overflow line ───
test_overflow_cap() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  # Build a 25-skill config — vary activated_at so order is well-defined.
  local entries=""
  for i in $(seq 1 25); do
    local ts
    # Pad i so lexicographic sort matches numeric desc — newer = larger i = later ts.
    ts="$(printf '2026-04-23T10:%02d:00Z' "$i")"
    if [[ -n "$entries" ]]; then entries="$entries,"; fi
    entries="${entries}{\"skill_id\":\"skills.sh:test/repo:skill-${i}\",\"activated_at\":\"${ts}\"}"
  done
  printf '{"version":1,"activated":[%s]}' "$entries" > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json"
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "overflow: exit code"
  # skill-25 (latest) MUST appear; skill-1 (oldest) MUST NOT.
  assert_contains "$out" "skill-25" "overflow: newest skill present"
  assert_contains "$out" "skill-6" "overflow: 20th-newest skill present"
  assert_not_contains "$out" "skill-5\"" "overflow: 21st-newest absent"
  assert_contains "$out" "... and 5 more" "overflow: overflow line present"
  teardown_fresh
}

# ─── Test 5: PostCompact + opportunistic:true → both reminders, pending set ───
test_postcompact_opportunistic() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json" <<'EOF'
{
  "version": 1,
  "opportunistic": true,
  "activated": [
    {"skill_id":"skills.sh:test/repo:skill-a","activated_at":"2026-04-23T10:00:00Z"}
  ]
}
EOF
  local out
  out="$("$HOOK" --event=PostCompact 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "postcompact: exit code"
  assert_contains "$out" "skills.sh:test/repo:skill-a" "postcompact: activated reminder"
  assert_contains "$out" "Opportunistic skill discovery is enabled" "postcompact: opportunistic reminder"
  # Verify state.json was written with pending=true and last_compact_at.
  local state
  state="$(cat "$HOTSKILLS_PROJECT_CWD/.hotskills/state.json")"
  assert_contains "$state" "\"opportunistic_pending\":true" "postcompact: pending set"
  assert_contains "$state" "last_compact_at" "postcompact: last_compact_at present"
  teardown_fresh
}

# ─── Test 6: UserPromptSubmit + pending → both, pending cleared ───
test_userprompt_pending_cleared() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json" <<'EOF'
{"version":1,"opportunistic":true,
 "activated":[{"skill_id":"skills.sh:test/repo:skill-a","activated_at":"2026-04-23T10:00:00Z"}]}
EOF
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/state.json" <<'EOF'
{"version":1,"opportunistic_pending":true,"session_id":"abc"}
EOF
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "userprompt_pending: exit code"
  assert_contains "$out" "Opportunistic skill discovery is enabled" "userprompt_pending: opp reminder"
  local state
  state="$(cat "$HOTSKILLS_PROJECT_CWD/.hotskills/state.json")"
  assert_contains "$state" "\"opportunistic_pending\":false" "userprompt_pending: flag cleared"
  teardown_fresh
}

# ─── Test 7: UserPromptSubmit + no pending + opp config off → only activated ───
test_userprompt_no_opp_no_pending() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json" <<'EOF'
{"version":1,"activated":[{"skill_id":"skills.sh:test/repo:skill-a","activated_at":"2026-04-23T10:00:00Z"}]}
EOF
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/state.json" <<'EOF'
{"version":1,"opportunistic_pending":false,"session_id":"abc"}
EOF
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "userprompt_no_opp: exit code"
  assert_contains "$out" "skill-a" "userprompt_no_opp: activated present"
  assert_not_contains "$out" "Opportunistic skill discovery" "userprompt_no_opp: no opp reminder"
  teardown_fresh
}

# ─── Test 8: SessionStart updates session_id and last_session_start_at ───
test_sessionstart_updates() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json" <<'EOF'
{"version":1,"activated":[{"skill_id":"skills.sh:test/repo:skill-a","activated_at":"2026-04-23T10:00:00Z"}]}
EOF
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/state.json" <<'EOF'
{"version":1,"opportunistic_pending":false,"session_id":"OLD-SESSION-ID"}
EOF
  "$HOOK" --event=SessionStart >/dev/null 2>&1
  local rc=$?
  assert_eq "$rc" "0" "sessionstart: exit code"
  local state
  state="$(cat "$HOTSKILLS_PROJECT_CWD/.hotskills/state.json")"
  assert_contains "$state" "last_session_start_at" "sessionstart: last_session_start_at present"
  assert_not_contains "$state" "OLD-SESSION-ID" "sessionstart: session_id refreshed"
  teardown_fresh
}

# ─── Test 9: corrupted config → exit 0, no stdout, log entry written ───
test_corrupted_config() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  printf 'not json{' > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json"
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "corrupted: exit code"
  assert_empty "$out" "corrupted: stdout empty"
  # Log should exist with config_parse_failed entry.
  local log="$HOTSKILLS_CONFIG_DIR/logs/hook.log"
  if [[ -f "$log" ]]; then
    local logtxt
    logtxt="$(cat "$log")"
    assert_contains "$logtxt" "config_parse_failed" "corrupted: log entry written"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("corrupted: log file not created at $log")
    echo "FAIL: corrupted: log file not created" >&2
  fi
  teardown_fresh
}

# ─── Test 10: missing event arg → exit 0, no output, log warn ───
test_missing_event() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  printf '{"version":1}' > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json"
  local out
  out="$("$HOOK" 2>/dev/null)"
  local rc=$?
  assert_eq "$rc" "0" "missing_event: exit code"
  assert_empty "$out" "missing_event: stdout empty"
  teardown_fresh
}

# ─── Test 11: description truncation at 80 chars ───
test_description_truncation() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  # 100-char description.
  local long="aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeeffffffffffgggggggggghhhhhhhhhhiiiiiiiiiijjjjjjjjjj"
  printf '{"version":1,"activated":[{"skill_id":"skills.sh:t/r:s","activated_at":"2026-04-23T10:00:00Z","description":"%s"}]}' "$long" \
    > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json"
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  # Truncated description must end with '…' and the rest of the long string after pos 79 must NOT appear in full.
  assert_contains "$out" "…" "trunc: ellipsis present"
  assert_not_contains "$out" "$long" "trunc: full long string absent"
  teardown_fresh
}

# ─── Test 12: runtime ≤200ms on 20-skill list (loose for slow CI) ───
test_runtime_budget() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  local entries=""
  for i in $(seq 1 20); do
    local ts; ts="$(printf '2026-04-23T10:%02d:00Z' "$i")"
    if [[ -n "$entries" ]]; then entries="$entries,"; fi
    entries="${entries}{\"skill_id\":\"skills.sh:t/r:s${i}\",\"activated_at\":\"${ts}\"}"
  done
  printf '{"version":1,"activated":[%s]}' "$entries" > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json"
  local start_ns end_ns dur_ms
  start_ns="$(date +%s%N 2>/dev/null || echo 0)"
  "$HOOK" --event=UserPromptSubmit >/dev/null 2>&1
  end_ns="$(date +%s%N 2>/dev/null || echo 0)"
  if [[ "$start_ns" != "0" && "$end_ns" != "0" ]]; then
    dur_ms=$(( (end_ns - start_ns) / 1000000 ))
    # Loose budget for CI noise: 1500ms; warn (not fail) if >200ms.
    if [[ "$dur_ms" -gt 1500 ]]; then
      FAIL=$((FAIL + 1))
      FAILURES+=("runtime_budget: $dur_ms ms exceeds 1500ms hard cap")
      echo "FAIL: runtime_budget: $dur_ms ms" >&2
    else
      PASS=$((PASS + 1))
      if [[ "$dur_ms" -gt 200 ]]; then
        echo "WARN: runtime_budget: ${dur_ms}ms exceeds 200ms typical (under hard cap)" >&2
      fi
    fi
  else
    # nanosecond timer unavailable — skip with PASS so test runner doesn't fail
    PASS=$((PASS + 1))
  fi
  teardown_fresh
}

# ─── Test 13: PostCompact with opportunistic OFF → only activated reminder, pending NOT set ───
test_postcompact_no_opportunistic() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json" <<'EOF'
{"version":1,"opportunistic":false,
 "activated":[{"skill_id":"skills.sh:t/r:s1","activated_at":"2026-04-23T10:00:00Z"}]}
EOF
  local out
  out="$("$HOOK" --event=PostCompact 2>/dev/null)"
  assert_contains "$out" "s1" "postcompact_no_opp: activated present"
  assert_not_contains "$out" "Opportunistic skill discovery" "postcompact_no_opp: no opp reminder"
  local state
  state="$(cat "$HOTSKILLS_PROJECT_CWD/.hotskills/state.json")"
  assert_contains "$state" "\"opportunistic_pending\":false" "postcompact_no_opp: pending stays false"
  assert_contains "$state" "last_compact_at" "postcompact_no_opp: last_compact_at updated"
  teardown_fresh
}

# ─── Test 14: global+project merged activated dedup; project newer wins ───
test_merged_dedup() {
  setup_fresh
  mkdir -p "$HOTSKILLS_PROJECT_CWD/.hotskills"
  cat > "$HOTSKILLS_CONFIG_DIR/config.json" <<'EOF'
{"version":1,
 "activated":[{"skill_id":"skills.sh:t/r:s1","activated_at":"2026-04-23T10:00:00Z","description":"OLD"}]}
EOF
  cat > "$HOTSKILLS_PROJECT_CWD/.hotskills/config.json" <<'EOF'
{"version":1,
 "activated":[{"skill_id":"skills.sh:t/r:s1","activated_at":"2026-04-23T11:00:00Z","description":"NEW"}]}
EOF
  local out
  out="$("$HOOK" --event=UserPromptSubmit 2>/dev/null)"
  assert_contains "$out" "NEW" "merged: project (newer) wins"
  assert_not_contains "$out" "OLD" "merged: global (older) suppressed"
  teardown_fresh
}

# ─── Run all ───
test_no_hotskills_dir
test_empty_allowlist
test_one_skill_reminder
test_overflow_cap
test_postcompact_opportunistic
test_userprompt_pending_cleared
test_userprompt_no_opp_no_pending
test_sessionstart_updates
test_corrupted_config
test_missing_event
test_description_truncation
test_runtime_budget
test_postcompact_no_opportunistic
test_merged_dedup

echo
echo "── inject-reminders.sh tests ──"
echo "Passed: $PASS"
echo "Failed: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  printf '\n%s\n' "${FAILURES[@]}" >&2
  exit 1
fi
exit 0
