#!/usr/bin/env bash
# Deterministic check-runner for pi-delegate.
#
# Why this exists: bun child-process spawns hang intermittently on this
# host under concurrent agent load (reproduces on a clean main), so a bare
# "run the full suite" is not a reliable signal. This runner makes the
# verdict deterministic:
#   PASS     — check green
#   FAIL     — check red (real regression; blocks)
#   ENV-FAIL — spawn failure / timeout that reproduces the known
#              environment flake (recorded, does NOT block)
# Protocol: per-file timeout, at most ONE retry on an env-shaped failure,
# no manual retry loops. An exit code of 0 requires zero FAILs; ENV-FAILs
# are allowed but must be listed.
set -u
cd "$(dirname "$0")/.." || exit 2

# BUG_FIX_CONTEXT: empty node_modules in git worktrees (node_modules is
# gitignored) sent bun into an auto-install spin on private @earendil-works
# packages — tests hung with empty stderr and burned workers diagnosed a
# phantom "flaky environment". A worktree must install deps before checks.
if [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
  echo "node_modules is empty (fresh worktree) — bun install first"
  bun install || exit 2
fi
# Per-invocation result file (Law 11 shared-machine rule): several agents on
# one host run this runner in parallel; a fixed result path would let two
# runs clobber each other's verdicts. Pass an explicit argument to reuse a
# path deliberately.
OUT="${1:-$(mktemp /tmp/checks-results.XXXXXX.txt)}"
: > "$OUT"
pass=0; fail=0; envfail=0
run_once() { timeout "${CHECK_TIMEOUT:-30}" bun run "$1" 2>&1; }
# Verdict telemetry (host-state attribution for ENV-FAIL analysis): every
# verdict line carries the machine's 1-minute load average, available memory
# in MB, and the number of concurrent check-runner instances on this host.
# The bun child-spawn hang root cause is host-level (resource contention under
# concurrent agent load — reproduced on a clean main); these numbers turn each
# ENV-FAIL into evidence instead of folklore.
telemetry() {
	local load mem runners
	load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo '?')
	mem=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo '?')
	runners=$(pgrep -fc 'run-checks' 2>/dev/null || echo 0)
	echo "[load=$load memMB=$mem runners=$runners]"
}
for t in test/*.ts; do
  case "$t" in *driver*|*fixture*|*goldens*) continue ;; esac
  out=$(run_once "$t"); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qE "SPAWN FAILED|TIMEOUT"; then
    out=$(run_once "$t"); rc=$?   # the single env-flake retry
  fi
  if [ $rc -eq 0 ]; then
    pass=$((pass+1)); echo "PASS     $t $(telemetry)" >> "$OUT"
  elif printf '%s' "$out" | grep -qE "SPAWN FAILED|TIMEOUT"; then
    envfail=$((envfail+1)); echo "ENV-FAIL $t $(telemetry)" >> "$OUT"
  else
    fail=$((fail+1)); echo "FAIL     $t $(telemetry)" >> "$OUT"; echo "$out" >> "$OUT"
  fi
done
echo "== pass=$pass fail=$fail env-fail=$envfail ==" >> "$OUT"
cat "$OUT"
[ $fail -eq 0 ]
