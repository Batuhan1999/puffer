# Todo: EmbeddingGemma 2 on-device search demo (Prototype playbook)

## Playbook steps (verbatim)

- [x] 1. Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. No decision means no prototype. Route to Feature.
  - Decision A: which native runtime gives text and image EmbeddingGemma 2 embeddings inside an Expo dev build on iOS (llama.rn GGUF, onnxruntime-react-native ONNX, LiteRT-LM).
  - Decision B: which MRL dimension (128/256/512/768) and search mode (vector, keyword, hybrid) an on-device photo and document index should use.
- [ ] 2. Gather references when the design space is open. Search for prior art, summarize a moodboard of themes, palettes, and layouts, let the user pick directions before building. Skip when the direction is set.
  - skip: the user set the direction (option 3, Expo dev build, a component library, iPhone simulator).
- [x] 3. Build throwaway in an isolated scratch dir, separate from production source. For a visual decision, vanilla HTML/CSS/JS or the lightest stack that renders the idea, CDN deps, a dev server with hot reload. For a behavioral or timing decision, the smallest script that exercises the question. No production framework, no tests, no abstractions.
  - `prototype/` is the scratch dir. Expo plus React Native Paper is a user instruction and overrides "no production framework".
- [x] 4. When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap.
  - Switchers: MRL dimension, search mode (vector, keyword, hybrid), rerank at 768d on or off.
- [ ] 5. Verify on the matching surface. For a visual decision, screenshot each variant via the driver skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion.
  - Surface: iOS simulator. BLOCKED: Xcode is not installed (only Command Line Tools). The user installs it.
- [ ] 6. Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build.

## Task-specific

- [x] Runtime research agent reports (llama.rn vs onnxruntime-react-native vs LiteRT-LM vs transformers.js in RN).
  - Decision A: LiteRT-LM v0.18.0 Swift `EmbeddingEngine` in a local Expo module. llama.rn bundles a llama.cpp from before EmbeddingGemma 2 support and embeds text only. onnxruntime-react-native needs a hand-written tokenizer and image processor. transformers.js has no React Native backend.
- [ ] Architect pass. skip: the Prototype playbook says no planning; the data shape is named below and the build is throwaway.
- [x] Build delegated to a background poteto-agent (opus). Review its diff before reporting.
  - Reviewed `GemmaEmbedModule.swift`, the podspec, `src/domain.ts`, `src/model.ts`, `src/puffer.ts`, `scripts/fetch-litert.sh`. Model filename and size (387,710,976 bytes) match the Hugging Face API.
- [x] CocoaPods installed with Homebrew (needed by `npx expo run:ios`). Version 1.17.0. It warns the shell is not UTF-8, so build with `LANG=en_US.UTF-8 npx expo run:ios`.
- [x] User installs Xcode and selects it with `xcode-select`. Xcode 26.3 (17C529); license and first launch already done.
- [ ] iOS simulator platform download (`xcodebuild -downloadPlatform iOS`, running in the background).
- [x] Folder access (user request: "access to the document system files all"). iOS has no full file-system access, so the module adds a folder picker with a saved bookmark, a recursive scan for txt/md/pdf/jpg/png/heic, reads that trigger iCloud downloads, and "Rescan folders". `tsc` and lint pass.
- [x] `npx expo prebuild --platform ios` with pod install. `GemmaEmbed` pod linked.
- [ ] First `npx expo run:ios` on iPhone 17 Pro (iOS 26.3.1 simulator).
  - Build 1 failed in Expo's `expo-modules-jsi` 57.1.1, not our code. 57.0.5 added `SWIFT_RETURNS_RETAINED` on `RuntimeScheduler` constructors for Xcode 27 (expo/expo#49120); Xcode 26.3 (Swift 6.2.4) rejects it. macOS 15.7 caps the App Store Xcode at 26.3.
  - Patch 1 (node_modules, unpersisted): removed the two annotations. Original saved in scratchpad `RuntimeScheduler.h.orig`. C++ errors gone.
  - Build 2 failed with 7 Swift 6.2 region-isolation errors ("sending 'resultPtr' risks causing data races") in `JavaScriptRuntime.swift`, likely from 57.0.6 non-escaping `assumeIsolated`.
  - Patch 2 (node_modules, unpersisted): `swiftLanguageModes: [.v5]` in `expo-modules-jsi/apple/Package.swift`. Original saved as `Package.swift.orig`.
  - Build 3 failed with new errors (regex literal in Swift 5 mode, actor-isolated init). Premise attacked: Expo's version table says SDK 57 and 56 need Xcode 26.4+, SDK 55 needs 26.2+. Xcode 26.4 needs macOS Tahoe 26.2+, and this Mac runs macOS 15.7.5. Patching stopped.
  - Ported to Expo SDK 55 (expo 55.0.31, React Native 0.83.10, React 19.2.0). `expo-media-library/next` `Query.exe()` plus `Asset.getInfo()` replace `exeForMetadata()`; `expo-file-system/legacy` `createDownloadResumable` replaces `File.createDownloadTask`. `tsc`, lint, `expo-doctor` 20/20 pass. The node_modules patches were discarded with the reinstall.
  - Build 4 (SDK 55) succeeded and launched. Model download worked (388 MB in ~110 s). Model load failed with "GemmaEmbed is iOS only": the pod was silently skipped ("gemma-embed doesn't support iOS platform" in `pod install --verbose`) because the podspec asked for iOS 16.4 and an SDK 55 app targets 15.1. LiteRT's xcframework needs iOS 15.0, so the podspec now says 15.1.
  - Build 5 running with `GemmaEmbed` installed.
