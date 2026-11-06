#!/usr/bin/env bash
# Package an ALREADY BUILT isolated release. No tests, installs, or agent execution.
set -euo pipefail
umask 077
if [[ $# != 2 ]]; then
  printf 'Usage: %s <built-app-directory> <new-output.tar.gz>\n' "$0" >&2
  exit 2
fi
src=$(realpath "$1")
dest=$(realpath -m "$2")
deps=$(realpath "$src/node_modules")
[[ -f "$src/.next/BUILD_ID" && -f "$src/package.json" && -d "$deps" ]]
[[ $(basename "$deps") == node_modules ]] || { echo 'Expected a node_modules directory' >&2; exit 1; }
[[ ! -e "$dest" ]]
case "$dest" in "$src/.next/"*|"$src/bin/"*|"$src/public/"*|"$deps/"*) echo 'Output must be outside packaged directories' >&2; exit 1;; esac
mkdir -p "$(dirname "$dest")"
# Explicit allow-list: no .git, project instructions, .env, user homes, native
# auth/config/history, private deployment state, or web message projections.
tar --exclude='.next/cache' --exclude='.next/dev' --exclude='*/.cache' \
  --exclude='*.map' --exclude='*/.env*' --exclude='*/auth.json' \
  --exclude='*/.credentials.json' --exclude='*/.npmrc' \
  -czf "$dest" -C "$src" .next public bin package.json package-lock.json next.config.ts tsconfig.json \
  -C "$(dirname "$deps")" node_modules
sha256sum "$dest" > "$dest.sha256"
printf 'Created %s\nRebuild native dependencies on the destination if its Node ABI or platform differs.\n' "$dest"
