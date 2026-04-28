#!/usr/bin/env bash
# phase0-lock-test.sh — Phase 0 verification for the on-disk lock primitive
# (per ADR-003 §Phase 0 verification items).
#
# Spawns N=5 background node subshells, each calling acquireLock on the
# SAME directory, sleeping 200ms while holding it, then releasing. If
# the primitive is correct, the 5 acquires must SERIALIZE — the timeline
# of (acquired_at, released_at) intervals must not overlap, and exactly
# one process holds the lock at any moment.
#
# Pass criteria:
#   - All 5 acquires succeed (no LockTimeoutError).
#   - No two intervals overlap (sorted by acquired_at, each released_at
#     <= next acquired_at).
#   - Total wall-clock duration ~= 5 * 200ms (= 1000ms) ± slack.
#
# Exit 0 on pass; non-zero with a diagnostic on fail.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR/server"

# Build dependencies: cache.ts must be compiled. Build is idempotent.
if [[ ! -f dist/cache.js ]]; then
  echo "Building server (dist/cache.js missing)…"
  npm run build >/dev/null 2>&1 || { echo "FAIL: npm run build"; exit 1; }
fi

TMPROOT="$(mktemp -d -t hotskills-lock-test.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

LOCK_DIR="$TMPROOT/lock_target"
mkdir -p "$LOCK_DIR"

RESULTS_DIR="$TMPROOT/results"
mkdir -p "$RESULTS_DIR"

N=5
HOLD_MS=200

# Worker script: loads the compiled cache module via dynamic import,
# acquires the lock, holds it for HOLD_MS, releases, and writes its
# (acquired_at, released_at, worker_id) JSON line to a per-worker file.
WORKER_JS="$TMPROOT/worker.mjs"
cat > "$WORKER_JS" <<'EOF'
import { acquireLock, releaseLock } from './dist/cache.js';

const [, , lockDir, holdMs, workerId, outPath] = process.argv;
const hold = parseInt(holdMs, 10);

const handle = await acquireLock(lockDir, 30000);
const acquiredAt = Date.now();
await new Promise((resolve) => setTimeout(resolve, hold));
const releasedAt = Date.now();
releaseLock(handle);

await import('node:fs').then(({ writeFileSync }) => {
  writeFileSync(outPath, JSON.stringify({ workerId: parseInt(workerId, 10), acquiredAt, releasedAt }) + '\n');
});
EOF

# Symlink worker to live alongside dist/ so dynamic import resolves.
cp "$WORKER_JS" "$ROOT_DIR/server/_phase0_lock_worker.mjs"
trap 'rm -f "$ROOT_DIR/server/_phase0_lock_worker.mjs"; rm -rf "$TMPROOT"' EXIT

PIDS=()
for i in $(seq 1 "$N"); do
  out="$RESULTS_DIR/worker-${i}.json"
  ( node "$ROOT_DIR/server/_phase0_lock_worker.mjs" "$LOCK_DIR" "$HOLD_MS" "$i" "$out" ) &
  PIDS+=($!)
done

# Wait for all workers; collect exit codes.
fail_count=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    fail_count=$((fail_count + 1))
  fi
done

if [[ "$fail_count" -gt 0 ]]; then
  echo "FAIL: $fail_count of $N workers exited non-zero (likely LockTimeoutError)"
  exit 1
fi

# Sanity: all result files exist.
for i in $(seq 1 "$N"); do
  if [[ ! -s "$RESULTS_DIR/worker-${i}.json" ]]; then
    echo "FAIL: worker-${i}.json missing or empty"
    exit 1
  fi
done

# Validate non-overlap with node — sort intervals by acquired_at,
# assert each released_at <= next acquired_at.
node - <<NODE_EOF
import('node:fs').then(({ readdirSync, readFileSync }) => {
  const dir = '$RESULTS_DIR';
  const intervals = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(\`\${dir}/\${f}\`, 'utf8')))
    .sort((a, b) => a.acquiredAt - b.acquiredAt);
  for (let i = 1; i < intervals.length; i++) {
    const prev = intervals[i - 1];
    const cur = intervals[i];
    if (cur.acquiredAt < prev.releasedAt) {
      console.error('FAIL: overlap between worker', prev.workerId, 'and', cur.workerId);
      console.error('       prev released_at=', prev.releasedAt, ' cur acquired_at=', cur.acquiredAt);
      process.exit(2);
    }
  }
  // Total span: should be at least N * holdMs (= 1000ms) since acquires
  // serialized; allow generous upper bound for CI noise.
  const span = intervals[intervals.length - 1].releasedAt - intervals[0].acquiredAt;
  const minExpected = $N * $HOLD_MS - 50; // 50ms slack
  if (span < minExpected) {
    console.error('FAIL: total span', span, 'ms is less than', minExpected, 'ms — workers did not serialize');
    process.exit(3);
  }
  console.log('PASS: phase0-lock-test —', $N, 'workers serialized over', span, 'ms');
});
NODE_EOF
NODE_RC=$?
exit $NODE_RC
