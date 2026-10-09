# Arena brief: Puffer product UI

You are one of several designers building competing versions of the same iOS app. Build your own version from scratch. Do not look at other candidates' folders.

## The product

Puffer is a private, on-device memory for your iPhone. It runs Google's EmbeddingGemma 2 (released 2026-10-06, open weights) on the phone through LiteRT-LM. One vector index holds the user's photos and the passages of documents they grant (folders in iCloud Drive or On My iPhone; txt, md, pdf). A text query in any language finds both photos and documents by meaning. Nothing leaves the phone.

What already exists and is not new: Apple Photos and Google Photos search photos by meaning. Siri on iOS 27 searches photos, mail and notes, but other agents cannot query that index. Google's AI Edge Gallery shipped "Instant Media Search" on iOS today with the same model, for photos and videos only. Ente and Queryable do on-device photo search with CLIP. Desktop has agent-queryable local indexes (Windows File Explorer MCP, Screenpipe); phones do not. What Puffer adds:
- Documents and photos in one space: "rental deposit" finds the contract PDF passage and the photo of the handover protocol.
- Cross-language: a query in one language finds documents written in another (the model covers 100+ languages).
- Visual search: "receipt from the bakery" finds the photographed receipt from pixels alone, with no OCR and no useful filename.
- More like this: any photo or passage can be the query.
- An agent bridge (concept, not built yet): personal agents such as Poke (iMessage assistant), Claude or ChatGPT ask Puffer a question through a small remote MCP relay. The phone shows the request, the user sees exactly which photos and snippets would be shared, and approves or denies each request. Only captions, snippets and explicitly approved images leave the phone. Never the index, never vectors. Users can also mark Collections (for example "Receipts", "Home", "Travel") as pre-approved for a given agent.

Primary user: someone with thousands of photos and a cluttered Files app who wants to find things by describing them ("the photo of the parking spot", "the deposit amount in my lease", "all receipts from last year") and is curious about letting an agent use that memory safely.

Use cases to design for: receipts and invoices, contracts (lease deposit, notice period), forms (passport photo page), warranty claims (receipt plus product photo), travel bookings and boarding passes, a photo of a vaccination card, "the wine label from that trip photo".

## The job

Design and build the whole app UI as a product, not a feature demo. It must look and behave like a first-party iOS 26 app built with native components. The current UI was React Native Paper and the user rejected it ("not these shit ones"). Use native iOS building blocks for everything you can.

Make your own product decisions about information architecture, navigation, onboarding, empty states and tone. Show the agent bridge as an honest concept surface: simulated requests are fine, but label them as a preview, and do not fake data flowing to real agents. Engine details such as the vector dimension (128/256/512/768), search mode (vector, keyword, hybrid) and timings belong behind a "Search settings" or "Engine" screen for power users, not on the main screen.

## What is available

All of these are installed and compiled into the current native build. Do not add any dependency. A new native module would need a rebuild you cannot run.

