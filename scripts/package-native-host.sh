#!/usr/bin/env bash
# Archive the already-built canonical workspace under .local/. No external release tree.
set -euo pipefail
umask 077
if [[ $# != 2 ]]; then
  printf 'Usage: %s <built-app-directory> <new-output.tar.gz>\n' "$0" >&2
  exit 2
fi
root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
node "$root/bin/workspace-location.js"
src=$(realpath "$1")
dest=$(realpath -m "$2")
[[ "$src" == "$root" ]] || { echo 'Only ~/code/omp-web may be packaged' >&2; exit 1; }
case "$dest" in "$root/.local/"*) ;; *) echo 'Archives belong under ~/code/omp-web/.local/' >&2; exit 1;; esac
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
printf 'Created local archive %s\nRestore only into the canonical workspace during an authorized maintenance window.\n' "$dest"
