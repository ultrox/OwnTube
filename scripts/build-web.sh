#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --dir apps/backoffice build
pnpm --dir apps/chrome-extension build
