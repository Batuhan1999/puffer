#!/bin/bash
# Syncs Apple Notes into Puffer on the simulator through the dev route, which calls the same native sync the
# "Sync Notes to Puffer" Shortcuts action calls. Usage: seed-notes.sh [notes.json]
# `created` is dropped so Library titles stay "<title>.txt" (with it, the file name carries the creation time).
set -euo pipefail
DEV=1D4B8ECF-A717-442E-9828-FCB3F93229DB
NOTES=${1:-$(dirname "$0")/notes.json}
DATA=$(xcrun simctl get_app_container "$DEV" dev.local.puffer data)
python3 -c 'import json,sys; print(json.dumps([{k: v for k, v in n.items() if k != "created"} for n in json.load(open(sys.argv[1]))]))' \
  "$NOTES" > "$DATA/Documents/dev-notes.json"
xcrun simctl openurl "$DEV" "puffer://dev-sync-notes"
echo "synced $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$NOTES") notes from $NOTES"
