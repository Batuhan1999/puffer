#!/bin/bash
# Puffer agent demo: plain HTTP calls an agent makes against the relay, one scene at a time.
#   PUFFER_BASE      relay origin, default http://localhost:8787 (the hosted one is https://puffer.fly.dev)
#   PUFFER_KEY_FILE  file holding the agent's ak_ key, default demo-agent-key.txt next to this folder
#   PAUSE=1          wait for Enter between scenes
# Scenes 6 and 10 change files on the iPhone 17 Pro simulator, so run them on the Mac that runs it.
# Usage: demo.sh [scene...]   (no argument runs every scene)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=${PUFFER_BASE:-http://localhost:8787}
KEY=$(tr -d '[:space:]' < "${PUFFER_KEY_FILE:-$HERE/../demo-agent-key.txt}")
DEV=1D4B8ECF-A717-442E-9828-FCB3F93229DB
DOCS=$HERE/../demo-docs
AUTH=(-H "Authorization: Bearer $KEY")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { printf '\033[2m$ %s\033[0m\n' "$*" >&2; }
# Puffer answers an agent at most 5 times a minute without asking; past that, requests wait for review on the phone.
SENT=$HERE/.sent
pace() {
  local wait
  touch "$SENT"
  if [ "$(wc -l < "$SENT")" -ge 5 ]; then
    wait=$(( $(tail -5 "$SENT" | head -1) + 62 - $(date +%s) ))
    if [ "$wait" -gt 0 ]; then
      printf '\033[2m(waiting %ss: Puffer answers at most 5 requests a minute without asking)\033[0m\n' "$wait" >&2
      sleep "$wait"
    fi
  fi
  date +%s >> "$SENT"
}
ask() { pace; run "POST /v1/ask $1"; curl -s "$BASE/v1/ask" "${AUTH[@]}" -H 'Content-Type: application/json' -d "$1"; }
get() { [[ $1 == /v1/sources* ]] || pace; run "GET $1"; curl -s "$BASE$1" "${AUTH[@]}"; }
pause() { [ "${PAUSE:-0}" = 1 ] && read -r -p "(Enter for the next scene) " _ || true; }

