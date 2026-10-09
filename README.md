# Puffer

Puffer is a throwaway iOS demo for EmbeddingGemma 2. It keeps one vector index of your photo library and of document passages from txt, md, and pdf files. A text query finds both. The app downloads the model once (388 MB) on first launch. After that, embedding and search run on the phone with no network.

The app is Expo SDK 57 with React Native Paper. The local Expo module in `modules/puffer-native` holds the item store, ranking, the LiteRT-LM v0.18.0 Swift `EmbeddingEngine`, the agent bridge and the system hooks.

## Build and run on the iOS simulator

You need Xcode, CocoaPods, and an iOS simulator runtime.

1. Download the LiteRT-LM binary and Swift sources:

	```sh
	scripts/fetch-litert.sh
	```

	The script writes `modules/puffer-native/ios/vendor/` (about 120 MB, gitignored), checks the zip's SHA-256, and skips files that already exist.

2. Build and launch the app:

	```sh
	npx expo run:ios
	```

3. In the app, tap **Download model**, then tap **+** and choose **Index photos** or **Add documents**.

To change `app.json` or the module's podspec after the first build, run `npx expo prebuild --clean` before `npx expo run:ios`.

## How the code is laid out

- `src/domain.ts` has the `Item`, `Query`, and `SearchResult` types.
- `src/store.tsx` and `src/bridge.tsx` are the React views over the native module. Screens use only these.
- `src/ingest.ts` imports picked documents. Photos and granted folders are indexed natively.
- `src/model.ts` downloads the model to the path the native engine names.
- `modules/puffer-native/ios/PufferEngine.swift` stores items, embeds, and ranks. `Bridge.swift`, `Triage.swift` and `Relay.swift` hold agent policy, consent and the relay sync. `Sources.swift` keeps photos and folders indexed. `SystemHooks.swift` holds background, notification and Spotlight hooks.
- `modules/puffer-native/app-target/PufferIntents.swift` holds the App Intents. The module's config plugin copies it into the app target at prebuild.

## What is not verified yet

No one has built or run this app. Each item below needs a simulator or device run.

- The pod builds with the vendored `CLiteRTLM.xcframework` (a dynamic framework) inside a `static_framework` pod, and CocoaPods embeds it in the app.
- The CPU backend loads the model on the simulator. On a device, the module tries the GPU backend first and falls back to CPU.
- `computeEmbeddingBatch` accepts text batches. If it throws, the module embeds texts one at a time.
- `.imageFile` accepts the JPEG files that `expo-image-manipulator` writes.
- The Hugging Face download follows its redirect and reports a total size.
- The prompt format comes from the model's `config_sentence_transformers.json`. Queries use `task: search result | query: ` and passages use `title: {title} | text: `. The LiteRT-LM docs page lists different prefixes (`task: search query | text: `). If search quality is poor, try those.
- Photo indexing speed, memory use, and how iCloud-only photos behave.