- [x] Demo content staged in the simulator: 14 photos from the Xenova/transformers.js-docs dataset renamed to `IMG_xxxx`, and `On My iPhone/Notes` with 8 documents (German and English, one PDF).
- [x] Name the data shape: `Item { id, kind: 'photo' | 'passage', title, text?, sourceUri, thumbUri?, addedAt }` in `src/domain.ts`, plus a vector segment `Float32Array(N x 768)` with per-dimension truncated views in `src/puffer.ts`.
- [x] Photos: `expo-media-library` full-library read with permission, batch indexing with progress.
- [x] Documents: `expo-document-picker` for txt, md, pdf; chunk text into passages.
- [x] Search: query prefix `task: search result | query: {q}`, doc format `title: {t} | text: {c}`, vector scan at the chosen dimension, BM25 for docs, RRF fusion, optional rerank at 768d, timings shown in the UI.
- [ ] Run on the iOS simulator, screenshot each switcher variant, log embed and scan timings.
- [x] Local Expo module `modules/gemma-embed` wraps LiteRT-LM v0.18.0 `EmbeddingEngine` (vendored Swift sources plus `CLiteRTLM.xcframework` from `scripts/fetch-litert.sh`) and PDFKit.
- [x] Static checks: `npx tsc --noEmit` exit 0, `npx expo-doctor` 21/21, `npx expo lint` exit 0, `npx expo prebuild --platform ios --no-install` exit 0 (generated `ios/` deleted afterwards), Swift typecheck of the runtime actor plus vendored LiteRT sources against the macOS SDK.
- [ ] `npx expo run:ios` builds the pod with the vendored xcframework. BLOCKED: Xcode.

## Round 2: product UI on native components, use cases, prior art

User asks (2026-10-06): run on own iPhone with full photo access; rebuild the UI as a product with native components (not React Native Paper); research use cases such as personal agents (Poke, Instinct) querying the on-device index; check prior art. iOS only.

Investigation (two background poteto-agents, opus):
- [x] Prior art: on-device personal photo/document search, memory layers, mobile vector DBs, EmbeddingGemma on phones. Closest: Google AI Edge Gallery Instant Media Search (same model, iOS, today, media only); Apple Photos/Siri (closed to outside agents); Windows File Explorer MCP (desktop).
- [x] Agent access: which agents exist, how an iOS app can expose the index (App Intents, MCP, per-query consent), ranked use cases. Recommendation: per-query consent behind a thin remote MCP relay (tools `search`, `fetch`), plus `IndexedEntity` for Siri; never upload vectors (Vec2Text inversion).

Arena skill phases (verbatim):
- [x] 1. Frame (`design/BRIEF.md`; rubric in scratchpad `arena-rubric.md`)
- [x] 2. Fan out (a: opus, b: fable, c: sonnet)
  - First fan-out stopped: the brief carried a Germany/tax persona I inferred from the user's email domain and simulator locale. The user did not ask for it. Brief neutralized, stale outputs moved to scratchpad `stale-arena/`, candidates relaunched fresh. Feedback memory saved.
- [x] Decision B (search mode), observed on candidate c: RRF hybrid ranked `bike-insurance-claim.txt` first and the bakery receipt photo last for "receipt from the bakery" (photos have no text, so they never get a keyword rank). Replaced RRF with 768d similarity + 0.1 x normalized BM25, plus a relative cutoff (top similarity - 0.1, at least 3 hits). Same query now returns 3 hits: receipt photo, bike claim, invoice photo.
- [ ] Engine quality finding (needs a real eval, Explain the Number): English query "What was the deposit amount in the lease?" ranks the German `mietvertrag-notizen.txt` second, behind a receipt photo and the bike claim. Cross-language retrieval looks weaker than the model card suggests on this setup (LiteRT bundle, likely quantized). Not measured beyond this one query.
- [x] Demo content: German tax and rental notes moved to scratchpad `demo/retired/`; neutral `expenses-2025.md` and `lease-notes.txt` added; Lisbon note no longer names a departure city. Index needs Clear + re-index after the graft lands.
- [x] Community sources (user asked to check X and others): HN, Reddit, GitHub, Hugging Face, Product Hunt, X via search engines (running). Live X search needs a login; asked the user to sign in to the browser pane or allow Claude in Chrome.
- [x] 3. Cross-judge (fable): a 26, c 24, b 23; recommends a
- [x] 4. Pick: a (`design/SYNTHESIS.md`); judge and parent agree on base and on a's crash root cause
- [x] 5. Graft (fresh poteto-agent, opus): Link.Menu crash fixed, b's interleaved rows and grouped suggestions, c's Recently Added and approval label, drops per SYNTHESIS; a moved into src/app and src/ui
- [x] 6. Verify on the iOS 26.3 simulator (index cleared and rebuilt from 20 photos + 8 neutral notes):
  - Collection with photos opens; long-press shows the native menu (Find Similar, Not in This Collection). Crash gone.
  - "receipt from the bakery": one ranked list, receipt photo, bike claim, expenses note, invoice photo. Photos scope shows the 3-up grid.
  - "the deposit amount in my lease": lease-notes.txt first.
  - Find Similar on the invoice photo: bakery receipt photo first, then three related notes.
  - Grouped suggestions and Recent render; Recently Added lists files; captions gray.
  - Read New Photos shows progress in the tab bar accessory ("8 of 20"), then "Indexed 20 new photos"; folder check "Indexed 8 new files".
  - Request review: "Approve and Share 3 Snippets", per-item toggles.
  - Found and fixed during verify: passage rows lost all layout because a function style inside `Link asChild` is dropped by Slot's style merge; now a plain style.
  - Open: the request review pre-selects the top 3 hits even when the third is irrelevant (mochi-vet.txt for a deposit question), because the engine keeps at least 3 hits. Default selection should follow relevance.

