#!/bin/bash
# Connects an agent by message: asks the relay to connect, opens the approve link in the simulator, waits for the
# approval in Puffer, and saves the key. Usage: PUFFER_BASE=https://puffer.fly.dev connect-agent.sh [name] [key file]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=${PUFFER_BASE:-http://localhost:8787}
NAME=${1:-Demo Agent}
OUT=${2:-$HERE/../demo-agent-key.txt}
DEV=1D4B8ECF-A717-442E-9828-FCB3F93229DB
connect=$(curl -sf "$BASE/v1/connect" -H 'Content-Type: application/json' -d "$(jq -n --arg n "$NAME" '{name: $n}')")
id=$(jq -r .connect_id <<< "$connect")
poll=$(jq -r .poll_token <<< "$connect")
xcrun simctl openurl "$DEV" "$(jq -r .approve_url <<< "$connect")"
echo "Approve \"$NAME\" in Puffer on the simulator (Safari asks to open Puffer first)."
for _ in $(seq 1 120); do
  reply=$(curl -s -X POST "$BASE/v1/connect/$id/token" -H "Authorization: Bearer $poll")
  key=$(jq -r '.key // .access_token // empty' <<< "$reply")
  if [ -n "$key" ]; then
    (umask 077 && echo "$key" > "$OUT")
    echo "Saved the key to $OUT"
    exit 0
  fi
  status=$(jq -r '.status // .error // empty' <<< "$reply")
  case "$status" in declined | expired | expired_token | access_denied) echo "Connection $status"; exit 1 ;; esac
  sleep 5
done
echo "Timed out waiting for approval"
exit 1
