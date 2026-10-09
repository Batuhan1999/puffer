# Agent bridge and system access, candidate b

Facts are labelled as in GROUNDING.md: verified (code or simulator), read (a source fetched this session), belief (unverified). Sketch files live under `sketch/` next to this file; paths below are relative to it.

## Problem

Two consumers want answers from the on-device index without the Puffer UI being open: remote agents through MCP, and Siri, Shortcuts and Spotlight through App Intents. Today search exists only in JavaScript (`src/puffer.ts`, `src/library.ts`), vectors live in a JS `Float32Array`, and the agent preview (`src/ui/preview.tsx`) is an in-memory reducer that resets on relaunch. App Intents run in the app process even when JS has never started, and the phone cannot be a server, so a relay on a machine the user owns must front the agents. Constraints the design honours: `src/store.tsx`'s `Store` and `useSearch` contract stays the data contract for screens; the existing `puffer.db` schema and data survive; only snippets, captions and explicitly approved images leave the phone, never vectors (Vec2Text, read); Expo SDK 55 prebuild regenerates `ios/`, so app-target Swift must come from a config plugin; inline modules and `expo-app-intents` are SDK 56 and later (read: Expo docs), so they are the migration path, not the build; push notifications need a paid team the project does not have (read); a suspended iOS app keeps no sockets (read).

## Usage (caller's view)

**The agent user, on this Mac.** Start the relay: `npm run relay` in `relay/` prints `Pairing code: 481 920` and listens on `127.0.0.1:8787`. In the simulator, Settings → Agent bridge → enter `http://localhost:8787` and the code. Agents tab → Add agent → "Claude Code" → the phone shows, once, `claude mcp add --transport http puffer http://localhost:8787/mcp --header "Authorization: Bearer pf_8f3…"`. Paste it. In Claude Code: "what is the deposit in my lease?" → the model calls `search({question})` → the phone shows the review modal with three toggled passages → tap Approve → the tool returns two snippets as text and `structuredContent.disclosures`. Open "Contracts" to Claude Code in Collections access → the next lease question returns in about a second with `auto: true` and no modal. Lock the phone and ask again → after `maxWaitMs` the tool returns `{status:'pending', requestId, phone:'offline', hint:'Open Puffer on the iPhone to answer; call result(requestId) afterwards'}`; opening the app shows the queued request.

**The Shortcuts user.** Shortcuts app → Puffer → "Search Puffer" → type "boarding pass" → a list of Puffer Items with thumbnails, chainable into Quick Look or Share. With Siri on a device: "Search Puffer for the lease deposit" (phrases in `ios-intents/PufferShortcuts.swift`). Spotlight: type "lease" → a Puffer result with the excerpt → tap → the app opens on the item.

**Call sites in our own code.**

```tsx
// src/app/request/[id].tsx
const bridge = useBridge();
const proposal = use(bridge.proposal(id));           // same object the engine used to decide `auto`
const chosen = proposal.candidates.filter((c) => picked[c.item.id] ?? c.offered);
<Toggle isOn={…}><ItemLabel item={c.item} /><Text>{c.preview.kind === 'snippet' ? c.preview.excerpt : 'Photo'}</Text></Toggle>
onApprove={() => bridge.approve(id, chosen.map((c) => c.item.id))}
```

```ts
// relay/src/mcp.ts, inside the search tool
const req = ledger.create(agent.agentId, question, options.dedupeMs);
phone.deliver(req);
const decided = await phone.awaitDecision(req.id, AbortSignal.timeout(options.maxWaitMs));
return toToolResult(decided ? fromOutcome(decided) : { status: 'pending', requestId: req.id, phone: phone.presence().kind, hint });
```

```swift
// ios-intents/PufferIntents.swift
let result = try await PufferEngine.shared.search(.text(query), SearchOptions(mode: .hybrid, dim: .d256, rerank: true))
return .result(value: result.hits.map { PufferItemEntity($0.item, excerpt: $0.item.text?.prefix(200)) },
               dialog: "Found \(result.hits.count) items.")
```

## Shape