Foundation done before the arena:
- [x] Expo Router with routes in `src/app/` (AGENTS.md), entry `expo-router/entry`, scheme `puffer`, iOS deployment target 18.0 via expo-build-properties, `platforms: ["ios"]`.
- [x] Removed `App.tsx`, `index.ts`, React Native Paper, react-native-web, react-dom, expo-image-picker, @expo/vector-icons.
- [x] Added @expo/ui (SwiftUI), expo-router (native tabs via `expo-router/unstable-native-tabs` on SDK 55), expo-symbols, expo-glass-effect, expo-image, expo-haptics.
- [x] `src/store.tsx`: `PufferProvider`, `usePuffer()`, `useSearch()`; the one data contract every design uses.
- [x] `scripts/use-design.sh <x>` copies `design/<x>/app/` into `src/app/` so designs swap without a native rebuild.
- [x] Native rebuild with the new packages. Placeholder SwiftUI list renders with a large title; index persisted (20 photos, 8 passages).
- [ ] Phone: user adds Apple ID in Xcode, connects iPhone, enables Developer Mode; then a Release build with the JS bundle embedded.

## Round 3: agent bridge and system access (Feature playbook)

User asks (2026-10-07): "do the agent bridge and the better access to the app". Read as (1) a working agent bridge with per-request consent, (2) Siri, Shortcuts and Spotlight access through App Intents.

Feature playbook steps (verbatim):
- [ ] 1. `how` over the affected subsystem.
  - skip: the parent built or reviewed every touched module this session; grounding written to `design/bridge/GROUNDING.md` instead.
- [x] 2. `architect` for parallel design exploration. Base a (judge 26 / 20 / 19, parent agreed); amendments in `design/bridge/SYNTHESIS.md`.
- [x] 3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
  - **Blocking first steps.** The wire protocol in `a/DESIGN.md` (sync endpoint, envelopes, tool shapes) is fixed before fan-out; it is the only contract the two workstreams share. Inside the native workstream, the spike and the `Engine` parity unit block everything after them.
  - **Independent workstreams.** (1) Native: `modules/` (pod rename, Engine, Bridge, Triage, Egress, Relay client, hooks, app-target intents, plugin) plus `src/` wiring and `app.json`. (2) Relay: new `relay/` package (protocol, registry, mailbox, MCP tools, server, e2e script with a fake phone). Disjoint files.
  - **Shared mutable state.** The simulator, Metro and `ios/` belong to the native owner only. The relay owner never touches them and tests against a fake phone. The wire protocol is read-only for both; a change goes through the parent and updates `SYNTHESIS.md`.
  - **Smallest safe decomposition.** Two owners. Native is code-coupled (engine, bridge, intents and UI share types and one build), so one owner sequences it internally. The relay has no native dependency, so it runs in parallel. Worktrees are not available (the session root is not a git repository); separation is by directory and by the rule above.
