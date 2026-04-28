#!/usr/bin/env bash
# Phase 0 API smoke-test: verifies external API endpoints before Phase 2 work begins.
# Exits non-zero with structured JSON output on failure.
set -uo pipefail

# mktemp -d guarantees atomic creation of an unguessable directory under $TMPDIR
# (or /tmp). This closes the symlink/predictable-name race that a $$ PID
# suffix leaves open: PIDs are guessable, allowing a local attacker on a
# shared host to pre-create the path as a symlink.
_TMPDIR=$(mktemp -d -t hotskills-phase0-api-XXXXXX)
_cleanup() { rm -rf "$_TMPDIR"; }
trap _cleanup EXIT

FAILURES="[]"

add_failure() {
  local endpoint="$1" error="$2" status="${3:-0}"
  FAILURES=$(printf '%s' "$FAILURES" | node -e "
const fs = require('fs');
const failures = JSON.parse(fs.readFileSync('/dev/stdin','utf8'));
failures.push({endpoint: process.argv[1], error: process.argv[2], status: parseInt(process.argv[3])});
process.stdout.write(JSON.stringify(failures));
" "$endpoint" "$error" "$status")
}

# Test 1: skills.sh search API
SKILLS_HTTP=$(curl -o "$_TMPDIR/skills.json" -w "%{http_code}" -sf --max-time 10 \
  'https://skills.sh/api/search?q=react' 2>/dev/null || echo "000")

if [[ "$SKILLS_HTTP" != "200" ]]; then
  add_failure "skills.sh" "HTTP $SKILLS_HTTP returned" "$SKILLS_HTTP"
else
  # Validate JSON shape: {skills: [...], count: int}
  node -e "
const fs = require('fs');
const data = fs.readFileSync('"$_TMPDIR/skills.json"', 'utf8');
const d = JSON.parse(data);
if (!Array.isArray(d.skills)) { process.stderr.write('no skills array'); process.exit(1); }
if (typeof d.count !== 'number') { process.stderr.write('no count field'); process.exit(1); }
if (d.skills.length === 0) { process.stderr.write('empty skills array'); process.exit(1); }
const s = d.skills[0];
['id','skillId','name','installs','source'].forEach(k => {
  if (!(k in s)) { process.stderr.write('missing field: ' + k); process.exit(1); }
});
" 2>"$_TMPDIR/skills-err.txt" || {
    add_failure "skills.sh" "shape validation failed: $(cat "$_TMPDIR/skills-err.txt")" "200"
  }
fi

# Test 2: audit API
AUDIT_HTTP=$(curl -o "$_TMPDIR/audit.json" -w "%{http_code}" -sf --max-time 10 \
  'https://add-skill.vercel.sh/audit?source=vercel-labs/agent-skills&skills=react-best-practices' 2>/dev/null || echo "000")

if [[ "$AUDIT_HTTP" != "200" ]]; then
  add_failure "audit" "HTTP $AUDIT_HTTP returned" "$AUDIT_HTTP"
else
  # Validate AuditResponse shape: {<slug>: {<partner>: {risk: string}}}
  node -e "
const fs = require('fs');
const data = fs.readFileSync('"$_TMPDIR/audit.json"', 'utf8');
const d = JSON.parse(data);
const skills = Object.keys(d);
if (skills.length === 0) { process.stderr.write('empty audit response'); process.exit(1); }
const skill = d[skills[0]];
const partners = Object.values(skill);
if (partners.length === 0) { process.stderr.write('no partners in audit data'); process.exit(1); }
partners.forEach((p, i) => {
  if (typeof p !== 'object' || !('risk' in p)) {
    process.stderr.write('partner ' + i + ' missing risk field'); process.exit(1);
  }
});
" 2>"$_TMPDIR/audit-err.txt" || {
    add_failure "audit" "AuditResponse shape validation failed: $(cat "$_TMPDIR/audit-err.txt")" "200"
  }
fi

# Report results
FAILURE_COUNT=$(printf '%s' "$FAILURES" | node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.length));")

if [[ "$FAILURE_COUNT" -gt 0 ]]; then
  printf '{"status":"failed","failures":%s}\n' "$FAILURES"
  exit 1
fi

printf '{"status":"ok","endpoints_verified":["skills.sh","audit"]}\n'