**Data first.** Four branded ids (`ItemId`, `AgentId`, `CollectionId`, `RequestId`). `Disclosure` is a two-case union, snippet or image, and is the only type that crosses the network from the phone; it has no field that could carry a vector, full text or path (`shared/bridge-protocol.ts`, `Domain.swift`). `Outcome` is `released | denied | nothing | expired`. `Proposal` is a request plus `Candidate[]`, each with `covered: CollectionId[]` (granted collections containing the item), `offered` (the review default) and `preview: Disclosure` (exactly what would leave). A `BridgeRequest` is `pending` or `decided(Outcome)`. On the relay, `RelayRequest.state` is `queued | delivered | decided | cancelled`.

**Decision 1: search, embeddings and all durable state move to native Swift; JS keeps UI, routing and the socket.** `PufferEngine.shared` (an actor, `Engine.swift`) owns the SQLite file expo-sqlite already created at `Documents/SQLite/puffer.db` (path read from expo-sqlite source), with the `items` table unchanged and new tables for collections, agents, grants, requests and the disclosure log (`Store.swift`). `Index.swift` is a line-for-line port of `src/puffer.ts`. `Embedder.swift` is the existing `EmbedRuntime` plus the prompt formats from `src/model.ts`. Why: App Intents need search in a process where JS may be cold, and the 30 s intent budget (read) fits a 1.2 s model load (verified) but not booting React Native and the JS library on top. The second reason is the privacy invariant: with vectors confined to `Index.swift` and `Embedder.swift`, the JS bridge cannot leak them even by accident, and `src/puffer.ts`, `src/library.ts` and the JS embed functions are deleted (subtract-before-you-add). `src/store.tsx` keeps its `Store` contract and `useSearch` shape; `search` becomes one native call. Per model-the-domain and separate-before-serializing-shared-state: one writer (ingest via the module), many readers (intents, bridge, UI), serialized by the actor.

**Decision 2: consent is decided by one pure module on the phone, `Consent.swift`.** `propose` takes the hits for the question, the membership sets of the agent's granted collections (each computed with the same `search` the Collections screen uses, minus hidden ids), and returns a `Proposal`. `auto` is true only when at least one candidate is offered and every offered candidate is covered; partial coverage goes to review. Photos are never offered and never auto-released; an image disclosure exists only after a review toggle. `release` rejects ids outside the proposal instead of dropping them, so a buggy caller cannot widen a release. The relay never learns grants; it authenticates and queues. The preview the user sees is the object that leaves (what-you-see-is-what-leaves), and the disclosure log records every released item with agent and time (App Store 5.1.2(i), read).

**Decision 3: the relay is an MCP Streamable HTTP server on the Mac; the phone connects outbound over one WebSocket.** `relay/src/main.ts` binds `127.0.0.1` with the SDK's localhost Origin and Host validators (read: TS SDK serving docs) and serves `/pair`, `/link` and `/mcp`. `Ledger` is the durable request ledger; `PhoneLink` derives presence from heartbeats, replays `pending` on every reconnect, and resolves waiters on `decided`. Three read-only tools over one request model: `search(question)` blocks while the phone decides and sends progress every 15 s because Claude Code idles HTTP tool calls out after 5 min without progress, backgrounds calls after 2 min, and treats the per-server `timeout` as a hard cap (read: Claude Code MCP docs); when `maxWaitMs` passes it returns `pending` with the id, and `result(requestId)` retrieves it later; `status()` reports presence. `create` dedupes an identical undecided question from the same agent so a retry re-attaches instead of asking the user twice (idempotent). MCP tasks (2025-11-25, read) map one to one onto `RelayRequest.state` and replace the `pending`/`result` fallback once the server SDK exposes them; the SDK's tasks support was not verified this round (belief that it is not yet public).

