#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
design="${1:?usage: scripts/use-design.sh <a|b|c|...>}"
src="$root/design/$design/app"
[ -d "$src" ] || { echo "no route tree at $src" >&2; exit 1; }
rsync -a --delete "$src/" "$root/src/app/"
echo "src/app now holds design $design"
