#!/usr/bin/env bash
# Runs the full gate for a phase: format, lint, typecheck, tests, build. Prints only what failed.
set -uo pipefail
cd "$(dirname "$0")/.."
export NO_COLOR=1
status=0

step() {
  local name="$1"
  shift
  local out
  if out="$("$@" 2>&1)"; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    echo "$out" | grep -v '^$' | tail -n "${TAIL:-80}"
    status=1
  fi
}

step format pnpm format
step lint pnpm lint
step typecheck pnpm typecheck
step test pnpm test
step build pnpm build
step bundles node scripts/smoke-dist.mjs
exit $status