**Decision 4: the phone mints agent identities; the relay stores hashes.** `createAgent` returns a 32-byte secret once and stores `sha256(secret)`; the phone pushes the roster (`agents` message) on every connect; the relay authenticates `Authorization: Bearer` by constant-time hash compare and scopes every tool to that agent (a foreign request id is "not found"). Phone-to-relay pairing is a one-time code from the relay's stdout exchanged for a device token kept in the Keychain (`expo-secure-store`, new dependency). OAuth 2.1 with RFC 9728 metadata (read: MCP authorization spec) lives behind `authenticate()` in `main.ts` when Claude.ai or ChatGPT connectors need it; nothing else changes.

**Decision 5: App Intents live in the app target, added by a config plugin; Spotlight is plain `CSSearchableItem` from the pod.** `plugins/with-puffer-intents.js` copies `ios-intents/*.swift` into `ios/<project>/Intents/` in `withDangerousMod` (dangerous mods run first, read) and links them with `IOSConfig.XcodeUtils.addBuildSourceFileToGroup` in `withXcodeProject` (helper verified exported from `@expo/config-plugins` source). Metadata is then extracted from the app target, which sidesteps the static-framework question from the grounding; the pod is `PufferCore` with `DEFINES_MODULE` so intents `import PufferCore`. `PufferItemEntity`, `CollectionEntity`, `SearchPufferIntent` (`supportedModes: .background`, `ReturnsValue<[PufferItemEntity]> & ProvidesDialog`), `OpenPufferItemIntent: OpenIntent` and `PufferShortcuts` are thin wrappers over engine calls. Spotlight indexing uses `CSSearchableIndex.indexSearchableItems` from `Spotlight.swift` so the pod never references app-target entity types; a tap arrives as `CSSearchableItemActionType` in `SpotlightContinuation`, an `ExpoAppDelegateSubscriber`, because the subscriber manager forwards `application(_:continue:restorationHandler:)` (read: `ExpoAppDelegateSubscriberManager.swift`, SDK 55). Both Spotlight and `OpenPufferItemIntent` go through one path, `PufferEngine.openItem`, which emits `onOpenItem` when JS is attached and parks the id for `takePendingOpen()` on a cold launch (at-least-once, like expo-app-intents' invocation queue, read).

**Locked or suspended, honestly.** Foreground: live, pre-approved answers in about a second, review requests as a modal. Backgrounded: `channel.ts` holds a background task for roughly 30 s to flush an in-flight decision, then iOS suspends the app and the socket dies. Suspended or locked: the relay marks the phone offline after two missed heartbeats, queues the request, and tells the agent so; nothing wakes the app, because there is no push entitlement on a free team (read) and `expo-background-task` is not a wake path (12 h default interval, unavailable on the simulator, read). `Wake` in `phone.ts` is the seam; `noWake` is the only implementation. With a paid team, `apns` sends a user-visible push for review requests and a silent push (about 30 s, read) for pre-approved ones, enough for model load plus search. Siri and Shortcuts while locked: the intent runs in the background-launched process; the DB uses the default protection class so it is readable after first unlock; results should be gated by App Intents' authentication policy (belief: `authenticationPolicy`; confirm the API in Phase D).

**Interface depth.** JS sees one native module with about twenty functions, and behind them sit SQLite, the matrix index, BM25, the embedding engine, Spotlight sync, membership evaluation and the consent rules. Agents see three tools. Intents see one actor. Exposed on purpose: `SearchOptions` (the Settings screen tunes them) and `Proposal` (the review screen renders it). Not exposed: vectors, prompt formats, excerpt windows, token secrets after display, relay session ids.

**Build with prebuild.** `app.json` gains `"plugins": [..., "./plugins/with-puffer-intents"]`; `modules/gemma-embed` is renamed `modules/puffer-core` with the podspec in `sketch/modules/puffer-core/ios/PufferCore.podspec` (adds `CoreSpotlight`, `Accelerate`, `sqlite3`, platform 18.0). No entitlements, no App Group, no extension target this round. `relay/` is a separate Node package in the repo; `shared/bridge-protocol.ts` is imported by both `relay/` and `src/`, so the wire types have one definition.

**Demonstrable here.** `relay/scripts/smoke.ts` runs the relay, a fake phone over the real protocol, and an MCP client, asserting 401 without a token, `pending` while offline, snippets after a `decided`, re-attachment on retry, and that no tool result JSON contains `vec`, `vector`, `embedding` or `sourceUri`. The same client against the simulator app is the demo. Shortcuts run on the simulator at iOS 26.3 (read: Apple forums report 26.4 and later broken); Siri voice needs a device (read).

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept porting about 260 lines of ranking code to Swift and a parity test against recorded JS rankings, in exchange for intents that work with JS cold and a vector boundary that is structural rather than disciplinary.
- We accept a larger native module surface (collections, agents, requests in Swift) in exchange for one owner of all durable state and a consent decision that runs next to the index.
- We accept that `search` can return `pending` and that a second tool exists to collect it, in exchange for working with today's Claude Code timeouts; MCP tasks replace this when the SDK supports them.
- We accept no wake-up while suspended, stated to the agent, in exchange for not depending on a paid Apple team or a cloud mirror of personal data.
- We accept that Spotlight results are plain searchable items rather than `IndexedEntity`, in exchange for keeping the pod free of app-target types; Apple Intelligence entity association can be added from the app target later.
- We accept a config plugin that copies and links Swift on SDK 55, in exchange for not upgrading to SDK 56 mid-round; the files are laid out so `expo-app-intents` adopts them unchanged.

## Alternatives considered

- **Keep search in JS and boot React Native headlessly for intents.** Smaller change. Rejected: it exposes the RN boot, the JS library load and the model load to a 30 s budget in one process, and leaves vectors in JS where the bridge code can reach them. Shallower interface too: intents would need a JS dispatch queue and a result round trip.
- **An App Intents extension via `@bacons/expo-apple-targets` with an App Group.** Clean process isolation and no app launch. Rejected for this round: it duplicates the model and index in a second process (388 MB model, memory limits for extensions), needs App Group entitlements, and the engine would have to be a shared package, which is what `PufferCore` already is. It stays the fallback if app-target metadata extraction misbehaves under prebuild.
- **Phone as the MCP server behind a tunnel.** No relay code. Rejected: the phone has no stable listener while suspended, and tunnels expose a port on a device that cannot authenticate the way a server should; every agent request would still need a queue somewhere.
- **A text-only mirror of pre-approved collections on the relay so agents get answers while the phone is away.** Tempting for availability. Rejected this round: it moves personal data off the device permanently and bypasses per-request consent for everything in the mirror. Listed as an open question.
- **Collections and grants in expo-sqlite on the JS side, native owning only the index.** Two owners of disjoint state is legitimate. Rejected because the consent decision needs N membership searches per request and belongs next to the index, and because intents may want collections as a parameter.

## Implementation reconciliation

Empty until Phase D.

## Open questions and risks

- Does `addBuildSourceFileToGroup` link into the application target and does `appintentsmetadataprocessor` then find `PufferShortcuts` on a prebuild-generated project? First `npx expo run:ios` after the plugin answers this; the fallback is the extension route above.
- A cold intent launch runs AppDelegate, so React Native starts alongside the engine. Is memory headroom with a 388 MB model acceptable on a real device inside 30 s? Measure on the simulator first; if not, the extension route or `LongRunningIntent` (read) is the lever.
- Should a review request on a suspended phone be visible anywhere but the Agents tab? Without push the answer is no this round; with a paid team, which push text is acceptable (the question itself, or only the agent name)?
- Do we want a cloud mirror of pre-approved collections for availability, knowing what it gives up?
- Which MCP clients beyond Claude Code tolerate a tool call that waits minutes with progress? Claude.ai and ChatGPT connector timeouts were not read this round.
- Is `authenticationPolicy` the right App Intents API for hiding results on a locked device, and should `SearchPufferIntent` require it even for Shortcuts automations?
- Membership for `covered` reruns each granted collection's query per request. Six collections and brute-force scans are milliseconds today; at what library size does this need the cached collection hit sets the engine can keep per index revision?

## Next implementation step

Port `src/puffer.ts` to `Index.swift` with a parity test that replays a recorded fixture library and the current JS rankings, since every other module depends on the engine returning the same hits the UI shows today.
