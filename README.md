# Puffer

Puffer is an iPhone notes app that agents can read and write. Notes and any document folders you grant (txt, md, pdf) are stored on the phone and indexed there for hybrid vector and keyword search, with embeddings from EmbeddingGemma 2 running on the device through LiteRT-LM. The app downloads the model once (388 MB) on first launch; after that, indexing and search need no network.

Agents (Claude Code over MCP with OAuth, or anything that speaks HTTP) reach the phone through a small relay at `https://puffer.fly.dev`. The relay stores no content: it queues each request, the phone picks it up, runs it locally and sends the result back. An agent is approved once, when it connects; after that its requests are answered without asking again, and everything it does shows in History. See `design/ARCHITECTURE.md`.

The app is Expo SDK 55 (React Native 0.83) with `@expo/ui` SwiftUI screens, iOS only.

## Layout

- Repo root: the Expo app. `src/app` has the routes (tabs for notes, folders and agents, the connect modal), `src/notes.tsx`, `src/bridge.tsx` and `src/store.tsx` are the React views over the native module, and `src/ui/editor/` holds the Tiptap editor and the editor switch.
- `modules/puffer-native/`: the local Expo module. `ios/` has the note store, search engine, embedder, relay bridge and the native note editor (`ios/Editor/`), `app-target/PufferIntents.swift` the Shortcuts actions (copied into the app target by `app.plugin.js`), and `src/index.ts` the JS API.
- `relay/`: the Node relay (MCP, HTTP API, OAuth, device sync) and its own README.
- `design/`: architecture notes (`ARCHITECTURE.md`) and the note contract (`notes/CONTRACT.md`).
- `scripts/`: `fetch-litert.sh` and the editor Markdown checks (`editor-markdown-check/`).
- `TESTING.md` and `DEMO.md`: how to try it with real agents.

## Run the app

You need Xcode, CocoaPods, Node 24 and an iOS simulator runtime.

```sh
npm install
scripts/fetch-litert.sh   # LiteRT-LM binary and Swift sources into modules/puffer-native/ios/vendor/ (about 120 MB, gitignored)
npx expo run:ios
```

In the app, download the model when asked. A new install registers itself with `https://puffer.fly.dev`. After changing `app.json` or the module's podspec, run `npx expo prebuild --clean` before `npx expo run:ios`. For JS-only changes, `npm start` serves the dev build.

### Choosing the note editor

`EXPO_PUBLIC_PUFFER_EDITOR` selects the editor when Metro starts:

- unset or `native`: the native UITextView editor (default).
- `tiptap`: Tiptap in an Expo DOM component.
- `enriched`: the react-native-enriched-html spike, opened from the note route.

```sh
EXPO_PUBLIC_PUFFER_EDITOR=tiptap npx expo start --clear
```

## Run the relay locally

```sh
cd relay
npm install
npm run relay
```

Needs Node 24. Flags, the HTTP API and pairing a phone with a local relay are in `relay/README.md`.

## Tests

- `npm run test:editor` (Node 24): the Tiptap Markdown codec over 5000+ documents. The byte-for-byte comparison with the native parser runs only on a Mac, through `scripts/editor-markdown-check/run.sh`.
- `cd relay && npm run e2e`: starts the real relay, plays the phone and agents against it. `npm run typecheck` checks types.
- `npm run lint` and `npx tsc --noEmit` at the repo root.
- Device and agent checks (Claude Code, HTTP agents, Apple Notes Shortcut, comparing editors) are in `TESTING.md`.

## Not verified

The native code is built and run on a Mac or device, not in cloud sessions. Changes marked "Unverified (cloud)" in the Swift sources still need a Mac build.
