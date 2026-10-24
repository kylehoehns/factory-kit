#!/usr/bin/env bash
# PostToolUse: format and fix the file that was just edited, so formatting never reaches review.
set -euo pipefail

file=$(jq -r '.tool_input.file_path // empty')
[[ "$file" =~ \.(ts|json)$ && -f "$file" ]] || exit 0

cd "$(git rev-parse --show-toplevel)"
npx --no-install biome check --write "$file" >/dev/null 2>&1 || true