# Status plus one line per item: title, kind, date, folder, and the matching passage.
items() {
  jq -r '"status: \(.status)  approved_by: \(.approved_by // "-")",
    (.items // [] | to_entries[] | "\(.key + 1). \(.value.title)  [\(.value.kind), \((.value.date // "")[:10]), \(.value.folder // .value.source // "")]\n   \((.value.text // "") | gsub("\\s+"; " ") | .[:160])")'
}

on_my_iphone() {
  local group
  for group in ~/Library/Developer/CoreSimulator/Devices/$DEV/data/Containers/Shared/AppGroup/*/; do
    [ "$(/usr/libexec/PlistBuddy -c 'Print :MCMMetadataIdentifier' "$group/.com.apple.mobile_container_manager.metadata.plist" 2>/dev/null)" = group.com.apple.FileProvider.LocalStorage ] &&
      echo "$group/File Provider Storage" && return
  done
}

# Puffer reads folders again when it becomes active, so bounce it through Settings.
rescan() {
  xcrun simctl launch "$DEV" com.apple.Preferences >/dev/null
  sleep 1
  xcrun simctl launch "$DEV" dev.local.puffer >/dev/null
  sleep "${1:-6}"
}

notes_with_edit() {
  jq '(.[] | select(.title == "Shopping list")) |= (.text += "- Oat milk\n" | .modified = (now | todate))' "$DOCS/notes.json"
}

scene1() {
  say "1. A question answered by meaning: how much was the deposit for the apartment?"
  ask '{"question": "apartment deposit"}' | items
}

scene2() {
  say "2. The whole document as text: the banana bread recipe"
  ask '{"question": "banana bread recipe", "include_documents": "text"}' |
    jq -r '"status: \(.status)", (.items[0] | "\(.title)\n---\n\(.document.text)")'
}

scene3() {
  say "3. The original file: the apartment lease PDF (name, type and size only, not the base64)"
  ask '{"question": "apartment lease agreement", "include_documents": "file"}' |
    jq -r '"status: \(.status)", (.items[] | select(.document.file) | .document.file | "\(.name)  \(.mime_type)  \(.data | length * 3 / 4 | floor) bytes")'
}

scene4() {
  say "4a. Filters: documents modified in September 2026"
  ask '{"question": "bill or invoice", "filters": {"kind": "document", "after": "2026-09-01", "before": "2026-10-01"}}' | items
  say "4b. Filters: only photos"
  ask '{"question": "receipt", "filters": {"kind": "photo"}}' | items
  say "4c. Filters: one source, Apple Notes"
  ask '{"question": "wifi password", "filters": {"source": "Apple Notes"}}' | items
}

scene5() {
  say "5. A photo with the image included (titles and sizes only)"
  ask '{"question": "boarding pass", "filters": {"kind": "photo"}, "include_images": true}' |
    jq -r '"status: \(.status)", (.images // [] | .[] | "\(.title)  \(.mime_type)  \(.data | length * 3 / 4 | floor) bytes")'
}

scene6() {
  local dir notice cursor first
  dir=$(on_my_iphone)
  notice="$dir/Home/building-notice.txt"
  if [ -e "$notice" ]; then rm "$notice"; "$DOCS/seed-notes.sh" >/dev/null; rescan; fi
  say "6. The change feed: first call returns recent changes and a cursor"
  first=$(get "/v1/changes?limit=5")
  jq -r '"status: \(.status)", (.events[] | "  \(.kind): \(.title)")' <<< "$first"
  cursor=$(jq -r .next_cursor <<< "$first")
  echo "next_cursor: $cursor"
  say "6. Meanwhile on the phone: a new file lands in On My iPhone/Home and the shopping list note is edited"
  printf 'Building notice, 14 Linden Row\nThe water will be shut off on Thursday 15 October 2026 from 09:00 to 13:00 for pipe maintenance.\nContact: Maria Okafor, Linden Row Properties, +00 555 0142.\n' > "$notice"
  notes_with_edit > "$HERE/.notes-edited.json"
  "$DOCS/seed-notes.sh" "$HERE/.notes-edited.json"
  rescan
  say "6. The same call with the cursor shows only what changed since"
  get "/v1/changes?since=$cursor&wait=25" | jq -r '"status: \(.status)  next_cursor: \(.next_cursor)", (.events[] | "  \(.kind): \(.title) [\(.item_kind // ""), \(.source // "")]")'
}

scene7() {
  say "7. Something that is not there: nothing_found"
  ask '{"question": "a violin"}' | jq -r '"status: \(.status)", .message'
}

scene8() {
  say "8. The agent-facing entry points need no key"
  run "GET /start"
  curl -s "$BASE/start" | head -c 600
  echo
  run "GET /openapi.json"
  curl -s "$BASE/openapi.json" | jq -r '"\(.info.title) \(.info.version)", (.paths | to_entries[] | .key as $p | .value | to_entries[] | "  \(.key | ascii_upcase) \($p)  \(.value.operationId)")'
}

scene9() {
  say "9. Latest notes: which sources exist, then the newest Apple Notes with their text"
  get "/v1/sources" | jq -r '"status: \(.status)", (.sources // [] | .[] | "  \(.name // .source): \(.count // .items // "")")'
  get "/v1/recent?source=Apple%20Notes&limit=5&include_documents=text" |
    jq -r '"status: \(.status)", (.items // [] | to_entries[] | "\(.key + 1). \(.value.title)  [\((.value.date // "")[:10])]\n   \((.value.document.text // .value.text // "") | gsub("\\s+"; " ") | .[:160])")'
}

scene10() {
  say "10. Latest notes about a topic: offline mode, newest first"
  ask '{"question": "offline mode", "filters": {"source": "Apple Notes"}, "sort": "recent"}' | items
}

scene11() {
  say "11. A note and a document together: when is the car due for its next service?"
  ask '{"question": "next car service"}' | items
  say "11. And: what do I still need for the Lisbon trip, and how much luggage can I take?"
  ask '{"question": "Lisbon trip luggage packing"}' | items
}

for scene in ${@:-1 2 3 4 5 6 7 8 9 10 11}; do
  "scene$scene"
  pause
done
