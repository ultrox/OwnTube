#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "" && "${1:-}" != "--check" ]]; then
  echo "Usage: scripts/sync-upstream.sh [--check]" >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash local changes before checking/merging upstream." >&2
  exit 1
fi
git fetch upstream
if [[ "${1:-}" == "--check" ]]; then
  # Git reports conflicts without modifying the branch, index, or working tree.
  git merge-tree --write-tree HEAD upstream/master
else
  git merge --no-edit upstream/master
  git submodule update --init --recursive
  echo "Upstream merged. Review directory renames and root workflow/docs conflicts."
  echo "Run the checks in apps/android/owntube/README.md before installing or pushing."
fi
