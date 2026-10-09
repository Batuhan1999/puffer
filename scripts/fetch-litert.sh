#!/usr/bin/env bash
set -euo pipefail

TAG=v0.18.0
SHA256=d765b99592d4ec3d0c9e2bd69469454af06c834861340672da1891c0c121c347
SOURCES=(Benchmark Config Conversation EmbeddingEngine EmbeddingEngineConfig Engine ExperimentalFlags LiteRTLMError Message ModelInfo ResponseFormat Tool ToolManager)

VENDOR="$(cd "$(dirname "$0")/.." && pwd)/modules/puffer-native/ios/vendor"
mkdir -p "$VENDOR/LiteRTLM"

for name in "${SOURCES[@]}"; do
  out="$VENDOR/LiteRTLM/$name.swift"
  if [ ! -s "$out" ]; then
    curl -fsSL "https://raw.githubusercontent.com/google-ai-edge/LiteRT-LM/$TAG/swift/$name.swift" -o "$out.part"
    mv "$out.part" "$out"
  fi
done

if [ ! -f "$VENDOR/CLiteRTLM.xcframework/Info.plist" ]; then
  zip="$VENDOR/CLiteRTLM.xcframework.zip"
  curl -fL "https://github.com/google-ai-edge/LiteRT-LM/releases/download/$TAG/CLiteRTLM.xcframework.zip" -o "$zip.part"
  echo "$SHA256  $zip.part" | shasum -a 256 -c -
  rm -rf "$VENDOR/CLiteRTLM.xcframework"
  unzip -q "$zip.part" -d "$VENDOR"
  rm "$zip.part"
fi

echo "LiteRT-LM $TAG ready in $VENDOR"
