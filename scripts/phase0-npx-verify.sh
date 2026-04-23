#!/usr/bin/env bash
# Phase 0 npx-skills behavior smoke-test.
# Verifies that 'npx skills add --target <dir>' works as expected per ADR-002.
# RISK-FIRST: if --target is not supported, this script exits non-zero with a
# structured diagnostic and blocks Phase 2 work.
set -uo pipefail

TMPDIR_BASE="/tmp/hotskills-phase0-verify-$$"
mkdir -p "$TMPDIR_BASE"

cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

fail() {
  local assertion="$1" detail="$2"
  printf '{"status":"failed","assertion":"%s","detail":"%s"}\n' "$assertion" "$detail"
  exit 1
}

# Step 1: Check if npx / skills are available
if ! command -v npx >/dev/null 2>&1; then
  fail "npx_available" "npx not found on PATH; run hotskills-setup to install Node 22"
fi

if ! command -v skills >/dev/null 2>&1 && ! npx --no-install skills --version >/dev/null 2>&1; then
  fail "skills_available" "skills CLI not found; install with: npm install -g skills"
fi

# Step 2: Check if --target flag exists in 'skills add' help output
ADD_HELP=$(skills add vercel-labs/agent-skills --list 2>&1 || true)
if skills --help 2>&1 | grep -q '\-\-target'; then
  TARGET_SUPPORTED=true
else
  TARGET_SUPPORTED=false
fi

if [[ "$TARGET_SUPPORTED" == "false" ]]; then
  # This is the critical Phase 0 finding: --target does not exist.
  # ADR-002 assumes 'npx skills add --target <dir>' is valid; this is incorrect.
  # The available flags are: -g/--global, -a/--agent, -s/--skill, -y/--yes, --copy
  # This blocks Phase 2 tasks 2.4 (npx-skills-wrapper.sh) and 3.3 (materialization engine).
  # Resolution options (for ADR update):
  #   A. Use --agent <custom-agent-name> with a synthetic agent config pointing to target dir
  #   B. Use --copy flag to a custom agent directory registered via skills config
  #   C. Clone the GitHub repo directly (git sparse-checkout) instead of using skills CLI
  #   D. Use skills find + manual download from skills.sh blob API (vendored blob.ts)
  printf '%s\n' '{
  "status": "failed",
  "assertion": "target_flag_exists",
  "detail": "--target flag not found in skills CLI. ADR-002 assumption invalid.",
  "available_flags": ["-g/--global", "-a/--agent <agent>", "-s/--skill <skill>", "-y/--yes", "--copy", "--all"],
  "blocking_tasks": ["2.4 npx-skills-wrapper.sh", "3.3 materialization engine"],
  "resolution": "ADR-002 must be updated. Consider using --agent <custom-dir> or direct git clone for skill materialization.",
  "skills_cli_version": "1.5.1"
}'
  exit 1
fi

# If --target IS supported (future version), verify behavior:
SKILL_TARGET="$TMPDIR_BASE/skill-content"
mkdir -p "$SKILL_TARGET"

skills add vercel-labs/agent-skills --target "$SKILL_TARGET" -s react-best-practices -y 2>/dev/null || {
  fail "target_accepted" "skills add --target returned non-zero exit code"
}

if [ -z "$(ls -A "$SKILL_TARGET" 2>/dev/null)" ]; then
  fail "files_present" "target dir is empty after skills add --target"
fi

GLOBAL_PATHS=("$HOME/.claude/skills" "$HOME/.cursor/skills" "$HOME/.config/skills")
for GPATH in "${GLOBAL_PATHS[@]}"; do
  if find "$GPATH" -name 'react-best-practices*' 2>/dev/null | grep -q .; then
    fail "no_global_write" "skill written to global path $GPATH despite --target usage"
  fi
done

printf '{"status":"ok","assertions_passed":["target_flag_exists","target_accepted","files_present","no_global_write"]}\n'
