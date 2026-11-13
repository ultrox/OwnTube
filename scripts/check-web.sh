#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--e2e" ) ]]; then
  echo "Usage: scripts/check-web.sh [--e2e]" >&2
  exit 2
fi
./scripts/build-web.sh
pnpm --dir apps/chrome-extension test
(cd server && cargo test --locked)
if [[ "${1:-}" == "--e2e" ]]; then
  (cd server && pnpm test:e2e)
fi