- Expo SDK 55, React Native 0.83, React 19.2, TypeScript. iOS only, deployment target 18.0. The simulator runs iOS 26.3.
- Expo Router with routes in `src/app/`. Native stack: `Stack` from `expo-router`, with `headerLargeTitleEnabled`, `headerSearchBarOptions` (a native UISearchController; on iOS 26 `placement` supports `integrated` and others), `headerTransparent` and `Stack.Toolbar`. Docs: https://docs.expo.dev/router/advanced/stack.md and https://docs.expo.dev/router/advanced/stack-toolbar.md
- Native tabs: `import { NativeTabs } from 'expo-router/unstable-native-tabs'` (SDK 55 path), with SF Symbol icons, `role` (for example a search tab), badges, and a bottom accessory. Docs: https://docs.expo.dev/router/advanced/native-tabs.md. Read the "SDK 55–57" variants of each example. Types: `node_modules/expo-router/build/native-tabs/`.
- Expo UI SwiftUI components: `import { Host, List, Section, Form, Button, Picker, Toggle, LabeledContent, ProgressView, Gauge, ContentUnavailableView, ContextMenu, Menu, DisclosureGroup, BottomSheet, Popover, ConfirmationDialog, Alert, ShareLink, Label, Text, Image, HStack, VStack, Spacer, Grid, GlassEffectContainer, Divider } from '@expo/ui/swift-ui'` plus modifiers from `@expo/ui/swift-ui/modifiers`. Every SwiftUI tree must sit inside a `<Host>`. Read the real prop types in `node_modules/@expo/ui/build/swift-ui/<Component>/index.d.ts` before using a component. Do not guess props. Docs: https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui.md
- `expo-image` (`Image` from 'expo-image') for photo thumbnails in fast grids, `expo-symbols` (`SymbolView`) for SF Symbols outside SwiftUI, `expo-glass-effect` (`GlassView`) for Liquid Glass surfaces, `expo-haptics`.
- React Native core (`FlatList`, `ScrollView`, `Pressable`, `PlatformColor`) where SwiftUI has no fit, such as a large virtualized photo grid. Use `PlatformColor('label')`, `'secondaryLabel'`, `'systemBackground'`, `'systemGroupedBackground'` and friends instead of hard-coded colors, so dark mode works.

## The data contract

Use only `@/store` and the types in `@/domain`. Do not edit anything under `src/` outside your own folder, and do not touch `modules/`.

- `PufferProvider` must wrap your root `_layout.tsx`.
- `usePuffer()` returns:
  - Model: `model` (one of `checking`, `absent`, `downloading {written,total}`, `loading`, `ready {loadMs, backend}`, `error {message}`), `ready`.
  - Library: `items` (all indexed `Item`s), `counts` (`{photo, passage}`), `folders` (`{id,name}[]`).
  - Jobs: `job` (`idle`, or `{kind: 'photos'|'documents'|'folders', progress: {done,total,failed}}`), `notice` and `dismissNotice()`.
  - Actions: `downloadModel()`, `retryModel()`, `indexPhotos()`, `addDocuments()`, `addFolder()`, `rescanFolders()`, `cancelJob()`, `clearIndex()`, `search(query, options)`.
- `useSearch(query, {mode, dim, rerank})` is debounced and returns `{result, searching, error}`. `query` is `{kind:'text', text}`, `{kind:'like', item}` or null.
  - `result.hits` is ordered best first. Each hit is `{item, score, similarity}`. `similarity` is the cosine at 768d, or null in keyword-only mode.
  - `result.timings` holds the embed, scan and rerank milliseconds and the index size.
  - Hybrid mode with dim 256 and rerank on is a good default.
- `Item` is `{id, kind: 'photo'|'passage', title, text?, sourceUri, thumbUri?, addedAt}`. Photos have a 256px JPEG `thumbUri`. A passage `title` is the file name, plus " p.N" for PDFs. `sourceUri` for folder files looks like `folder:<FolderName>/<path>`.
- There is no API yet for agent requests or collections. Model them as local, in-memory preview data inside your own folder, clearly labeled.

## Where to write

- Route files only under `design/<you>/app/`. This is a complete Expo Router tree, including `_layout.tsx`, and it gets copied into `src/app/` to run. Import shared code with the `@/` alias (it maps to `src/`), for example `import { usePuffer } from '@/store'`. Never use relative imports that climb out of the route tree.
- Components and helpers only under `src/ui/<you>/`.
- A short `design/<you>/RATIONALE.md` (at most 40 lines): your product thesis, the information architecture, the alternatives you considered and rejected, and anything you could not verify.

## Rules

- Before you finish, run `npx tsc --noEmit` and `npx expo lint` from the project root. Both must pass for your files. Other designers write into `design/` and `src/ui/` at the same time, so ignore errors in folders that are not yours.
- Do not run `expo start`, `expo run:ios`, prebuild, pod install, or anything that touches the simulator or `ios/`. Another process owns them.
- Do not install, remove or upgrade packages. Do not edit `package.json`, `app.json` or files outside your two folders.
- Keep comments to a non-obvious why. No narrating comments.
- Copy and labels in plain English. No lorem ipsum.