- [ ] 4. Delegate code-writing to a subagent using your configured feature model (default in poteto-mode's Models section) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria).
- [ ] 5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
- [ ] 6. Rebase into small, ordered commits. Stack follow-ups.
  - skip: the user has not asked for commits in this project; changes stay uncommitted for review.
- [ ] 7. If the design is contested, `interrogate` before shipping.
- [ ] 8. Run **Opening a PR**.
  - skip: no remote and no request for a PR; local prototype.

Architect phases:
- [x] Ground (`design/bridge/GROUNDING.md`)
- [x] Sketch (arena: a opus retry after a stalled first attempt, b fable, c sonnet; cross-judge fable)
- [x] Agree (no checkpoint requested; proceed)
- [ ] Implement
- [ ] Scrap (only if the sketch fails in implementation)

Relay workstream (opus owner): done. `relay/` typechecks; `npm run e2e` 30/30 (parent ran it). Binds 127.0.0.1 only. MCP SDK v2. Wait budget 50 s, read from the Claude Code MCP docs. Additive wire fields (`broaden`, `photosWithheld`) and pinned formats recorded in a/DESIGN.md reconciliation and sent to the native owner. Not yet run against the simulator app.

Pause points:
- Exposing the relay publicly (tunnel or deploy) sends personal data off the Mac. Needs the user's explicit go-ahead.

User amendments (2026-10-07), recorded as SYNTHESIS 13-14 and sent to the native owner mid-run:
- [ ] 13. Sources sync themselves: incremental photo indexing (change observer, catch-up on launch/foreground/background refresh), granted folders rescanned automatically, onboarding suggests granting iCloud Drive and On My iPhone at the top level.
- [ ] 14. Agent access levels: ask every time (default), selected collections, everything; separate "include photos" switch (default off).
- Note: "allow auto reading" was first applied to Claude Code itself (23 read-only allow rules in ~/.claude/settings.json, backup in scratchpad). The user meant Puffer. Offered to revert; awaiting their answer.

Round 3 verification (parent, 2026-10-07):
- [x] 4. Native owner (opus) built units 1-6 and amendments 13-14; parity 30/30 (log in scratchpad); evidence screenshots for Shortcuts, Check Agent Requests and Spotlight reviewed.
- [x] 5. Verified end to end on the simulator with the real relay and an MCP client: pairing, agent key, review with per-item toggles, approve, auto answer under "Everything", photos withheld, offline queue answered after relaunch.
- [x] Fixed during verification: consent oversharing (relevance window for offered candidates), `approvedBy` on the wire, sync loop not starting on cold launch. Recorded in a/DESIGN.md.
- [ ] Not built or not exercised: ShowCollectionIntent, tapping a review notification, rate limit, a real BGAppRefreshTask run, Spotlight opt-in (Spotlight currently shows passage snippets system-wide).
- [ ] 7. interrogate: not run (design was not contested; the arena already had a cross-judge).
- skip 6 and 8: no commits or PR requested.
- [x] Minimum confidence (user, 2026-10-07): per-kind floor 0.65 text / 0.68 photo on agent consent and Siri/Shortcuts results, calibrated on 30 labeled queries; unanswerable questions now return nothing_found. Recalibrate on the real library (thin photo margin).
- [ ] Defaults round (user, 2026-10-07; opus owner running): photos + files as one default onboarding step (folder picker at the top of iCloud Drive / On My iPhone, "Add another location", Library prompt), first full index as a charging BGProcessingTask, 388 MB model moved out of iCloud backup (index stays backed up). Videos and low-power/thermal checks out of scope.
- [x] Defaults round done by the opus owner, re-verified by the parent on the simulator (model location + backup flag, Info.plist, onboarding flow, top-level On My iPhone pick, subfolder indexing via agent ask, no duplicates; Library prompt and background task from the owner's evidence). Cosmetic: a granted subfolder (Notes) still lists separately under its granted parent: onboarding asks photos then folder picker with "Add Another Location"; Library prompt when no folder; model + 290 MB caches moved to Application Support/Model, excluded from backup; index and thumbs stay backed up; BGProcessingTask registers, handler verified via debugger only (simulator refuses to schedule). On My iPhone top level can be picked; iCloud Drive untested (signed out). Nested grants no longer double-index. Evidence: scratchpad/defaults/d1-d14.
- [ ] Next: "Open in Puffer" (CFBundleDocumentTypes for pdf/text/images, files copied to a "Shared with Puffer" folder and indexed). Not started; usage limit reached.
- [ ] Later: thumbnails from PhotoKit instead of copies (~370 MB per 20k photos), smaller vectors (256d or int8), backup toggle for index/thumbs.
- [ ] Changes round (user, 2026-10-07; opus owner running): change log in puffer.db (added/updated/removed, monotonic seq, 90-day retention, stale cleanup on rescan), MCP tool get_puffer_changes(since) via relay with phone-side consent (titles only for items the agent may read; hiddenCount otherwise), Library "Recent Changes", "Open in Puffer" (document types, Shared with Puffer folder), hide nested grants. Architect arena skipped: additive to the existing design, one obvious shape, user is watching usage.
- [ ] Clarified (user): agents should learn about new documents the way email agents learn about new mail. Gmail model = content-free watch ping (historyId) + delta fetch. get_puffer_changes is the delta fetch; per-agent `changeHeads` (newest visible seq) added to the sync body in the running round. Next round: per-agent "Notify this agent" webhook (Poke webhook triggers support this), content-free and batched; Claude Code channels as an option (research preview); Correction (2026-10-07 search): ChatGPT does have one. Since DevDay 2026-09-29 it supports MCP Events (protocol 2026-07-28), webhook delivery only.
- [ ] Dots and similar (user, 2026-10-07: "also to connect to dots or similar"). Dots (OpenAI, DevDay 2026-09-29) have no public API. Third-party data reaches a dot as an MCP plugin in ChatGPT (pull, OAuth 2.1) plus MCP Events (push). MCP Events: events/list, events/subscribe {name, arguments, delivery {url, secret whsec_}, cursor}, events/unsubscribe; occurrence {eventId, name, timestamp, data, cursor}; Standard Webhooks HMAC-SHA256 signing; signed single-use challenge before a subscription activates; refreshBefore renewal; callback must be public HTTPS. Puffer shape: one event `puffer.changes`, data content-free {newChanges, head}, cursor = the agent's change head; the dot then calls get_puffer_changes(since) and the phone decides consent. Notification round = one relay-side sink registry keyed by kind (mcpEvents webhook, Poke webhook, Claude Code channel), fired when an agent's change head advances. Open problem: the dot's follow-up call arrives after the phone suspends. Proposal: the phone attaches the already-consented changes page for grant-covered agents to the same sync, held in relay memory like answers (never disk). Real Dots/ChatGPT need the hosted relay (public HTTPS, OAuth 2.1): needs the user's go-ahead. Local proof: e2e with a loopback webhook receiver behind a dev flag.
- [ ] Hosted relay now (user, 2026-10-07: "we could already host the server and work on the phone locally"). Answer: yes, the phone already dials out and accepts https relays. Prep after the changes round lands (same relay files): configurable bind host/port, registry state on a persistent volume (or device key digest from a secret), single always-on instance (in-memory mailbox, 50 s long-polls; no serverless), Dockerfile, health route. Recommended host Fly.io (*.fly.dev TLS, small volume). Waiting on: user installs flyctl and logs in; deploy only after the user confirms. Then OAuth 2.1 with approval in Puffer, then MCP Events. Claude Code works with ak_ bearer keys as soon as it is hosted.
- [ ] Nudge when the wake fails (user, 2026-10-07). Layer 1, free: the phone_offline result (relay/src/mcp.ts:105) tells the agent to ask the user to open Puffer, with a content-free https link on the hosted relay (/open/<request id> redirecting to puffer://request/<id>; Puffer.open(.request) already exists for notification taps). Poke texts it, Dots posts it, Claude Code prints it. Layer 2, optional: the relay's own content-free alert (ntfy, email or Telegram, user's choice and go-ahead) for proactive agents with no conversation open. One nudge per request, pending requests collapsed into one, never the question text. Ladder with the paid account: online -> silent push -> visible notification -> nudge. Build after the changes round (same relay files).
- [x] Changes round verified by the parent (2026-10-07): get_puffer_changes against the live relay answered in 26 ms with added/updated/removed events and hidden_count 2; Library Recent Changes renders with removed rows dimmed. Found: a file shared from a granted folder is indexed twice (changes seq 8/9 and 10/11), which also doubles search hits and change events.
- [ ] Notify round (opus owner, 2026-10-07): U1 nudge on phone_offline + /open/<id>; U2 hosting prep, no deploy; U3 MCP Events webhook push on change-head advance; U4 consented changes page cached in relay memory so a pushed agent's follow-up works while the phone sleeps; U5 per-agent Poke-style webhook sink configured on the phone; U6 dedupe shared files by content. Claude Code channels skipped: research preview behind a launch flag, and U3/U5 already prove the push path with a loopback receiver. Architect skipped: MCP Events fixes the wire shape, the user is watching usage.

## Notify round (opus owner, 2026-10-07; Feature playbook)

Feature playbook steps (verbatim):
- [ ] 1. `how` over the affected subsystem.
  - skip: the owner read every touched relay and native module this round (relay/src/*, e2e, Bridge, Relay, Triage, Sources, Folders, PufferModule, agent screen); DESIGN.md reconciliation is the grounding.
- [ ] 2. `architect` for parallel design exploration.
  - skip: MCP Events fixes the wire shape, and the user is watching usage (same call as the todo line above).
- [x] 3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
  - **Blocking first steps.** The wire additions (changePages, notify in the registry snapshot, wantsRegistry and readCursors in the sync response, heads on every sync) are fixed in the relay brief before either side writes code. They are the only contract the two workstreams share.
  - **Independent workstreams.** (1) Relay: `relay/` (U1 link and /open, U2 hosting, U3 MCP Events, U4 page cache, U5 webhook sink, e2e). (2) Native: `modules/puffer-native/`, `src/` (U3 heads every sync, U4 pages, U5 Notify setting, U6 dedupe). Disjoint files.
  - **Shared mutable state.** The simulator, Metro and the relay on 127.0.0.1:8787 belong to the owner only. The relay delegate tests on port 0 and never touches them. Worktrees are not available (not a git repository); separation is by directory.
  - **Smallest safe decomposition.** One opus delegate for the relay (verifiable alone through e2e and docker). The owner writes the native side, because every native unit ends in a simulator check the owner holds.
- [x] 4. Delegate code-writing to a subagent using your configured feature model (default in poteto-mode's Models section) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria).
  - Relay delegated to one opus owner (sink union in notify.ts, e2e 54/54). Native written by the round owner, because every native unit ended in a simulator check the owner held; no independent review of the native diff.
- [x] 5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
  - U1-U6 verified on the simulator against the real relay, U2 in Docker. Evidence in scratchpad/round-notify/.
- [ ] 6. Rebase into small, ordered commits. Stack follow-ups.
  - skip: not a git repository; no commits requested.
- [ ] 7. If the design is contested, `interrogate` before shipping.
  - skip: not contested; MCP Events fixed the wire shape. One deviation from the brief (410 keeps the subscription, per the spec) is recorded in DESIGN.md.
- [ ] 8. Run **Opening a PR**.
  - skip: no remote and no request for a PR; local prototype.

Units: U1 nudge + /open, U2 hosting prep, U3 MCP Events push, U4 consented page cache, U5 webhook sink, U6 dedupe shared files.

Notify round done (2026-10-07). All six units built and checked; details, wire additions and gaps in design/bridge/a/DESIGN.md "Notify round".
- [x] U1 nudge: phone_offline and waiting_for_user carry open_url; /open/<id> lands on the review screen through Safari's "Open in Puffer?".
- [x] U2 hosting prep: env config, Dockerfile, fly.toml, README Hosting; docker build and /healthz checked; nothing deployed.
- [x] U3 MCP Events: verified subscription, signed content-free event on a new file, follow-up get_puffer_changes returns it.
- [x] U4 page cache: offline changes call answered in 6 ms from the phone's prepared page; uncovered cursor gets phone_offline plus link.
- [x] U5 webhook sink: Notify setting on the agent screen; POST with bearer token; survives a relay restart (wantsRegistry, first sync answered at once).
- [x] U6 dedupe: sharing a file already in On My iPhone indexes nothing and logs no change.
- [ ] Open: SSRF hardening for hosted callbacks (DNS/IP checks), subscription caps, OAuth 2.1, terminated/gap envelopes, dedupe on grant (not only on import), webhook token in the Keychain.
- [x] Notify round verified by the parent (2026-10-07): relay e2e 54/54 rerun; phone_offline result carries the nudge and open_url; receiver.log shows signed MCP Events and bearer webhook pings with data {head} only; Notify section renders on the agent screen. Native side had no independent review (owner wrote it; prototype, user asked for no deep verification). Open: OAuth, deploy (waits on the user's Fly login and go-ahead), private-address check on callbacks, webhook token in Keychain, root container.
- [ ] OAuth round (user, 2026-10-07: "yeah build it"; opus owner): MCP authorization on the relay (protected resource metadata, AS metadata, DCR, PKCE S256, resource indicator), approval on the phone with a matching code, access level chosen on the phone, the access token is a relay-minted ak_ key whose digest enters the phone's registry (relay never stores the raw key). Local only, no deploy. Architect skipped: the MCP auth spec fixes the shape; usage. Independent security review of the auth code before any deploy.

## OAuth round (opus owner, 2026-10-07; Feature playbook)

Feature playbook steps (verbatim):
- [ ] 1. `how` over the affected subsystem.
  - skip: the owner read every touched module (relay/src/*, e2e, Bridge, Relay, SystemHooks, PufferModule, index.ts, agent screens) and the MCP 2026-07-28 authorization spec pages (copies in scratchpad/round-oauth/spec/).
- [ ] 2. `architect` for parallel design exploration.
  - skip: the MCP authorization spec fixes the endpoints and parameters; the parent's brief fixed the pending-connection shape; usage (same call as the todo line above).
- [x] 3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
  - **Blocking first steps.** The wire is fixed before either side writes code: `SyncResponse.connects: [{id, clientName, clientHost, redirectHost, code, keyDigest, requestedAt, expiresAt}]`, `SyncBody.connectDeclines?: [id]`, and approval derived from the registry snapshot carrying the connection's key digest (no approve outcome).
  - **Independent workstreams.** (1) Relay: `relay/` (oauth module, routes, wire, e2e, README). (2) Native and UI: `modules/puffer-native/`, `src/`. Disjoint files.
  - **Shared mutable state.** The simulator, Metro and the relay on 127.0.0.1:8787 belong to the owner only. The relay delegate tests on port 0. Not a git repository, so separation is by directory.
  - **Smallest safe decomposition.** One opus delegate for the relay (verifiable alone through e2e), so the security-relevant auth code gets a second pair of eyes (the owner reviews the diff). The owner writes native and UI, because every native unit ends in a simulator check the owner holds.
- [x] 4. Delegate code-writing to a subagent using your configured feature model (default in poteto-mode's Models section) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria).
  - Relay delegated to one opus owner (connection phase union in oauth.ts, e2e 69/69, 8 planted bugs caught); the round owner reviewed the diff and reran typecheck and e2e. Native and UI written by the round owner; no independent review of that diff.
- [x] 5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
  - U1 and U2 by e2e plus curl; U3 and U4 on the simulator against the relay on 8787 with an SDK OAuth client. Evidence in scratchpad/round-oauth/. Not verified: notification tap, real ChatGPT or Claude Code clients, an https metadata document.
- [ ] 6. Rebase into small, ordered commits. Stack follow-ups.
  - skip: not a git repository; no commits requested.
- [ ] 7. If the design is contested, `interrogate` before shipping.
  - skip: not contested within the round; the auth code still needs the independent security review named below before any deploy.
- [ ] 8. Run **Opening a PR**.
  - skip: no remote and no request for a PR; local prototype.

Units: U1 discovery and registration, U2 authorize and token with phone approval, U3 phone UI and native, U4 end to end with an SDK OAuth client.

OAuth round done (2026-10-07). Details, wire additions and gaps in design/bridge/a/DESIGN.md "OAuth round".
- [x] U1 discovery and registration: path-aware and root resource metadata, RFC 8414 metadata, 401 challenge, DCR, metadata documents.
- [x] U2 authorize and token: approval by registry digest, PKCE S256, single-use 60 s codes, decline, expiry, revocation; e2e 69/69.
- [x] U3 Puffer: approval screen with code and access level, Agents tab row and badge, notification, puffer://connect/<id>.
- [x] U4 SDK OAuth client end to end on the simulator: ask_puffer and get_puffer_changes answered; 401 after Disconnect.
- [ ] Before any deploy: independent security review of relay/src/oauth.ts and the OAuth wiring in server.ts.
- [ ] Open: private-address check for metadata documents and callbacks, metadata cache, connection-request spam on the phone, revoke the token on code reuse, dead agent after an unredeemed approval.
- [x] OAuth round verified by the parent (2026-10-07): e2e 69/69 rerun; live /mcp 401 carries resource_metadata; AS metadata advertises PKCE S256, CIMD and DCR; screenshots show the matching code on the page, the notification and the Connect Agent screen. Before deploy: independent review of relay/src/oauth.ts and the server.ts routes (list in DESIGN.md "OAuth round"), plus the native connect diff (unreviewed). Known gaps: reused code does not revoke the issued token, an approved-but-unredeemed connection leaves an orphan agent, pending connections lost on relay restart, no private-address check on metadata fetches.
- [x] Hardening round (user, 2026-10-07: "the fixes you can do"; Siri ShowCollectionIntent dropped, "not needed for now"). Step 1: independent read-only reviews (opus on relay security, sonnet on the native side), neither wrote the code. Step 2: one opus owner fixes review findings + known gaps (revoke token on code reuse, orphan agent after unredeemed approval, private-address checks for callbacks and metadata docs, subscription caps, connect-request spam, webhook token to Keychain, non-root container, rate limit + History for change reads since the agent screen promises "Each answer still shows up in History") + app fixes (dimmed "Added" row after an edit in Recent Changes, hide the dev "Simulate" button, clear the test review "a printed receipt"). Spotlight opt-in still waits on the user.
- [x] Hardening round done by the owner (2026-10-07): all 12 relay and 13 phone review findings fixed, none disputed; G4 done (revokedKeys for unredeemed approvals and replayed codes, change reads in History with a 10/min limit, Simulate behind EXPO_PUBLIC_PUFFER_DEV=1, "a printed receipt" denied). The pairing code is typed in Puffer and checked on the relay (POST /v1/device/connects/<id>/confirm, 3 tries); WireConnect.code removed. e2e 84/84. Simulator: pair link confirmation, typed code with one wrong attempt, unredeemed approval removed, window-cleaning.txt row live, change reads in History. Details and gaps in DESIGN.md "Hardening round". Open: lock-screen banner text, pages on every sync, connections and revokedKeys lost on relay restart, Dockerfile not built.
- [ ] Deploy (user logged in to Fly 2026-10-07, named the app "puffer"): app `puffer` created in the personal org (no machines), fly.toml set to app puffer, primary_region fra (nearest Fly edge measured via debug.fly.dev), PUFFER_PUBLIC_URL https://puffer.fly.dev. Docker image rebuilt after hardening: /healthz 200, pairing link written to /data/pairing-link.txt, relay drops to the node user via setpriv. Waiting on: HTTP API round, then the user's explicit go for the volume + deploy.
- [ ] HTTP API round (user: "add normal http to the relay so instinct can connect"; opus owner): POST /v1/ask, GET /v1/answers/{id}, GET /v1/changes, public /openapi.json, header-only bearer auth, shared agent-operations core with MCP. Instinct's public docs do not confirm custom MCP or authenticated HTTP requests.
- [x] Deployed (2026-10-07): https://puffer.fly.dev, one machine in fra, volume puffer_state; simulator paired via the confirm screen; POST /v1/ask answered through the hosted relay (mochi-vet.txt); pairing-link.txt deleted after the first sync. Local DNS had cached NXDOMAIN from the name check; fixed by waiting / flushing.
- [ ] Connect by message round (user: "keeping the http but doing better guided flow than copying the key"; opus owner): GET /start agent instructions, POST /v1/connect -> approve link /c/<secret> -> puffer://connect/<id>?link=, phone approval without a code for link-origin, agent polls /v1/connect/<id>/token for the key (RFC 8628 style). Then redeploy to Fly. User pasted an Instinct ak_ key into the chat: rotate it (disconnect + reconnect via the new flow).
- [ ] Open question to the user: a second agent named "Claude Code" (Ask Every Time) connected via the local relay ~21:21, not by the parent. Ask whether it is theirs before removing anything.
- [ ] Question phrasing (user 2026-10-07: Instinct's questions "don't match anything"). Measured via the hosted relay: "a dog"/"dog" -> answered (dog photo withheld + mochi-vet.txt), "recipes" -> banana-bread.md; "Is there an image of a dog in my photos?" and "Do I have any recipes in my files, notes or photos?" -> nothing_found; "What kinds of documents and notes are in my library?" -> nothing_found (an overview question, search cannot answer it). Cause: the 0.68 floor was calibrated on short queries; conversational questions dilute the query embedding. Now: agent texts tell agents to send 2-6 word descriptions (sent to the connect-round owner). Decision (user): query expansion is the agent's job, no phone-side rewriting. Agent texts now tell agents to expand the request into 1-3 short queries (sent to the connect-round owner). Still open: a consent-filtered library overview tool for "what's in my library" questions; an optional batch field so one expanded request is one review.
- [ ] Search round (user 2026-10-07: "yes that is a good idea with the question answering and also index the metadata of that document"; batch field declined: "no thats fine"). Starts after the connect round lands (same Xcode project). (1) EmbeddingGemma task prompt: question-like queries use `task: question answering | query:`, descriptions keep `task: search result | query:`; calibrate on the 30 queries in both phrasings, a floor per prompt, or both-and-max if it separates better. (2) Metadata per item: documents (path, folder, type, created/modified, PDF title/author/keywords), photos (taken date, screenshot/selfie/portrait/live/panorama, favorite, albums, camera; location stored on the phone only, never shared or embedded). Searchable via keyword index + agent filters (kind, after/before, source); returned to agents within consent; shown on the item screen. Re-embed documents once.
- [x] Search round done (2026-10-07). Calibration (scratchpad/round-search/calib-table.txt): the question-answering prompt did not separate full questions (no prompt does on this library), so search keeps the search-result prompt and the 0.68 floor. Metadata indexed and backfilled, passages re-embedded once, ask filters {kind, after, before, source} on MCP and POST /v1/ask, shared items carry date/folder/file_type/albums. Verified: Swift build, app tsc, relay typecheck, one calibration run, metadata rows in the simulator db. Not verified: e2e, the item screen, filters end to end, PDF attributes on a PDF that has them.
- [x] Connect-by-message + search rounds deployed (2026-10-07) to https://puffer.fly.dev; app rebuilt on the simulator with both; one ask through the hosted relay answered with metadata (date, folder). QA task prompt measured and not adopted (moved scores <= 0.02; full-sentence phrasing collapses the gap for every prompt), floor stays 0.68. Not run: the link connect flow end to end, filters end to end, item screen look.
- [x] User confirmed (2026-10-07): Instinct connected through the connect-by-message link flow on the hosted relay ("ok worked").
- [x] Phone round (2026-10-07, user's iPhone 13 Pro, free Personal Team 6Z8WY4U8PP, Release build via xcodebuild + devicectl): relay reset to the phone (old registry kept as /data/registry.json.simulator-bak), progress view, pipelined photo indexing (6 in flight, local-first fetch, per-photo timing line), Photos on/off switch that removes indexed photos, files before photos, swipe to remove a folder, full-size photo on the item screen, agent image_size original (2 per answer, 15 MB each). Relay deployed. Measured before: ~22 photos/min (400 of 20k, 15 h left). Speed-up not measured yet. Free build expires 7 days after install.
- [ ] Pivot (user 2026-10-09): Puffer becomes an Apple-Notes-like notes app (Notes first tab; Library/Agents stay) whose notes agents can read and write with per-agent write permission (Off / Ask / Allowed), conflict check via version, deletes to Recently Deleted. Import: Shortcut (Find Notes -> Sync Notes to Puffer, text only), share-sheet Markdown (iOS 26 Export as Markdown). Not importable: images/scans/drawings/attachments, checklist state, tables, locked notes, note links; no two-way sync (Shortcuts can only create/append). Plus multi-tenant relay: phones self-register, per-tenant mailbox/registry/limits, connections claimed by the phone that opens the link. Two opus owners in parallel (relay owns relay/ and writes design/notes/CONTRACT.md first; app owns app/native). Then deploy, install on the iPhone.
- [x] Analysis (2026-10-09): interrogate (opus + sonnet) verdict delivered; architecture map in design/ARCHITECTURE.md. Relay incident: registry.json got a stray "n" from my ssh quoting while restoring the iPhone tenant; relay down ~4 min; repaired; iPhone is tenant 2 again with its old agents.
- [ ] Apple Notes 1:1 (user 2026-10-09: "we need all features from apple notes", import broken, white header). Round A (shell): no tab bar, Folders root with Documents/Agents rows, seamless headers, bottom toolbars, compose in folder, move/pin/sort/Recently Deleted, tolerant Shortcuts import (files/rich text/text), dev warning. Round B (editor): native UITextView editor with document model + Markdown serializer, full formatting incl. highlights, quotes, lists, checklists, links, tags, attachments (photos, camera, scan, files, drawings), tables, find, share/PDF, conflict-safe saves. Waiting on the user's Shortcut error message. Not buildable: iCloud sharing, Quick Note gestures; later: Math Notes, audio, locking, note links.
- [x] Round B (editor) done (2026-10-09, opus owner): native UITextView/TextKit 2 editor in modules/puffer-native/ios/Editor (own Expo module `PufferEditor`), one document model + one Markdown codec (`NoteMarkdown`), conflict-safe `NoteSession` (base version + line merge), route renders src/ui/editor/NoteEditor.tsx. Verified on simulator 1D4B8ECF in light and dark: typing, title/heading/body, B/I/U/S, highlights, numbered/checklist lists, checkbox tap persists `- [x]`, agent-written Markdown (tables, quotes, mono, links, note links, tags, image + PDF attachments) renders, note link opens, table insert, fold/unfold heading, drawing saved as PNG + .drawing, Lines & Grids, Find, empty note purged on leave; stored Markdown read back from notes.db. Codec checker: scripts/editor-markdown-check/run.sh. Not exercised at runtime: agent-conflict merge (unit-checked only), photo/camera/scan/file pickers, share/PDF/print, swipe indent, `>>` picker, Writing Tools. `updateNote` (save without base) removed from PufferModule and JS. Open: NoteText.preview in Notes.swift shows raw `*`/`<u>` in list rows (round C file).
- [ ] PAUSED by the user (2026-10-09, "stop the work for now"). State at the stop:
  - Done and verified: round B native editor (modules/puffer-native/ios/Editor/*, selectable with EXPO_PUBLIC_PUFFER_EDITOR=native), round C phone review fixes, round D relay fixes (deployed to puffer.fly.dev, e2e 109/109), round A import + background gate (verified on its own simulator), round A shell (no tab bar, dark mode, toolbars, sort, move).
  - Stopped mid-way: Tiptap editor (src/ui/editor/TiptapEditor.tsx, TiptapNoteView.tsx, extensions/, markdown.ts, session.ts; simulator build succeeded, editor pass not done) and it is the DEFAULT editor in NoteEditor.tsx while unverified; enriched spike (react-native-enriched-html installed and in Pods, src/ui/editor-enriched/, dev route; round trip not measured, highlight patch not done).
  - Not installed on the iPhone yet: shell round, editors, import fix. The user's existing Shortcut must re-add "Sync Notes to Puffer" after the new build.
  - Open decision: which editor (native custom / Tiptap / patched enriched). Metro still running on 8081.
- [ ] Offline write changelog (user 2026-10-09; relay side and e2e built 2026-10-09, see relay/README.md "Offline writes" and design/notes/CONTRACT.md 3a; Swift side written unverified, validate on the Mac; still open: encryption at rest and persistence, the TODO in relay/src/protocol.ts): when the phone is offline, agent WRITE operations (create_note, append_to_note, update_note, delete_note) go into a temporary changelog on the relay instead of failing with phone_offline; when the phone comes back online it pulls the changelog and merges it into notes.db, then the relay drops it. Design notes to settle before building:
  - Agent answer while offline: status "queued" with the request id and a note id for creates (relay-minted, the phone keeps it), so the agent can continue; get_note/search cannot see queued writes until the merge (or the relay overlays its pending writes on reads for that agent).
  - Merge on the phone in order per note, idempotent by request id (the applied table from round C): append is commutative; update carries base_version and, if the user edited meanwhile, goes through the line merge (NoteSession merge) instead of failing; delete goes to Recently Deleted; creates keep the relay-minted id.
  - Privacy: this puts note content on the relay while the phone is away. Keep it encrypted at rest (key per tenant, derived from the device key so only that phone can decrypt), memory-first with a persisted encrypted copy so a restart does not lose writes, TTL (e.g. 7 days), size caps per tenant; History on the phone shows "written while offline, merged at ...".
  - Agent texts and /start: explain "queued while the phone is offline, applied when it comes back".
