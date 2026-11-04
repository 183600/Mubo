#!/usr/bin/env bash
# Repository hygiene checks.
#
# Temporary probe files (zz_*, tmp_*, scratch*, dbg*, probe*) must never be
# committed: they are only useful while debugging and would otherwise ship
# with the package.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[hygiene] skipped: not a git checkout"
  exit 0
fi

pattern='(^|/)(zz_|tmp_|scratch|dbg|probe)[^/]*$'
offenders="$(git ls-files | grep -E "$pattern" || true)"

if [ -n "$offenders" ]; then
  echo "[hygiene] temporary files must not be committed:" >&2
  echo "$offenders" >&2
  exit 1
fi

echo "[hygiene] ok"
