#!/bin/bash
# Checks the note editors' Markdown on the Mac. main.swift: the native parser, serializer and merge (expected parses,
# fixed points, 3000 random documents, checklist and table edits, three-way merges). tiptap.mjs: the Tiptap editor's
# port (src/ui/editor/markdown.ts) against the native one byte for byte, and through the Tiptap schema.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
EDITOR="$HERE/../../modules/puffer-native/ios/Editor/NoteDocument.swift"
swiftc -O -o "$OUT/check" "$EDITOR" "$HERE/main.swift"
"$OUT/check"
swiftc -O -o "$OUT/normalize" "$EDITOR" "$HERE/normalize/main.swift"
node "$HERE/tiptap.mjs" "$OUT/normalize"
