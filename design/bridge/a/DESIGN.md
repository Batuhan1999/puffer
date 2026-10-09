# Bridge design, candidate a: native data plane, phone-held policy, mailbox relay

Status: candidate design for architect Phase B. Sketches live in `sketch/`. Facts carry a label: verified (seen in this repo), read (from a source fetched this session or cited in GROUNDING.md), or belief (unconfirmed).

## Problem

Puffer must answer two new kinds of callers. Personal agents ask questions through a relay, and the phone answers from its on-device index after per-request approval or under a standing grant. Siri, Shortcuts and Spotlight search the same index. Today every search runs in JavaScript (`src/puffer.ts`, `src/library.ts`, verified), and the JS runtime only exists while the app runs. The new entry points are relay requests in the foreground, relay requests during background wakes, Siri and Shortcuts intents, and Spotlight. Only the first can count on JS. A Siri or Shortcuts intent runs `perform()` in Swift, possibly with the app closed. A background wake has about 30 seconds and no UI. Spotlight indexing and continuation are native. Expo's own `expo-app-intents` (SDK 58 docs, read) hit the same wall. Its intents run in Swift and dispatch to JS one way, "because the intent may run while your app is closed".

Constraints the design honors:

- Expo SDK 55 with Continuous Native Generation. `ios/` is never edited. App-target Swift and Info.plist keys come from `app.json` or a config plugin (verified). Inline modules and `expo-app-intents` need SDK 56 and SDK 58 (read), so neither is available here.
- The 388 MB model is loaded once per process by `EmbedRuntime` in `modules/gemma-embed` (verified). A second loader doubles memory.
- A free Apple ID has no push (read). Nothing wakes a suspended app on demand.
- Vectors are invertible (read). Only titles, text snippets and per-request-approved images may leave the phone.
- A collection is a saved description, and its members are whatever ranks for its query (verified, `preview.tsx`). Today membership is computed with the user's UI search prefs (verified, `library/collection/[id].tsx` passes `preview.prefs`). If consent used that, flipping the search mode to keyword would change what an agent may read.
- The review screen re-runs search when it opens (verified, `request/[id].tsx`). An auto-decision and a later review could therefore disagree about the candidates.

## Usage (caller's view)

### The person running the demo on this Mac

```sh
# 1. Relay on localhost. First run mints a device key and prints a pairing link.
cd prototype/relay && npm install && npx tsx src/server.ts --port 8787
#   Puffer relay on http://localhost:8787 (MCP at /mcp)
#   Pair the phone: puffer://pair?relay=http%3A%2F%2Flocalhost%3A8787&key=dk_3Fq...

# 2. App on the simulator (prebuild applies the puffer-native config plugin).
npx expo prebuild --clean && npx expo run:ios
xcrun simctl openurl booted 'puffer://pair?relay=http%3A%2F%2Flocalhost%3A8787&key=dk_3Fq...'

# 3. In Puffer: Agents > Connect Agent > "Claude Code". Puffer shows the key once
#    and copies this line (the simulator clipboard reaches the Mac):
claude mcp add --transport http puffer http://localhost:8787/mcp \
  --header "Authorization: Bearer ak_9xT..."

# 4. In Claude Code: "Ask Puffer what the deposit is in my lease."
#    The simulator shows "Claude Code asks". Approve. The tool call returns the snippet.
```

The `claude mcp add --transport http ... --header` form and the `.mcp.json` `headers` field are documented (read, Claude Code MCP docs). Claude Code moves an MCP call that runs past two minutes into a background task and its default per-server tool timeout is about 28 hours (read), so a long wait for approval does not break it.

### The agent's view (MCP, two tools)

```jsonc
// tools/list
{ "name": "ask_puffer",
  "description": "Ask the user's phone-local library (documents, notes, photos). The phone answers from collections the user pre-approved for you, otherwise the user approves on their phone. May return status waiting_for_user or phone_offline with a request_id; call get_puffer_answer later.",
  "inputSchema": { "type": "object", "required": ["question"],
    "properties": { "question": { "type": "string", "maxLength": 500 } } } }
{ "name": "get_puffer_answer",
  "inputSchema": { "type": "object", "required": ["request_id"],
    "properties": { "request_id": { "type": "string" } } } }

// tools/call ask_puffer {"question":"What is the deposit in my lease?"}  -> blocks up to the relay's wait budget
{ "content": [{ "type": "text", "text": "Shared by the user from Puffer:\n1. Lease agreement, page 3 (document)\n   \"... a security deposit of three months' rent, payable ...\"" }],
  "structuredContent": { "status": "answered", "items": [{ "title": "Lease agreement, page 3", "kind": "passage", "text": "..." }] } }

// When the phone is suspended:
{ "content": [{ "type": "text", "text": "The phone is offline (last seen 14:02). Request rq_01J... is queued and will be answered the next time Puffer runs. Call get_puffer_answer with this id later." }],
  "structuredContent": { "status": "phone_offline", "request_id": "rq_01J...", "last_seen_at": "2026-10-07T14:02:11Z" } }
```

Statuses are `answered`, `nothing_found`, `declined`, `expired`, `waiting_for_user`, `processing` (the phone has it and has not triaged yet) and `phone_offline`. Approved photos arrive as MCP `image` content beside the text. An agent with 10 open requests is refused, so one agent cannot flood the phone with review prompts.

### JS call sites in the app

```tsx
// src/app/request/[id].tsx: the review shows the candidates frozen at triage. No fresh search.
const { request, agent, decide } = useAgentRequest(id);
if (request.phase.kind !== 'awaitingUser') return <Resolved request={request} />;
const chosen = request.phase.candidates.filter((c) => picked[c.itemId] ?? c.offered);
<Button onPress={() => decide({ kind: 'share', itemIds: chosen.map((c) => c.itemId) })}>Approve and Share</Button>
<Button onPress={() => decide({ kind: 'deny' })}>Deny</Button>

// src/app/(tabs)/agents/index.tsx: connect an agent. The key is shown once and never stored in plain text.
// Clipboard is expo-clipboard, a new dependency (npx expo install expo-clipboard).
const { setupCommand } = await bridge.connectAgent('Claude Code');
await Clipboard.setStringAsync(setupCommand);

// src/app/(tabs)/library/collection/[id].tsx: the same membership the consent check uses.
const { members, edit } = useCollection(id);
edit({ type: 'collection/hide', id, itemId });

// src/app/(tabs)/search/index.tsx: unchanged call shape, now served by native.
const { result } = useSearch({ kind: 'text', text }, prefs);
```

### Swift call sites in the app target (App Intents)

```swift
import AppIntents
import PufferNative

struct SearchPufferIntent: AppIntent {
  static let title: LocalizedStringResource = "Search Puffer"
  @Parameter(title: "Query", requestValueDialog: "What should Puffer look for?") var query: String

  func perform() async throws -> some IntentResult & ReturnsValue<[ItemEntity]> & ProvidesDialog {
    let cards = try await Puffer.search(query, limit: 5)
    return .result(value: cards.map(ItemEntity.init), dialog: Dialog(cards.spokenSummary))
  }
}

struct CheckAgentRequestsIntent: AppIntent {   // run by a Shortcuts automation while Puffer is suspended
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let report = await Puffer.syncAgentRequests(.intent)
    return .result(dialog: "\(report.answered) answered, \(report.waitingForUser) waiting for you.")
  }
}
```

## Shape

### Load-bearing decisions

1. **One native data plane.** The item store, vector and BM25 index, embedding, ranking, policy, request ledger and relay sync all live in one Swift pod, `PufferNative` (the renamed `modules/gemma-embed`). Two actors own the state. `Engine` owns items and search. `Bridge` owns agents, grants, collections, the ledger and the relay link. JavaScript becomes a UI over them. `src/puffer.ts` and `src/library.ts` are deleted after a parity check. This is what the design would be if Siri and the relay had been day-one callers, per redesign-from-first-principles. There is one ranker, so the list the user reviews, the list Siri reads and the list an agent receives come from the same code.
2. **The phone is the only policy authority. The relay is an authenticated mailbox.** The relay authenticates agents and parks requests. It never decides what is shared and never holds anything but questions, approved answers and token digests.
3. **One phone-initiated, idempotent `sync` call is the whole transport.** `POST /v1/device/sync` carries the phone's outbox and registry. It returns new requests and acks. It long-polls up to 25 s. The foreground loop, the background grace period, a background refresh and an App Intent all run the same call with a different deadline.
4. **Agent keys are minted on the phone.** The relay stores only SHA-256 digests, pushed by the phone as a full registry snapshot. Revoking an agent on the phone revokes it at the relay on the next sync.
5. **Consent is one pure function over a canonical search.** `Triage.decide(hits, granted)` auto-shares only when every candidate offered by default (text passages in the top 3) belongs to a collection granted to that agent. Photos never leave without a per-request approval. Membership uses `SearchOptions.canonical` (hybrid, 768d, rerank), never the UI prefs.
6. **Candidates are frozen at triage.** The ledger stores the candidate list. The review screen renders it. What the user approves is what triage saw, and an approval can only pick from that list.
7. **The app target stays declarative.** App Intents, entities and the App Shortcuts provider are Swift files in the app target, added by the module's config plugin as file references to sources that stay in `modules/puffer-native/app-target/`. Every imperative hook (background refresh, background grace, Spotlight, local notifications, open routes) lives in the pod through an `ExpoAppDelegateSubscriber` (read, Expo docs: `apple.appDelegateSubscribers`). No string patching of `AppDelegate.swift`.

### Module map

```
prototype/
  modules/puffer-native/                 renamed from modules/gemma-embed; pod PufferNative, JS module "Puffer"
    expo-module.config.json              modules: PufferModule; appDelegateSubscribers: PufferAppDelegate
    app.plugin.js                        Info.plist keys + app-target file references (sketch/plugin/)
    ios/Puffer.swift                     public facade for the app target (7 calls, no vector-bearing type)
    ios/Engine.swift                     actor Engine: ItemStore, VectorIndex, Bm25, Embedder, Ranking, SpotlightIndex
    ios/Triage.swift                     pure consent rule
    ios/Bridge.swift                     actor Bridge: policy, ledger state machine, sync loop, presence
    ios/Relay.swift                      wire Codable types, RelayClient, PairingLink, RelayKeychain
    ios/PufferModule.swift               JS boundary (Records in, dictionaries out) + the folder functions
    ios/SystemHooks.swift                ExpoAppDelegateSubscriber: BG refresh, grace, Spotlight tap, notifications
    ios/vendor/                          unchanged LiteRT-LM xcframework and Swift sources
    app-target/PufferIntents.swift       AppEntity, AppIntent, AppShortcutsProvider (compiled into the app target)
    src/index.ts                         engine + bridge namespaces, parsing, onChange
  src/store.tsx                          same Store contract, backed by native
  src/bridge.tsx                         BridgeProvider, useBridge, useAgentRequest, useCollection
  src/ui/preview.tsx                     shrinks to prefs, recents, timings
  src/app/pair.tsx                       handles puffer://pair, calls bridge.pair
  relay/                                 separate package.json, Node, not bundled by Metro
    src/protocol.ts  src/registry.ts  src/mailbox.ts  src/mcp.ts  src/server.ts  scripts/e2e.ts
```

Deleted: `src/puffer.ts`, `src/library.ts`, the embedding half of `src/model.ts`, `GemmaEmbedModule.swift` (its pieces move), `GemmaEmbedModule.ts`, and the simulated request script in `preview.tsx`. Tracing any flow needs at most three files. One is the caller, one is `Puffer.swift` or `src/index.ts`, and one is the owning actor.

### Data structures first

Swift (pod, `sketch/swift/PufferNative/`):

- `ItemID`, `AgentID`, `CollectionID`, `RequestID` are distinct `RawRepresentable` structs, per type-system-discipline.
- `ItemCard` is the only public item shape: id, kind, title, snippet, addedAt, thumbnail URL. It has no vector field. `VectorIndex` and `Bm25` are `internal`, so the app target cannot import them. That makes "vectors never leave" a compile-time property of the module boundary rather than a comment.
- `SearchQuery` is `.text(String)` or `.like(ItemID)`. `SearchOptions` carries mode, dim and rerank. `.canonical` is the policy setting.
- `Collection { id, name, query, symbol, hidden }` and `Agent { id, name, keyDigest, grants: Set<CollectionID>, connectedAt }`.
- `LedgerEntry { id, agentID, question, receivedAt, phase, reported }` where `phase` is a state machine, per model-the-domain:

```
received ──triage: no hits──────────────▶ nothingFound
    ├──triage: offered ⊆ granted─────────▶ shared(items, by: .grant)
    └──triage: otherwise──▶ awaitingUser(candidates)
                               ├──user approves────▶ shared(items, by: .user)
                               ├──user denies──────▶ denied(.user)
                               ├──expiresAt passes─▶ denied(.expired)
                               └──agent revoked────▶ denied(.agentRevoked)
```

  A `received` entry whose triage cannot run (model not loadable) stays `received` and is retried by the next `Bridge.start()` or sync.

  `reported` names the last phase the relay acknowledged. The outbox is derived as entries whose phase differs from `reported`. There is no outbox table to keep in step with the ledger.
- `SharedItem { title, kind, text?, image? }` is built only from `ItemCard` fields plus a JPEG made at approval time. It is the only type that crosses into the wire encoder.

TypeScript (relay, `sketch/ts/relay/`):

- `RelayRequest { id, agentId, question, askedAt, expiresAt, state }` with `state` one of `queued`, `withPhone{since}`, `awaitingUser{since}`, `settled{outcome}`. `Outcome` is `answered{items}`, `nothing_found`, `declined` or `expired`. The tool status the agent sees is derived from `state` plus device presence by one function, `toolStatus()`.
- `Registry { deviceKeyDigest, revision, agents: {id, name, keyDigest}[] }` persisted to `relay/.state/registry.json`. Requests stay in memory. A relay restart loses parked requests, and `get_puffer_answer` then reports `expired`.

Storage and ownership, one writer each, per separate-before-serializing-shared-state:

| State | Owner | Where |
| --- | --- | --- |
| items, vectors, `meta(revision, spotlightRevision)` | `Engine` | existing `puffer.db` (expo-sqlite location, belief: `Documents/SQLite/`) |
| collections, agents, grants, ledger | `Bridge` | new `Application Support/bridge.db` |
| relay URL and device key | `Bridge` | Keychain, `kSecAttrAccessibleAfterFirstUnlock` so locked-phone wakes can sync |
| agent key digests, parked requests | relay `Mailbox` | `registry.json`, memory |
| search prefs, recents, timings | JS | React state, as today |

Two actors never write the same file. `Bridge` reads items only through `Engine`'s API.

### How data flows

- **UI search.** `useSearch` calls the module, which calls `Engine.search(query, prefs)` and gets `ItemCard`s and timings back. Vectors stay in Swift. Ingest still orchestrates in JS (media library, folders, image manipulation), but it hands `Engine.addPassages` texts and `Engine.addImage` a JPEG path. Embedding prompts move into `Engine`, so the query prompt and the passage prompt live in one file.
- **Agent ask.** MCP `ask_puffer` calls `Mailbox.ask`, which parks the request. The phone's parked `sync` returns it. `Bridge.receive` persists `received`, then runs `Engine.search(question, .canonical)` and `members()` for the agent's grants, then `triage()`. A `shared` result is in the outbox, so the loop calls `sync` again immediately. The relay settles the request and wakes the waiting tool call. An `awaitingUser` result also syncs (the agent sees `waiting_for_user`) and raises an in-app banner, or a local notification when the app is not active.
- **User decision.** `Bridge.decide` checks that the chosen ids are a subset of the frozen candidates, builds `SharedItem`s, moves the phase, and kicks a sync.
- **Siri and Shortcuts.** The intent calls `Puffer.search`. `Engine.start()` is idempotent and shares one in-flight load, so an intent that launches the app in the background and the JS `PufferProvider` booting at the same time load the store and model once, per make-operations-idempotent.
- **Spotlight.** After every committed add, `Engine` upserts `CSSearchableItem`s keyed by item id. `clear()` deletes the domain. `start()` reconciles when `meta.spotlightRevision` lags. A tap continues into the pod's subscriber, which opens `puffer://library/item/<id>`.
- **Collections.** `Bridge.members(collectionID)` is `Engine.search(.text(collection.query), .canonical)` minus `hidden`. The collection screen and `triage()` call the same function.

### Wire protocol (phone to relay)

```
POST /v1/device/sync         Authorization: Bearer dk_...
{ "v": 1, "waitMs": 25000,
  "outbox":   [ { "id": "rq_..", "kind": "answered", "items": [SharedItem] }
              | { "id": "rq_..", "kind": "nothingFound" } | { "id": "rq_..", "kind": "declined" }
              | { "id": "rq_..", "kind": "expired" }      | { "id": "rq_..", "kind": "awaitingUser" } ],
  "registry": { "revision": 7, "agents": [ { "id": "ag_..", "name": "Claude Code", "keyDigest": "sha256:.." } ] } }   // only when changed
-> { "v": 1, "requests": [ { "id": "rq_..", "agentId": "ag_..", "question": "..", "askedAt": "..", "expiresAt": ".." } ],
     "acked": [ { "id": "rq_..", "kind": "answered" } ], "registryRevision": 7 }
```

The relay re-sends a request on every sync until it sees any outbox entry for that id. The phone inserts by primary key and ignores duplicates. Answers are re-sent until acked, and the relay ignores a second terminal outcome for a settled id. Every message can be lost or repeated without changing the end state. The relay answers at once when the body carries outbox entries, so acks are never held behind a long poll.

### Phone states, stated honestly

| Phone state | What an agent gets | Mechanism |
| --- | --- | --- |
| Puffer in foreground | Grant-covered answer in about a second. Otherwise `waiting_for_user` and an in-app banner. | Long-poll loop in `Bridge`. |
| Just backgrounded | Same, for the grace period iOS allows (belief: about 30 s). A local notification asks for review. | `beginBackgroundTask` from the subscriber's `applicationDidEnterBackground`. |
| Suspended, locked or killed | `phone_offline` after a 2 s grace. The request stays queued at the relay until it expires (default 24 h). | Nothing runs. No push on a free Apple ID (read). |
| Next wake | Queued requests are triaged. Grant-covered ones are answered. Others raise a local notification. | Opening the app. A `BGAppRefreshTask` (opportunistic, belief: allowed for a free team). A user-made Shortcuts automation (for example "when charging" or a time of day) running `CheckAgentRequestsIntent`. Search intents do not sync, so Siri latency and side effects stay predictable. |
| Force-quit | As suspended. Background refresh does not relaunch a force-quit app (belief). An automation-run intent does launch it (belief). | |
| Later, paid account | A silent push becomes one more `WakeSource`. Nothing else changes. | |

An agent should treat Puffer as a mailbox, not an RPC. The tool text says so.

### Where validation lives

Per boundary-discipline, parsing happens at four edges, and code inside trusts the types:

- Relay HTTP: `parseSyncBody` and MCP tool arguments go through zod schemas in `relay/src/protocol.ts`.
- Phone network: `RelayClient` decodes `SyncResponse` with `Codable` and drops envelopes for unknown agents.
- JS to native: the Expo module's argument records (`Record` types) are the boundary. `PolicyEdit` arrives as one discriminated union.
- Deep links: `PairingLink.parse(url)` and `Route.parse(url)`.

### Interface depth

- JS sees one module with two namespaces. `engine` has `status`, `start`, `search`, `items`, `addPassages`, `addImage`, `clear`, `modelPath`. `bridge` has `snapshot`, `edit`, `members`, `connectAgent`, `pair`, `unpair`, `decide`. One `onChange` event carries a topic and revision. Behind that sit SQLite, BLAS scans, BM25, MRL views, the model, policy, the ledger state machine, the relay loop, background tasks, Spotlight and notifications.
- The app target sees `Puffer.search`, `Puffer.cards`, `Puffer.recent`, `Puffer.collections`, `Puffer.members`, `Puffer.syncAgentRequests` and `Puffer.open`. That is seven calls, and no type that can reach a vector.
- The agent sees two tools. The phone sees one endpoint.
- Every policy write goes through `bridge.edit(PolicyEdit)`, the same action union the preview reducer uses today. The UI keeps its dispatch shape and loses the reducer.

### What the system deliberately does not do

- It does not search in JS, and it has no second ranker.
- It sends no vectors, embeddings, ids or source paths. Item ids include photo asset ids (verified, `photo:<assetId>`), so they stay home.
- It does no relay-side search or policy, no OAuth this round, no MCP tasks, no push, no multi-device and no end-to-end encryption between phone and agent. The relay terminates MCP, so it sees questions and answers by construction.
- It does not listen beyond this Mac. The relay binds `127.0.0.1` by default. Public exposure means HTTPS in front of it, and it needs the user's go-ahead. For Claude.ai and ChatGPT connectors it also needs OAuth. The planned shape is the relay as authorization server, with the consent step shown on the phone as "<Agent> wants to connect". `registry.authenticateAgent` is the single seam it replaces.
- It does not auto-share photos, even inside a granted collection.

### Red-flag screen

- **Shallow module.** Each `Puffer` call hides a lazy start, canonical options and actor hops. Each JS namespace hides an actor. No caller coordinates several calls for one operation. `Bridge.sync` is the single operation behind four wake paths.
- **Information leakage.** Wire types stay in `Relay.swift` and `protocol.ts`. Ledger, JS and intents never see them. The one leak is that the protocol is written twice, which is accepted above and caught by the e2e script.
- **Temporal decomposition.** `Engine` and `Bridge` are split by knowledge (items versus consent), not by stage. Triage is the consent rule as a pure function, not a pipeline step with its own copy of the state.
- **Pass-through.** `Puffer.search` adds the canonical options and the lazy start. `PufferModule` parses Records. The `bridge.edit` JS wrapper is a pass-through kept only so screens never import the raw module.
- **Split ownership.** Today the preview reducer and the review screen's fresh search each hold a version of "what this request would share". After the move, one ledger entry holds it.
- **Two ways.** There is one ranker, one membership function, one open-route path (`Puffer.open`) and one sync call.
- **Importable internals.** `VectorIndex`, `Bm25`, `ItemStore` and the wire types are Swift `internal`, so the app target cannot reach them. In JS only `modules/puffer-native/src/index.ts` calls `requireOptionalNativeModule`. An `eslint` `no-restricted-imports` rule can keep it that way.
- **Hand-synced lists.** The refresh task id has one copy, in the plugin, and Swift reads it back from Info.plist. Starter collections move to the native seed and leave `preview.tsx`. `PolicyEdit` exists in TS and Swift. A case added only in TS fails at the module's parse with an "unknown edit" error, and the Swift `switch` is exhaustive.

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept porting about 260 lines of ranking from TS to Swift in exchange for one ranker that every caller shares. The port is gated by a parity script, not by eye.
- We accept that the UI depends on a native module for every list in exchange for a JS layer that holds no data-plane state. An Expo Go or web build cannot search, which is already true (verified, `gemma()` throws off iOS).
- We accept a relay that sees questions and approved answers in exchange for zero inbound connectivity to the phone. The relay is the user's own process.
- We accept that grant semantics follow the collection's description, so a new document matching "Receipts" becomes readable by an agent granted Receipts, in exchange for grants that need no upkeep. Membership is capped by the existing top-50 candidate window, which fails closed. A receipt ranked 60th needs approval.
- We accept long-poll over WebSocket in exchange for one stateless, idempotent call used identically in every wake context.
- We accept the wire types written twice (zod in the relay, `Codable` in Swift) in exchange for not running JS in the background. The protocol is one versioned endpoint with four envelope kinds, and the end-to-end script fails on drift.
- We accept classic `CSSearchableItem` Spotlight over `IndexedEntity` this round in exchange for keeping the app target free of launch hooks. Spotlight results find items. Intent results are `AppEntity` values other apps can use.
- We accept `phone_offline` as a normal answer in exchange for honesty. No design without push makes a suspended phone answer on demand.

## Alternatives considered

- **JS stays the data plane, and native wakes JS and waits.** The intent or background handler would boot React Native, mount `PufferProvider`, load the index in JS and await a JS callback. This exposes callers to two runtimes and a handshake with no timeout story, and it boots a UI runtime to answer a headless call. Expo's own SDK 58 intents library rejected waiting on JS for the same reason (read). It lost on depth because every caller would have to know whether JS is alive.
- **Both runtimes search.** Keep JS search for the UI and add Swift search for intents and the bridge. That gives two rankers that drift, and consent membership could differ from what the collection screen shows. It is the two-ways-to-do-one-task red flag at the most sensitive point in the system.
- **App Intents extension process.** It cannot share the loaded model, it needs App Groups to read the store (belief: limited on a free team), and a 388 MB model is far over extension memory budgets (belief). It lost on capability.
- **Policy on the relay.** The relay would need membership, which needs the index. That violates the core privacy rule.
- **MCP tasks for the asynchronous part.** It fits the spec (read, GROUNDING), but client support is uneven (belief). `ask_puffer` plus `get_puffer_answer` works in every client today. Tasks can wrap the same `Mailbox` later without a protocol change on the phone.
- **WebSocket between phone and relay.** It gives lower idle latency, but adds connection state, reconnect logic and a second code path for background wakes. Long-poll delivers a parked request within one round trip.

## Implementation reconciliation

### Relay (`relay/`)

Status (2026-10-07): implemented. `npm run e2e` passes 30 of 30 assertions against a fake phone that speaks the real sync protocol, with the MCP client SDK as the agent. It has not yet run against the simulator app.

Wire additions pending acceptance by the native owner. Both are additive, so a phone built to the wire above still interoperates:

1. `broaden: Bool` on every `WireRequest` in the sync response. SYNTHESIS 5 adds `broaden` to `ask_puffer`, and only the phone can act on it. Swift's synthesized `Decodable` ignores the key until the phone reads it.
2. `photosWithheld: Int` on an `answered` outbox entry, optional, default 0 (SYNTHESIS 5). The agent sees it as `photos_withheld`.

Details the wire above left open, now pinned by the relay (no shape change):

- A key digest is `sha256:` plus the lowercase hex SHA-256 of the whole UTF-8 key, prefix included (`ak_...`, `dk_...`). Other forms get 400.
- `askedAt` and `expiresAt` are UTC ISO 8601 at whole seconds (`2026-10-07T14:02:11Z`), because Swift's `.iso8601` strategy rejects fractional seconds.
- An absent key and `null` mean the same for `registry`, `text` and `imageJpeg`, because Swift's synthesized `Encodable` omits nil optionals.
- A request id matches `rq_[A-Za-z0-9_-]{8,64}`.
- For a settled id, the ack carries the kind the relay stored (first terminal outcome wins). For an id the relay no longer knows (restart, 1 h retention), the ack echoes the sent kind so the phone stops re-sending it.
- A sync that carries outbox entries returns at once, whatever its `waitMs`. Requests already handed over ride along on every response but do not end a long-poll early, so a phone that is still triaging does not spin.

Local decisions that leave the shared contract intact:

- MCP SDK v2: `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node` 2.1.1, with `@modelcontextprotocol/client` 2.3.1 in the e2e. The v2 README names it the stable line that replaces `@modelcontextprotocol/sdk` 1.x. `createMcpHandler` serves the 2026-07-28 revision and falls back to stateless serving for 2025-era clients. The e2e drives both eras.
- Wait budget 50 s (SYNTHESIS 11), now read rather than belief. The Claude Code MCP docs (code.claude.com/docs/en/mcp, read 2026-10-07) give an HTTP server a per-request timer to the first response byte. The timer is the greatest of 60 s, the server's tool timeout and `MCP_TIMEOUT`, and an unset `MCP_TOOL_TIMEOUT` (default about 28 h) does not count. A call still running after 2 minutes moves to a background task, and the idle window for HTTP servers is 5 minutes. 50 s stays under the 60 s timer with margin. `--wait-ms` overrides it.
- Presence is online while a long-poll is parked or for 35 s after the last sync.
- Retry dedupe matches agent, trimmed question text and `broaden` within 10 minutes.
- The server binds 127.0.0.1 and has no `--host` flag. The SDK's Host and Origin guards admit only localhost names.
- `ToolOutcome` lives in `mailbox.ts` next to `toolStatus`, its only producer, and every structured result carries `request_id`. `get_puffer_answer` waits the same budget as `ask_puffer`. The mailbox takes no injected clock, because its timers are real.
- `openRegistry` mints the device key in memory, and the server saves it only after `listen` succeeds, so a failed start never strands a key nobody saw.
- Tool results copy only title, kind and text from shared items, and the zod schema also strips unknown item fields. The e2e checks the pair by sending `vec`, `embedding` and `sourceUri: "photo:..."` from the fake phone.

Open risk: the relay ignores a registry snapshot whose revision is not above its own. A reinstalled app that restarts at revision 1 would leave the old digests valid until it pushes a revision above the relay's. Every sync response reports `registryRevision`, so the phone can detect this and bump past it.

### Native (`modules/puffer-native/`, `src/`)

Accepted by the native owner during Phase D. Each entry says why the shared contract still holds.

Unit 1, spike (2026-10-07). Verified on the simulator. The plugin copies `app-target/*.swift` into `ios/Puffer/` and links it with `IOSConfig.XcodeProjectFile.withBuildSourceFile` (SYNTHESIS 8). The Shortcuts app lists "Search Puffer" under Puffer, the intent prompts for the query and its `perform()` calls into the pod. `BGTaskScheduler.register` returns true on the simulator build.

- App-target files import the pod as `internal import PufferNative`. A plain `import` fails because the generated app target already imports it at internal level. Nothing else changes.
- The plugin copies at prebuild, so an edit to `app-target/` needs `npx expo prebuild` before the next build. The sketch's "referenced in place, edits need no re-prebuild" no longer holds; SYNTHESIS 8 already chose copying.
- Open question 1 is closed. Intents stay in the app target, and the pod-hosted variant was not tried.

Unit 2, engine port (2026-10-07). Verified on the simulator. The in-app harness ran 30 cases (every mode x dim x rerank for text queries, plus 6 `like` queries spread over photos and passages) through the old JS `search()` and the native `engine.search`. All 30 matched on top-10 ids and order, and the largest score difference was exactly 0. Then `src/puffer.ts`, `src/library.ts`, the harness and the temporary `legacy*` module functions were deleted, and `src/store.tsx` now runs on the native module with its `Store` contract unchanged.

- The actor is `PufferEngine` in `PufferEngine.swift`, not `Engine` in `Engine.swift`. The vendored LiteRT-LM sources compile into the same module and already define `public actor Engine` and a file named `Engine.swift`. The role and API are the sketch's.
- The scan is a plain loop with float64 accumulation, not `cblas_sgemv`. It reproduces the JS numerics (float32 rows, float64 dot products, float32 scan scores, stable sorts), which is what made parity exact. BLAS is a later optimization that would change scores in the last bits.
- BM25 terms are UTF-16 code-unit arrays, so keys compare as the old JS `Map` did, without Unicode normalization.
- `Hit` carries an internal `StoredItem` (card plus `sourceUri` and the stored millisecond `addedAt`), because the in-app library needs the source path. `ItemCard`, the public type, still has no path and no vector.
- `openStore()` is synchronous inside the actor, so concurrent callers cannot interleave a second open. `start()` is `openStore()` plus a shared, retryable model load. JS calls `items()` and `start()` separately, so the library lists appear before the model finishes loading, as before.
- The embedding runtime is `actor Embedder` with one shared load task, replacing `EmbedRuntime`. Prompts live in `enum Prompt` beside it.
- Change events go through `NotificationCenter` (`Changes.post(topic)`), and the module forwards them as `onChange { topic }`. JS refetches the slice it renders. The event carries no revision number, since no caller needed it.
- The folder picker and folder store moved to `Folders.swift` unchanged, so `PufferModule.swift` stays a thin boundary.
- `metro.config.js` blocks `relay/` and `design/` from the bundler, so the relay package's `node_modules` churn cannot break Metro.

Unit 3, bridge (2026-10-07). Verified on the simulator. A dev request (Agents, Simulate) was triaged to review, the review screen showed the frozen candidates with their full excerpts, one was switched off, and History recorded "Shared 2 items". With the UI search mode switched to keyword, the Contracts collection kept the same three members, including an invoice photo that a keyword search cannot return.

- Consent lives in `Triage.swift`: `Triage.decide`, `Triage.approve` (throws `notOffered` or `nothingChosen`, SYNTHESIS 2), the fileprivate `Approval` and `SharedItem` initializers, and `Egress.materialize` (SYNTHESIS 1). `Candidate.excerpt` is the outbound text (SYNTHESIS 3). The synthesized `Decodable` initializer of `SharedItem` is the one way around the fileprivate rule, and it is used only to read bridge.db.
- Amendment 14 replaces `Agent.grants` with `access: AccessLevel` (`askEveryTime`, `collections(Set)`, `everything`) and `includePhotos`. `Coverage` resolves the level per request. A top-3 photo is offered and covered only when `includePhotos` is on. `broaden` and the rate limit (5 automatic answers per agent per minute, derived from the ledger) force review. `PolicyEdit` has `setAccess` and `setPhotos` in place of the per-collection `grant`.
- The policy type is `SavedCollection`, not `Collection`, which would shadow `Swift.Collection` in a module that also compiles vendored generic code.
- bridge.db stores each entity as a JSON document per table through a small shared `SQLiteDB` helper (`Storage.swift`), which `ItemStore` also uses.
- `LedgerEntry` gained `agentName` (History names a disconnected agent) and `origin` (`relay` or `local`). Local requests come only from the dev `devAsk` and never enter the outbox, because their ids would fail the relay's `rq_` schema.
- Starter collections are seeded natively on first open of bridge.db.

Unit 4, relay client (2026-10-07). Verified against `relay/` running locally on a scratch state file. Pairing through `puffer://pair` pushed the registry with the digest the phone computed. An MCP `ask_puffer` from a client built on `@modelcontextprotocol/client` reached the phone in seconds, waited for the review, and returned `answered` after approval (19.3 s). A denied request read back as `declined`. With Contracts and Health granted, the same question returned `answered` in 216 ms without review. Disconnecting the agent dropped it from the relay registry, and its key then got 401.

- The wire additions are accepted: `broaden` on `WireRequest` and `photosWithheld` on `answered` are implemented.
- One sync loop serves foreground long-polls, and `kick()` sends a fresh outcome or registry at once in a second request, which the relay answers while it releases the parked one. No request cancellation is needed.
- A response whose `registryRevision` is above the phone's moves the phone's revision past it, which addresses the relay's reinstall risk.
- Open: the relay's answer text says "with the user's approval" for grant answers too, because the outbox does not say who approved. Adding `approvedBy` to `answered` would be a wire change for the relay owner.

Unit 5, background (2026-10-07). Verified on the simulator. After Home, the grace loop ran about 25 s and the relay showed the phone offline about 40 s after backgrounding. An ask returned `phone_offline` after the 2 s grace. Running "Check Agent Requests" from the Shortcuts app answered it ("1 answered, 0 waiting for you"), and `get_puffer_answer` returned the answer. A `broaden` ask run the same way gave "0 answered, 1 waiting for you" and a local notification "Claude Code asks". `BGAppRefreshTask` registers. Submitting it fails on the simulator, as expected, and is logged.

- Notification permission is requested when an agent is connected and on activation while agents exist.
- Amendment 13 is `Sources.swift`, a single-flight catch-up over the photo library (PhotoKit, a `PHPhotoLibraryChangeObserver`) and the granted folders, run on launch, on foreground, in background refresh and from the Library buttons. It mints the same ids the JS ingest did: `photo:ph://<localIdentifier>`, and `file:` plus FNV-1a over UTF-16 of `folderId/path:size:modified`, with the Double printed as JS prints it. That id format was checked against a stored key before the first run. Checked on the simulator: a photo added to the library was indexed within seconds with no button press, and a launch catch-up added no duplicates (21 photos, 9 passages).
- The JS photo and folder ingest, its cancel token and the Stop button were deleted. JS keeps only the document picker import. Onboarding copy now says sources stay up to date and suggests the top of iCloud Drive or On My iPhone.

Unit 6, Siri, Shortcuts and Spotlight (2026-10-07). Verified on the simulator. "Search Puffer" from Shortcuts answered "Puffer found mochi-vet.txt and 2 more". Spotlight lists Puffer items, and tapping `mochi-vet.txt` opened its item screen through the subscriber's `continue` forwarding. A photo item route with an encoded `/` in its id opened too.

- Item routes percent-encode the id as one path segment, because ids contain ":" and "/".
- `ShowCollectionIntent` and `CollectionEntity` from the sketch are not built. The delivery unit named only search and open. The facade calls they need (`collections`, `members`) are not public yet.
- Spotlight converges through a `spotlightCount` row in a new `meta` table in puffer.db. A count that lags re-upserts every item, and upserts are keyed by item id.
- Not verified: tapping the review notification itself, because the simulator's cover sheet ignores injected taps. The `puffer://request/<id>` route it opens was checked directly.

## Open questions and risks

1. Can App Intents live in the static `PufferNative` pod on Xcode 26? A search summary claims App Intents now work in Swift packages and static libraries (read, unconfirmed against Apple docs). If a one-file spike shows an App Shortcut from the pod in the Shortcuts app, should the app-target plugin be deleted and `ItemEntity` become an `IndexedEntity` in the pod?
2. Does `ExpoAppDelegate` forward `application(_:continue:restorationHandler:)` to subscribers? The Expo page lists launch and lifecycle methods only (read). If not, how should a Spotlight tap reach the item route?
3. Can a free personal team use the Background Modes capability for `fetch`? (belief: yes). If not, wakes are foreground, automation-run intents and any Puffer intent.
4. Will a background wake survive loading the 388 MB model? If the load fails, triage leaves the entry `received` and retries at the next wake. It never falls back to keyword ranking for consent, because that would change the candidates. Is a fail-closed delay acceptable?
5. Is "a grant covers whatever matches the description, now and later" the mental model users hold? The grant sheet must say it in words.
6. A compromised relay can impersonate any connected agent and read what that agent's grants allow. Is self-hosting enough this round, or should grants require a fresh approval per agent session?
7. App Shortcut phrases cannot embed a free-form `String` parameter (belief). "Search Puffer for the lease deposit" in one utterance likely becomes "Search Puffer", then Siri asks what to look for. Collection phrases ("Show my Receipts in Puffer") can embed a `CollectionEntity`. Is the follow-up prompt acceptable?
8. Search intents set `authenticationPolicy = .requiresAuthentication` (belief: available on iOS 18) so a locked phone does not read personal snippets aloud. `CheckAgentRequestsIntent` must run locked, so it uses `.alwaysAllowed`. Is that the right split?

## Next implementation step

Build `Engine` (store, ranking port, embedder) in `PufferNative` with the in-app parity harness against today's JS `search()`, then delete `src/puffer.ts` and `src/library.ts`.

Delivery order, each unit ending in a check, per sequence-verifiable-units:

1. Spike (about an hour). Test intent hosting in the pod versus the app target, subscriber `continue` forwarding, and the `fetch` background mode on the free team. The results decide items 1, 2 and 3 above.
2. `Engine` port and parity. JS `store.tsx` over native. The check is a temporary dev-only parity harness inside the app. It runs 30 queries across all modes and dims through both the legacy JS `search()` and `engine.search`, and it fails on any top-10 id or order mismatch. Only then are the JS files deleted.
3. `Bridge` policy and ledger. `useBridge`, `useCollection` and `useAgentRequest` replace the preview reducer's collections, agents and requests. The check is that collection membership no longer moves when the search mode changes.
4. Relay, sync and MCP. The check is `relay/scripts/e2e.ts`, which drives the real simulator through pair, connect, ask, approve, grant, auto-answer, revoke and 401, with an MCP SDK client.
5. Background. Grace period, `BGAppRefreshTask`, `CheckAgentRequestsIntent` and local notifications. The check is to ask while the app is suspended, see `phone_offline`, run the intent from Shortcuts, then see `get_puffer_answer` return.
6. Siri, Shortcuts and Spotlight. The check is a Shortcuts run of "Search Puffer", plus a Spotlight query on the simulator that finds an item and opens it.

### Parent verification and fixes (2026-10-07)

Verified on the simulator with the real relay and an MCP SDK client as the agent: pair by deep link, connect agent (key shown once, digest matched the relay registry), ask with "Ask Every Time" (review shown, two of three snippets switched off, agent received exactly the one approved passage), "Everything" level (text answered automatically in under 100 ms, photos withheld with `photos_withheld: 2`), offline ask queued and answered after relaunch. Three defects found and fixed:

1. Consent overshared. `Triage.decide` offered the top 3 hits regardless of relevance because canonical search keeps a floor of 3 hits for browsing; a vet question auto-shared the bike claim with a police report number. Fix: a candidate is offered only within `consentWindow` (= `Ranking.relevanceWindow`) of the best similarity. Check: the same question now shares only `mochi-vet.txt`.
2. Automatic answers said "with the user's approval". Fix: additive wire field `approvedBy: "user" | "grant"` on `answered` (default `user`), `approved_by` in the tool result, header text per approver. Relay e2e still 30/30.
3. The sync loop never started after a cold launch: `applicationDidBecomeActive` set presence before anything ran `Bridge.start()`, so `link` was nil and `restartLoop()` returned. Fix: `setPresence` calls the idempotent `start()` first. Check: a request queued while the app was closed was answered after relaunch.
4. Minimum confidence (user request). Anything that leaves the app (agent consent in `Triage.decide`, `Puffer.search` for Siri and Shortcuts) now requires an absolute cosine similarity at 768d: 0.65 for passages, 0.68 for photos (`Ranking.minConfidence`). Calibrated with `src/dev/calibrate.ts` (opt-in via `EXPO_PUBLIC_PUFFER_CALIBRATE=1`) on 30 labeled queries against the demo library: text answers 0.705-0.842 vs no-answer 0.512-0.596; photo answers 0.700-0.779 vs no-answer 0.587-0.658, photo top hits checked by eye. In-app search keeps showing weak matches; nothing leaves there. Checks under "Everything": "best chess openings" and "a violin" now return `nothing_found` (before: the best weak passage was shared automatically); the vet question still returns only `mochi-vet.txt`; "a printed receipt" still finds both receipt photos (withheld, photos off). The photo margin is about 0.02 on each side and the sample is small, so recalibrate on a real library.
5. One floor everywhere (user: "rather not return anything than completely useless stuff"). The confidence floor moved into `Ranking.relevant`, so app search, collections, agent consent, Siri and Shortcuts all get the same cut; the minimum of 3 hits is gone, and the per-caller checks from item 4 and the separate consent window were removed. Text queries: similarity >= 0.68 (raised from 0.65; every labeled answer scored >= 0.705) and within 0.1 of the best. "Find similar" (item-to-item) keeps only the relative window, since its scale was not calibrated. Checks: in-app "best chess openings for beginners" shows "No Results"; "the deposit amount in my lease" shows only lease-notes.txt (before: plus the bike claim and vet note); agent asks return nothing_found for chess and violin, only lease-notes.txt for the deposit, only expenses-2025.md for the accountant question.

### Defaults round: sources onboarding, background index, model location (2026-10-07)

User decisions: photos and files are one default onboarding step, the first full index finishes without the app open, and the model leaves iCloud backup while the index stays in it. Verified on the iOS 26.3 simulator unless a line says otherwise.

Onboarding and Library:

- `Gate` keys on a persisted flag (`puffer.onboarded` in the expo-sqlite kv-store, database `ExpoSQLiteStorage`), not on a missing model. The model step shows only when the model file is missing. An install from before this round sees the sources step once. To reset onboarding, delete that key; the app and its index stay.
- The primary action asks for photo access, then presents the folder picker at once. The screen changes to the "Allowed" list only after both answers, so nothing flashes between the two system sheets. "Add Another Location" and "Not Now" follow. The Library shows an "Add Your Files" section while no folder is granted.
- A folder grant no longer needs the model. `addFolder` saves the bookmark and starts a native sync, which indexes once the model is ready. A finished download also starts a sync, for grants made while it ran. Not exercised: a fresh install with a real download.
- `allowPhotos` uses the classic `expo-media-library` export, whose `PermissionResponse` types `accessPrivileges`. The `next` export does not.

What iOS allows in the folder picker (simulator, German locale):

- The Browse screen that lists the locations offers no Open button. A person must enter a location first.
- Inside On My iPhone, Open is enabled at the top level. It grants the File Provider root, and the recursive scan reaches every subfolder. Check: with the earlier Notes grant present, granting the root indexed only the one new file in `Manuals/` ("sources: 0 photos, 1 files added"), and Documents went from 9 to 10.
- iCloud Drive is signed out on this simulator, so Open is disabled there. The top of a signed-in iCloud Drive is not verified.
- A folder made on the host file system is scanned when an ancestor is granted, but it cannot be picked itself: fileproviderd logs "can't get item for URL". Folders made through Files or the picker can be picked.
- iOS reports the directory name as the display name of the On My iPhone root ("File Provider Storage"). `FolderStore.displayName` maps that name and `com~apple~CloudDocs` to "On My iPhone" and "iCloud Drive". Risk: a third-party provider whose root directory has the same name would also show as On My iPhone.

Overlapping grants. A folder inside a saved grant is not saved again: `add` returns the covering grant. A scan skips the subtree of any other saved folder inside it, so files keep the ids their first grant gave them. Without this, granting the top of On My iPhone after Notes would have indexed the nine Notes files a second time under new ids.

Background index (`BGProcessingTask`, requires external power, no network):

- The config plugin writes `PufferBackgroundTasks` (role to id), adds both ids to `BGTaskSchedulerPermittedIdentifiers` and adds the `processing` background mode. `BackgroundTask.refresh` and `.index` read the ids back by role, so the plugin stays the only copy and Info.plist order does not matter.
- `Sources.behind` is true while a pass runs or after one ended early, and only while the model file exists. A pass that finishes with unreadable files still counts as finished, so a broken file cannot keep the task rescheduling forever.
- Entering the background schedules the task when `behind`. The handler runs `catchUp`, schedules itself again while `behind`, and completes with `success: !behind`. On expiration, `Sources.stop()` cancels the pass after its current item. The refresh task's expiration now stops the pass too. Before, it cancelled only the outer task, which never reached the pass.
- Simulator limits: every submit fails with `BGTaskSchedulerErrorDomain` error 1, and `_simulateLaunchForTaskWithIdentifier:` refuses with "No task request with identifier dev.local.puffer.index has been scheduled". The handler was run by calling the registered launch handler from lldb with a `BGProcessingTask` made by its private initializer. It indexed one new file and logged `behind: false`. Expired at a breakpoint in `FolderStore.scan`, it logged `behind: true` and tried to schedule itself again. Not verified: a launch by iOS on a device on power.

Model location:

- The model moved to `Library/Application Support/Model/`. `isExcludedFromBackup` is set on the directory and on the model file, and the file is marked again before every load, because a download replaces it. `ModelLocation.prepare()` runs once, when `PufferEngine.modelURL` is first read, before JS checks for the file.
- The migration moves every file in Documents whose name starts with the model name. That includes the XNNPACK caches LiteRT writes next to the model (290 MB), whose names encode the model's modification date. A move keeps that date, so the caches were reused: no new cache files appeared after the load. Documents now holds only `SQLite/` and `thumbs/`, which stay in the backup.
- Evidence: the exclusion xattr `com.apple.metadata:com_apple_backup_excludeItem = com.apple.MobileBackup` is on the Model directory and the model file, and not on `puffer.db`, `thumbs` or `bridge.db`. A macOS `URLResourceValues` read reports `true` for every path under CoreSimulator, so it cannot tell them apart and was not used.

### Change log round: changes for agents, Recent Changes, Open in Puffer (2026-10-07)

Verified on the iOS 26.3 simulator against the real relay unless a line says otherwise. Evidence (logs and screenshots) is in the session scratchpad under `round-changes/`.

Change log (unit 1):

- `ChangeEvent { seq, at, kind: added | updated | removed, itemID, itemKind, title, source }` lives in a `changes` table in puffer.db. `seq` is SQLite `AUTOINCREMENT`, so it is never reused. `PufferEngine` is the only writer.
- One event per document, not per passage. A document is a photo, an image file, or the passages of one text or PDF file. `itemID` is the document's first item, so a tap opens the start of the file. Per-passage events could not express "one `updated` instead of removed plus added" for a file whose passage count changed.
- `PufferEngine.put(_:replacing:)` and `remove(_:)` replace `addPassages` and `addImage`. A file's passages are embedded in batches of 8 and committed once, with their event, in one transaction (`ItemStore.apply`). The event kind follows what the statements did: rows inserted and deleted is `updated`, only inserted is `added`, only deleted is `removed`, neither logs nothing. A re-run therefore converges without duplicate events. A crash mid-file no longer leaves a partial file behind.
- A delete reloads the in-memory index from the store, because the vector and BM25 indexes are append-only. Deleted items also leave Spotlight, and their thumbnails are deleted.
- Folder rescans compare by source URI, `folder:<root name>/<path>`. The same path with a new size or date is replaced in one `updated`. A stored path that no scan lists is `removed`, but only when every scan for that root name finished: an unreachable folder or a walk cut at the 20,000-file limit never looks emptied.
- Rows stored under an older root name (here `folder:File Provider Storage/...`, from before the On My iPhone display-name mapping) are moved to the current name with `relabel`. It is not a change event. Without it, deleting such a file was never detected.
- Photos: a catch-up pass, run by the PhotoKit observer and on launch and foreground, removes indexed photos the library no longer returns. Photos dropped from a limited selection count as removed. An empty fetch removes nothing, so a library that has not loaded is not mistaken for an emptied one.
- Retention: events older than 90 days are dropped when puffer.db opens. `clear()` logs one `removed` per document.
- Not done: no backfill. Items indexed before this round have no `added` event.
- Check: in On My iPhone/Manuals, adding `coffee-machine-descaling.txt`, editing `router-setup.txt` and deleting `dishwasher-warranty.txt` gave exactly `updated`, `added`, `removed`. The old router passage and every dishwasher row were gone. A second relaunch added no events. A photo added with `simctl addmedia` logged `added` within seconds, and deleting it in Photos logged `removed`.

Changes for agents (unit 2). Wire additions, all on protocol v1:

1. `WireRequest.kind: 'ask' | 'changes'`. An absent `kind` is an ask. A changes request carries `since: string | null` and `limit` (1 to 200; the relay defaults it to 50) instead of `question` and `broaden`. The relay must send `limit`, because the cursor has to reflect what the phone returned. A phone built before this round fails to decode a sync response that carries a changes request. That fails closed, and both sides ship together.
2. An `answered` outcome gains `changes: { events, nextCursor, hiddenCount } | null`. `items` may be empty when `changes` is present; zod requires one or the other. An answer that does not fit its request (a page for an ask, items for a changes request) settles as `expired`.
3. Events on the wire: `added` and `updated` are `{ kind, at, itemKind, title, source, excerpt? }`. `removed` is `{ kind, at, title }`. No ids and no paths. The zod schema strips anything else; the e2e sends `itemID` and `sourceUri` from the fake phone to check it.
4. `SyncBody.changeHeads: [{ agentId, seq }]`, optional. `seq` is the newest change-log seq that agent may read under its current access. It carries no titles and no count of hidden changes. The phone sends every agent's head when one differs from what the relay last took (a 200 response). The relay keeps the latest heads in memory only, for registered agents, drops them on revoke, and exposes nothing yet. Observed: switching the agent from Ask Every Time to Everything sent `[{"agentId":"ag_Yhnl-9RroIT8","seq":7}]`.

Details:

- The cursor is the decimal `seq`. It is opaque to the agent; the relay only bounds it (`[A-Za-z0-9_-]{1,64}`). A cursor ahead of the log, for example from before a reinstall, reads as no cursor.
- Paging: with no cursor, the page is the newest `limit` readable events and `nextCursor` is the newest seq in the log. With a cursor, the page is the oldest `limit` readable events after it, and `nextCursor` is the last event examined. `hiddenCount` counts unreadable events inside the page's span.
- Consent stays on the phone in one predicate, `Triage.readable`. An event is readable when its item still exists and the agent's access covers it, or when the item is gone and the access covers everything of its kind. So a `removed` event is visible only at Everything (photos need Include Photos), and at Selected Collections a gone item is hidden: membership cannot be checked for an item that no longer exists. Excerpts follow Triage's rule, cut at 200 characters. The relay bounds them at 1,000 UTF-16 units, because one character can take several. `ChangeNotice` has a fileprivate initializer in `Triage.swift`, like `SharedItem`.
- A changes request needs no review, raises no notification and writes no ledger entry. Its answer is held in memory until the relay acknowledges it; a lost answer is recomputed when the relay hands the request over again. At Selected Collections, while the model cannot load, the request stays unanswered until a later sync.
- The relay re-attaches an identical open changes request within the dedupe window, as it does for asks. It writes nothing new to disk.
- Every policy edit now kicks a sync, so a head that moved with access reaches the relay without waiting out the long-poll.
- e2e: 36 of 36, the 30 existing assertions plus 6 new ones (changes request shape, page rendering with a title-only removal, cursor and limit passthrough, mismatch settles expired, heads accepted and kept out of the state file, tool description). Two existing assertions now expect three tools instead of two.
- Check, with the MCP client at Everything (Include Photos off): the first call returned 3 events, `hidden_count: 2` (the two photo events) and cursor 5. The call with cursor 5 returned nothing. After adding `bike-light.txt`, the call with cursor 5 returned only that file, cursor 6. At Ask Every Time: no events, `hidden_count: 6`. The call with cursor 6 returned nothing. After adding `smoke-alarm.txt`: no events, `hidden_count: 1`, cursor 7. The ledger stayed at 21 rows. The agent is back at Everything.
- Open: History does not record change reads, and change reads have no rate limit. After a relay restart the relay holds no heads until one moves.

Recent Changes (unit 3): Library's "Recently Added" became "Recent Changes": the newest 6 events with verb, source and relative time. A row whose item still exists opens it. A row for a removed or replaced item is dimmed and inert.

Open in Puffer (unit 4):

- The config plugin declares `CFBundleDocumentTypes` (PDF, plain text, Markdown, JPEG, PNG, HEIC; role Viewer, rank Alternate, so Puffer is never the default app), imports the Markdown UTI, and sets `LSSupportsOpeningDocumentsInPlace` to false.
- `PufferAppDelegate.application(_:open:options:)` takes file URLs and returns true, so they never reach React Native linking. `puffer://` links return false and route as before.
- `ShareInbox` copies the file into `Application Support/Shared with Puffer/` (backed up, never in the Files app), runs a sources pass, and keeps one confirmation per file. The UI drains confirmations on launch and on a `shared` change, so a cold launch does not lose one. The same name with other bytes replaces the file and logs one `updated`. Identical bytes change nothing ("already in Puffer").
- iOS 26 delivers the copy to `tmp/<bundle id>-Inbox/`, not `Documents/Inbox`. The copy is deleted once saved.
- A cold launch from a file URL would make expo-router look for a route. `src/app/+native-intent.tsx` sends it to `/`.
- The in-app "Add Files" picker now imports through the same path. `src/ingest.ts` and the dead JS module functions it needed (`addPassages`, `addImage`, `scanFolder`, `readFolderText`, `copyFolderFile`, `pdfText`) are deleted.
- A file shared from inside a granted folder is indexed twice, once per source. That is accepted: Open In makes a copy.
- Check: from the Files app share sheet, Puffer is offered for a PDF and a Markdown file. With Puffer in the background, sharing `kettle-warranty.pdf` showed "Added “kettle-warranty.pdf” to Puffer" and logged `added` with source Shared with Puffer. With Puffer terminated, sharing `bookshelf-assembly.md` launched it on Library with the same confirmation.

Nested grants (unit 5): `FolderStore.list()`, which feeds the onboarding Allowed list and Library's Sources, leaves out a grant inside another grant. `roots()` still scans every saved grant plus Shared with Puffer, so ids keep the grant that first indexed them. Check: with Notes and On My iPhone both granted, both lists show On My iPhone only.

### Notify round: push, nudge, page cache, hosting prep, shared-file dedupe (2026-10-07)

Agents now learn about new documents the Gmail way. The relay sends a content-free ping when an agent's change head advances, and the agent then calls `get_puffer_changes`. Verified on the iOS 26.3 simulator against the real relay unless a line says otherwise. Evidence (logs, screenshots) is in the session scratchpad under `round-notify/`. `npm run e2e` passes 54 of 54 (36 before).

Data shapes:

- Relay, `relay/src/notify.ts`. `Notifier` owns the heads (moved out of `Mailbox`) and the sinks. `Sink` is a union by kind: `mcpEvents` (an MCP Events subscription) or `webhook` (set on the phone). Each sink has one `notified: number | null`, the head it last heard. Null becomes the baseline when the first head arrives, unsent. One debounced fire path per agent (3 s default) sends the current head to every sink below it. A per-kind switch supplies the headers. The same path covers a subscription with an older cursor and an unknown head after a restart.
- Relay, `Mailbox`. It keeps one `PreparedPage { since, page, receivedAt }` per agent and one read cursor per agent, in memory only.
- Phone, `Bridge`. `Notices { basis, heads, pages }` is cached by `NoticesBasis { latest seq, policy version, read cursors }`. `Bridge.changesPage` is the one rule behind a changes answer and a prepared page, so the relay never serves a page the phone would not have answered.

Wire additions, all on protocol v1:

1. `changeHeads` goes on every sync, not only when a head moved. A restarted relay has the heads after one round trip. The relay pings only when a head is above what a sink heard.
2. `SyncBody.changePages?: [{ agentId, since: Cursor | null, page: ChangesPage }]`. Present means a full replace, absent keeps what the relay has. The phone sends a page for every agent not at Ask Every Time, computed since the agent's read cursor, at most 50 events and 24 KB (halving the limit until it fits).
3. `registry.agents[].notify?: { url, token? } | null`. The relay parses it leniently (a malformed one reads as none) and keeps it in memory only. `registry.json` is unchanged.
4. Registry acceptance is `>=`. An equal revision refreshes notify and saves only when the persisted part changed.
5. `SyncResponse.readCursors: [{ agentId, cursor }]`. It holds the `next_cursor` the relay last returned to each agent, from a phone answer or from a prepared page. The phone computes its next page since it.
6. `SyncResponse.wantsRegistry: boolean`, true until this relay process accepts a snapshot. The phone then re-sends the same revision. The first sync after a relay start is answered at once, whatever its `waitMs`, so the re-send takes one round trip and not a 25 s long-poll. A change in that window would otherwise only set a new webhook's baseline. That gap was found on the simulator and fixed. It is now covered by the e2e restart assertion.

Agents see four additions. `phone_offline` and `waiting_for_user` carry `open_url` and a sentence asking the user to open Puffer. Every changes answer carries `approved_by: 'grant'`, and one the relay served from the phone's page also carries `prepared_at` and says the phone is offline. The server advertises the MCP Events capability `events: { listChanged: true }` with `events/list`, `events/subscribe` and `events/unsubscribe`; the SDK has no events support, so the methods are custom request handlers and the capability is registered with a cast. Every webhook POST carries `{ eventId, name: 'puffer.changes', timestamp, data: { head }, cursor: String(head) }`, where `eventId` is deterministic from agent and head.

U1, nudge. `GET /open/<id>` serves a content-free page that redirects to `puffer://request/<id>` for an ask and to `puffer://agents` otherwise, with a visible fallback link. The public base comes from `--public-url` or `PUFFER_PUBLIC_URL`, default `http://localhost:<port>`. Check: with Puffer suspended, a `broaden` ask returned `phone_offline` with the link and no question text. `simctl openurl` on the link opened Safari, which asked "Open this page in Puffer?". Puffer then showed the review screen for that request, triaged to `plant-care.md`. `puffer://agents` opens the Agents tab.

U2, hosting readiness, no deploy. `HOST`/`PORT`/`PUFFER_STATE`/`PUFFER_PUBLIC_URL` (flags win), `relay/Dockerfile` (node:24-slim, tsx), `relay/fly.toml` (one always-on machine, `/data` volume, `/healthz` check) and `relay/README.md` "Hosting". The Host guard admits the public URL's host. `/healthz` and `/open` sit in front of the guards because they reveal nothing. Check: `docker build` succeeded, and the container answered `/healthz` 200 on 127.0.0.1:18787, 403 for a foreign Host. It was then stopped and the image removed (`u2-docker.log`).

U3, MCP Events push. A subscription is verified once per (agent, url) with a signed single-use challenge. It upserts by a deterministic id over (agent, url, name, arguments) and lives as soft state until `refreshBefore` (1 h default, 60 s to 24 h). Deliveries are signed with Standard Webhooks HMAC-SHA256. Network errors, 408, 429 and 5xx are retried 5 times with the same eventId and a fresh signature. Deviation from the round brief: 410 and 413 end that one delivery and keep the subscription, because the spec says a 410 must not affect the subscription. Check on the simulator: the test agent subscribed with cursor 15 and the challenge arrived signed and valid. Adding `window-cleaning.txt` to On My iPhone delivered one signed event `{head: 16}`. `get_puffer_changes(since: "15")` then returned the file.

U4, changes while the phone sleeps. When a changes request would answer `phone_offline`, the relay answers from the agent's prepared page if `since` matches and the request's limit is at least the page's length. It serves the page unchanged; consent stays on the phone. Check: with Puffer in the background past the grace period and the relay reporting it offline, `since: "15"` answered in 6 ms with three events (window-cleaning added and updated, gutter-cleaning added), `next_cursor` 18, `approved_by: grant`. `since: "17"`, which no page covers, returned `phone_offline` with the link.

U5, webhook sink. The agent screen has a Notify section with a URL field, an optional bearer token field, Save and Stop Notifying. The footer says the ping carries nothing but the fact of a change. The phone validates https, or http to loopback, and stores the target in `Agent.notify` in bridge.db. It is backed up and is not in the Keychain. A save bumps the registry revision. Check: with `http://127.0.0.1:9999/poke` and a test token, a file edit delivered `{head: 17}` with `Authorization: Bearer <token>` and the same eventId as the MCP Events delivery. After a relay restart, the next change (head 18) still reached /poke, because the phone re-sent its snapshot. The relay state file never held the URL or the token. The test webhook was removed afterwards.

U6, dedupe shared files. `SharedFolder.save` asks `FolderStore.holder(of:)` whether any scanned root (grants and Shared with Puffer) holds a file with the same SHA-256 of its bytes. Only files of the same size are hashed. If one does, nothing is copied, nothing is indexed and no change is logged, and the user sees "“name” is already in Puffer". Bytes are the key because Open In hands over a byte-exact copy, and bytes also cover images, which have no extracted text. Check: sharing `Notes/plant-care.md` from the Files app share sheet showed the confirmation. Documents by source, the plant-care rows and the newest change seq (15) were unchanged, and nothing appeared in Shared with Puffer. An in-app search for the fiddle leaf fig shows one hit, from Notes.

Fixed in passing:

- After a presence change, the Agents tab showed "Relay unreachable: cancelled" next to "Last Contact: Just now". URLSession reports a cancelled long-poll as `URLError.cancelled`, and `RelayClient` now maps it to `CancellationError`.
- iOS offered "Save Password?" after the Notify token was edited, because a secure field next to a URL field reads as a login form. The fields now set `textContentType` (`URL`, `oneTimeCode`). The prompt did not come back in the same edit-save-background sequence. iOS decides this heuristically.

Not built, or not verified:

- No deploy, no flyctl run, no OAuth. Agents still authenticate with `ak_` keys. The container runs as root so it can write the Fly volume.
- Callback safety is https plus no redirects only. There is no DNS or IP check against private addresses, and no cap or rate limit on subscriptions.
- No `terminated` or `gap` control envelopes and no replay. `truncated` is always false. `maxAgeMs` is accepted and ignored.
- Pings due while the relay is down are lost. The first head after a restart is a baseline.
- Retries for one sink can arrive out of order. Each event carries its head, so a receiver should keep the highest.
- The phone-set webhook has no verification handshake and no signature, only the bearer token.
- A prepared page covers only the agent's read cursor as the relay last returned it. A re-read of an older cursor, or the second chunk of a page cut at 50 events or 24 KB, needs the phone. Agents at Ask Every Time get no page.
- Pages ride on every sync, up to 24 KB per agent per long-poll. The cost on cellular is not measured.
- Not exercised on the simulator: pages at Selected Collections, a push caused by a background wake rather than a foreground pass, a public https `/open` link, and real Poke, ChatGPT or Dots clients.
- Dedupe runs only at import. A file shared first and later found in a newly granted folder is still indexed twice, and a shared JPEG is not compared with the photo library. The earlier Shared with Puffer copies of `kettle-warranty.pdf` and `bookshelf-assembly.md` remain, and their On My iPhone copies were removed in the previous round, so they are no longer duplicates.

### OAuth round: authorization server on the relay, approval in Puffer (2026-10-07)

Clients that only speak OAuth, such as ChatGPT and Claude Code's remote MCP OAuth, can now connect to the relay by URL. The user approves each connection on the iPhone in Puffer and picks the access level there. Agents with an `ak_` key from Connect Agent work as before. Verified on the iOS 26.3 simulator against the real relay unless a line says otherwise. Evidence (logs, screenshots, curl transcripts) is in the session scratchpad under `round-oauth/`. `npm run e2e` passes 69 of 69 (54 before).

What the spec and the SDK say (read 2026-10-07, MCP authorization revision 2026-07-28, copies in `round-oauth/spec/`):

- The MCP server must serve RFC 9728 protected resource metadata. The authorization server must offer RFC 8414 metadata or OpenID Connect discovery, one of the two. Clients try the path-aware metadata URL first, then the root one.
- Client ID metadata documents are a SHOULD. Dynamic client registration (RFC 7591) is a MAY and is marked deprecated, kept for older clients.
- PKCE with S256 is required, and a client must refuse to proceed when the metadata lacks `code_challenge_methods_supported`. Clients must send `resource` (RFC 8707). Authorization responses should carry `iss` (RFC 9207).
- Redirect URIs must be https or localhost and match exactly. For metadata-document clients the server must show the redirect host and should warn about localhost-only redirects.
- The authorization server should issue short-lived access tokens, and refresh tokens for public clients must rotate.
- The SDK v2 server package has resource-server helpers only: `oauthMetadataResponse`, `getOAuthProtectedResourceMetadataUrl`, `bearerAuthChallengeResponse` and `verifyBearerToken`. The last one rejects tokens without an expiry. There are no handlers for `/authorize`, `/token` or registration, so those are ours. The client package has `auth()` and `OAuthClientProvider`; its metadata-document path accepts only https client ids.

Data shapes:

- Relay, `relay/src/oauth.ts` (`AuthServer`). A pending `Connection { id, pollToken, client { id, name, host }, pairingCode, keyDigest, codeChallenge, redirectUri, state, requestedAt, expiresAt, handed, phase }` lives in memory. `phase` is `awaitingPhone { key }`, `approved { key, code | null }` or `ended { redeemed | declined | expired }`. The raw key K exists only in the first two phases, so it cannot outlive its use. Dynamically registered clients `{ clientId, name, redirectUris, registeredAt }` persist to `oauth-clients.json` beside `registry.json` (0600, at most 200, oldest dropped). `registry.ts` gained `writeStateFile`, the shared atomic write.
- Phone, `Bridge`. `connects: [WireConnect]` is the relay's last list, in memory. `declinedConnects: Set<ConnectID>` holds declines until the relay stops listing them. The pending list the UI shows is derived: listed, not declined, not yet an agent with that digest, not expired. Approving goes through `register(name:keyDigest:access:includePhotos:)`, the one path every new agent takes, which Connect Agent now uses too.

Wire additions, all on protocol v1:

1. `SyncResponse.connects: [{ id, clientName, clientHost, redirectHost, code, keyDigest, requestedAt, expiresAt }]` on every response, for every connection still waiting for the phone. `clientHost` is the host of the client's metadata document, or null for a dynamically registered client whose name is its own claim. No raw key, no PKCE values, no state.
2. `SyncBody.connectDeclines?: [id]`. The phone repeats an id until the relay stops listing it.
3. No approve message. Deviation from the brief, which suggested a `connect` outcome for both answers. The phone approves by adding an agent with the connection's `keyDigest` to its registry, and the relay approves every waiting connection whose digest the registry holds. The code can therefore never exist before the relay knows the digest, and a re-sent snapshot converges. Access level and Include Photos never leave the phone.
4. A parked device long-poll ends at once when a connection exists that no response has listed yet (`Mailbox.sync` takes a `ready` predicate; `Mailbox.wake()`). Because the relay does not end a long-poll for a connection it already listed, the phone's loop now starts with one exchange that does not park, so a relaunched app gets the list at once.

Decisions and why:

- Registration accepts both kinds, public clients only. Metadata documents are fetched at `/authorize` with no redirects, a 5 s timeout and a 5 KB limit. With `--dev-callbacks`, http documents on loopback are allowed, for the e2e only.
- The access token is K, an ordinary `ak_` key. It has no expiry and comes with no refresh token. A short-lived token with rotating refresh tokens would need the relay to mint and keep credentials the phone does not know, or the phone online for every refresh. Both break the rule that the phone is the only authority over agents. Removing the agent in Puffer revokes the token through the existing registry path. Accepted risk: a leaked token works until the user removes the agent, as with an `ak_` key.
- The 401 names the path-aware metadata URL (what the SDK helper builds). The same document is served at the root. There is no `/.well-known/openid-configuration`, because the relay is not an OpenID provider.
- Redirect URIs match exactly, except that an http loopback redirect may use any port (RFC 8252, OAuth 2.1 section 8.4.2). Claude Code picks a random callback port.
- The authorization code is minted when the browser page first sees the approval, and lives 60 s from then. A user who approves on the phone and returns to a background browser tab minutes later still gets a usable code, within the 10 minute connection lifetime.
- Rate limits are global per route (30 per minute for `/authorize`, 20 for `/register`, 10 connections waiting at once), because behind a proxy every caller shares one address and forwarded headers can be forged.
- Deviations the relay owner added, each kept: the relay refuses to start when its public base is plain http on a host other than localhost (the SDK's issuer check, and the spec requires https); `redirect_uri` is always required; a repeated parameter is refused; client names lose control and format characters, so bidi overrides cannot disguise a name; the `/mcp` 401 body is now the OAuth error JSON and its challenge no longer says `realm="puffer"`.

U1, discovery and registration. Check: e2e asserts the path-aware and root resource documents, the server metadata (S256, `none`, metadata documents, `iss`), the 401 challenge, the 404 for OpenID discovery, DCR 201 with `none`, refusals for non-loopback http and fragments, and that a registered client survives a restart. `u1-curl.txt` shows the same documents, a registration and the authorize page from a scratch relay.

U2, authorize and token with the phone on the wire. Check: e2e drives a fake phone through the sync endpoint. A parked long-poll returned within 1 s carrying the connection. The page has the code, the escaped client name, a strict CSP and the `puffer://connect/<id>` link. Approval by registry, a wrong verifier (`invalid_grant`, code still usable), the right verifier (Bearer `ak_`, no refresh token, `no-store`), a reused code (`invalid_grant`), decline (`access_denied` with state and iss), expiry (`access_denied`, and a late registry does not approve it), a loopback metadata document, removal (401) and the state files (no key, code, verifier, pairing code or poll token) all pass. The relay owner also planted 8 bugs one at a time (no PKCE check, no escaping, no long-poll wake, no expiry, redirect to an unregistered URI, reusable code, no metadata `client_id` check, declines ignored); the e2e caught each (`round-oauth/mutations/results.txt`). Two of them aborted the run instead of failing a named check, and those two checks were hardened afterwards but not re-planted.

U3, Puffer. The approval screen (`src/app/connect/[id].tsx`, modal) shows the client name, the redirect host, whether the name was verified by a metadata document (orange "The app itself, not verified" otherwise), a warning for loopback redirects, the code in large type, and the access sections. `src/ui/access.tsx` (`AccessSections`) now holds the access picker, collection toggles and Include Photos for both this screen and the agent screen. Pending connections lead Waiting for You on the Agents tab and count in its badge. Outside the foreground a new connection posts a local notification, "<name> wants to connect", with the code; a tap opens `puffer://connect/<id>`. Checks on the simulator: with Safari in front and Puffer in its grace window, the notification arrived with the same code the page showed (`u3-page-and-notification.png`). The page's Open Puffer link opened the approval screen (`u3-approval-screen.png`). Approving at Everything added the agent and removed the row (`u3-after-approve.png`). In the foreground a new connection showed up in the tab at once (`u3-agents-tab-connect-row.png`), and Decline made the page's poll answer `declined` with `access_denied`, the state and iss (`u3-decline-poll.txt`). A deep link to an unknown id shows Checking, then No Longer Waiting.

U4, a real OAuth client end to end. `round-oauth/oauth-client.mts` is an `OAuthClientProvider` on the MCP SDK client with a loopback callback. Against the relay on 8787 it took the resource metadata URL from the 401, registered by DCR, and printed the authorize URL, which the simulator's Safari opened. After approval in Puffer the callback arrived with the matching state and `iss`, `finishAuth` exchanged the code, and the token was an `ak_` key. `ask_puffer` ("When is the vet appointment?") returned `answered` with `mochi-vet.txt`, `approved_by: grant`, and `get_puffer_changes` returned 16 events with `hidden_count: 2` (`u4-client.log`). The relay state held the token's digest and not the token (`u4-state-check.txt`). After Disconnect in Puffer the same token got 401 with the `resource_metadata` challenge (`u4-revoke.log`). The test agent was removed by that step, and the test clients' `oauth-clients.json` was deleted afterwards. Its one question stays in History under "OAuth Check Script", as History keeps disconnected agents' entries.

To try it with Claude Code's own OAuth (not run here): `claude mcp add --transport http puffer-oauth http://localhost:8787/mcp`, then `/mcp` in Claude Code or `claude mcp login puffer-oauth`. Claude Code supports metadata documents, so the relay will fetch Claude Code's https document; that path is untested here.

Not built, or not verified:

- No real ChatGPT or Claude Code connection; both need the relay hosted (ChatGPT) or a user-run command (Claude Code). An https metadata document was never fetched.
- No push: a connection reaches a suspended phone only when Puffer opens or wakes. The page's link and the notification during the grace window cover the common case.
- Tapping the notification was not verified, because injected taps on simulator banners do not land (as in earlier rounds). The route it opens was verified through the page's link.
- Anyone who can reach the relay can put a connection request on the phone (10 at a time, 30 attempts a minute). The pairing code protects the user only against a request they did not start from a page they opened.
- Metadata-document fetches have no private-address check and no cache, the same gap as webhook callbacks.
- A reused authorization code is refused, but the token already issued for it is not revoked (OAuth 2.1 SHOULD); only the phone can revoke.
- An approval whose code is never redeemed leaves an agent in Puffer whose key nobody holds, until the user removes it.
- Pending connections are lost when the relay restarts; the page then says to start again.
- Browser-based clients on another origin are refused by the Origin guard, and `/token` sends no CORS headers.
- On the simulator, Safari kept polling while in the background; on a device a background tab may pause until the user returns, which the code timing above allows for. Not verified on a device.
- Client logos are not shown; nothing fetches them.

### Hardening round: review findings fixed on the relay and the phone (2026-10-07)

Two independent read-only reviews preceded this round: one of the relay's security (`review-relay.md`, 12 findings) and one of the phone side (`review-native.md`, 13 findings). Neither reviewer wrote the code. One owner fixed the findings through two delegates, one for `relay/` and one for `modules/puffer-native/` and `src/`, against a wire contract fixed before either started (`round-hardening/contract.md`). Every finding was fixed; none was disputed. Evidence is in the session scratchpad under `round-hardening/`: `relay/` and `native/` hold the delegates' logs and screenshots, and `owner/` holds the owner's own reruns and simulator checks. `npm run e2e` passes 84 of 84 (69 before), rerun by the owner.

What changes for the user. Puffer no longer pairs with a relay from a link alone. Approving a connecting app now means typing the code its page shows, and Puffer never shows that code. An approval the app never completes no longer leaves a dead agent behind. Every change read an agent makes appears in History. The relay survives the resource attacks the review measured, and its logs no longer carry the device key.

#### Pairing code checked on the relay

The phone never receives the pairing code. The connect page shows it with "Enter this code in Puffer". The approval screen has a 6-digit field, and Approve stays disabled until the field holds 6 digits. Puffer sends the typed code to `POST /v1/device/connects/<id>/confirm` with the device key. The relay compares it in constant time and answers `confirmed`, `wrongCode` with the tries left, `declined` after the third wrong code, or `gone`. Only a `confirmed` connection is approved when the registry gains its digest. A digest that reaches the registry without a confirmed code approves nothing.

The brief allowed two designs. The other was a salted, slow digest of the code sent to the phone and compared there. It was rejected because a 6-digit code has 10^6 values. Any cost the phone can afford per check (PBKDF2 at 100k iterations, about 50 ms) is reversed by one GPU in seconds, well inside the 10-minute connection lifetime. The relay-side check leaves nothing to brute-force, and it keeps the attempt counter where the code lives. The extra round trip costs nothing, because approval only takes effect once the relay hears from the phone anyway.

What typing the code proves. It proves that the person approving sees the page. That stops a request someone started in their own browser, such as an attacker presenting a real vendor's metadata-document client_id with a loopback redirect. It does not stop a page the user opened from someone else's link. For that case the screen still names the client and whether the name is verified.

`clientHost`, which the screen shows as a verified name, is now null whenever this connection's redirect is loopback. The brief asked for "all registered redirects loopback"; judging the redirect the connection actually uses is stricter, since an attacker picks the loopback one. Claude Code connecting through its metadata document would therefore show "The app itself, not verified" (inferred from its loopback callback, not run). That is accurate, because any local program can present its client_id.

Phases on the relay are now `awaitingPhone { key, attemptsLeft } -> confirmed { key } -> approved { key, code } -> ended { redeemed | declined | expired | abandoned }`.

#### Wire changes, protocol still v1

- Added: `POST /v1/device/connects/<id>/confirm`, body `{ v: 1, code: string }`.
- Added: `SyncResponse.revokedKeys: KeyDigest[]`. These are digests of agents the phone should remove: an approved or confirmed connection that was never redeemed (`abandoned`), and a redeemed connection whose authorization code was presented again. The relay lists a digest on every response while the registry holds it, keeps the record 24 h, and refuses that key at `/mcp` at once.
- Removed: `WireConnect.code`. This is the one non-additive change. A phone build from before this round fails to decode a sync response that lists a connection.
- Changed meaning: `WireConnect.clientHost`, as above.

#### Relay (review numbers from `review-relay.md`)

1. `src/egress.ts` now makes every outbound request: event callbacks, the phone-set webhook and metadata documents. It asks for `identity`, fails on any content-encoding, reads at most 4 KB (5 KB for metadata documents), and `deliver()` reads only the status. The review's 400 MB gzip bomb used to push RSS from 48 MB to 1.21 GB. Now it peaks at 91 MB and settles at 48 MB, and a control run with no bomb peaks the same, so the peak is MCP handling (`relay/probe/rss-summary.txt`). e2e asserts RSS growth under 50 MB.
2. The typed code, as above.
3. Limits count per caller: the socket address, or `Fly-Client-IP` only with `PUFFER_TRUST_PROXY=fly`, which `fly.toml` now sets. An IPv6 caller counts by its /64. Each caller gets 3 connections waiting at once (100 in total), 10 `/authorize` per minute counted only after the client and redirect check out, 10 registrations per hour and 20 metadata fetches per minute. Registered clients are evicted by `lastUsedAt`, which is persisted.
4. The relay prints the pairing link only when it is bound to loopback. Otherwise it writes `pairing-link.txt` (0600) beside the state file and deletes it at the first authenticated sync. The README documents `fly ssh console -C "cat /data/pairing-link.txt"`.
5. `headersTimeout` is 10 s, `requestTimeout` 30 s, and unauthenticated bodies have 10 s. Measured on a probe relay: the trickled body closed at 10.0 s (still open after 75 s before), a 25 s device long-poll and a 50 s MCP wait both completed, because Node's `requestTimeout` stops counting once the request has arrived (`relay/probe/timeouts-summary.txt`). 30 s instead of the review's 15 s leaves room for a sync carrying photos on a slow uplink. Each agent parks at most 4 waits; a fifth answers at once with its request_id. `maxSubscriptions` is 16, which the SDK applies to the whole handler, not per agent.
6. An agent holds at most 5 event subscriptions. A URL counts as verified only while it has a live subscription. Agents see one reason, `challenge_failed`, and the relay logs the specific one. Callbacks, webhooks and metadata fetches resolve the host and refuse loopback, private, link-local, CGNAT, unique-local (including Fly's `fdaa::/16`), multicast, unspecified and IPv4-mapped forms, using `net.BlockList`. They then connect to the checked addresses through a custom `lookup`, so DNS cannot change the answer in between. `--dev-callbacks` adds loopback only.
7. Every `/authorize` refusal is now a page, never a 302, so a self-registered redirect cannot turn the relay into an open redirector.
8. `/healthz` answers `{ok:true}` and nothing else.
9. Metadata-document fetches share the address filter, and the page shows one generic error.
10. A wrong method gets 405 with `Allow` on every route, before anything builds a `Request`.
11. Client names also lose line and paragraph separators. Whitespace runs collapse, and combining marks are capped at 2 in a row.
12. HSTS is sent when the public URL is https. The Dockerfile pins `node:24.15.0-bookworm-slim` and runs the relay as `node` through `setpriv`; the image was not built. A replayed code revokes its token through `revokedKeys`. Each agent gets 20 new requests a minute, change reads included. Sync and confirm responses are `no-store`.

Each new e2e check was shown to catch its defect. The relay delegate planted 21 defects, one per copy of the relay, and each copy failed its check (`relay/mutate.sh`, `relay/mutations-*.txt`). Two checks proved weak and were tightened.

#### Phone (review numbers from `review-native.md`)

1. `src/app/pair.tsx` is a confirmation screen. It names the relay host and, when one is paired, the relay it replaces. It pairs only on the tap. Nothing calls `pair()` from an effect.
2. `Bridge.forgetRelay()` runs on unpair and when the link changes (URL or device key). It clears change answers, connections, declines, read cursors, held pages, the notices cache and the confirmed registry revision. Open relay requests settle as expired. Every relay entry is marked reported, so nothing replays to the next relay, and photo bytes waiting to go out are dropped.
3. An agent whose access cannot be resolved gets no head and no page; it no longer makes the phone send `changePages: nil`. Pages always go, so the relay drops a page the phone no longer vouches for.
4. Change answers carry the policy version they were computed under and are dropped if it moved. `edit()` clears them. Triage does not write a phase computed under an older policy and re-runs instead. `notices()` never caches a set from a stale policy or over a newer basis.
5. The change log has a `sourceUri` column, filled on insert and migrated best effort for old rows. Recent Changes, `Triage.readable` and heads find a row's document by it (`DocumentKey`), so an edit that mints new item ids no longer makes the earlier "Added" row look removed. The column never goes on the wire.
6. A shared file is copied under a hidden name in the same folder and then moved into place.
7. Titles, sources, excerpts and agent names are cut by UTF-16 count on character boundaries. An empty agent name becomes "Agent". Webhook URLs and tokens over the relay's limits are refused when saved.
8. The pairing Keychain item is `AfterFirstUnlockThisDeviceOnly`, and the existing item was migrated. Webhook tokens live in the Keychain, one item per agent, and JS sees only whether one is set. `bridge.db` and its WAL files are excluded from backup and get `completeUntilFirstUserAuthentication`; the simulator cannot show that the protection class took effect.
9. A failed `SecRandomCopyBytes` throws.
10. Approval passes the key digest the screen showed and is refused if the listing changed.
11. An Ask Every Time agent gets an empty page with `hidden_count` 0 and an unmoved cursor.
12. A sync response is dropped if the link changed during the exchange. The review marked this plausible; the delegate found it real, because `kick()` syncs are not cancelled when the user pairs again.
13. Deciding a request past its deadline settles it as expired.

G4 items. `revokedKeys` removes agents through the user's revoke path. A change read is a `ChangeRead { id, agentID, agentName, at, outcome }` record in a new `reads` table (newest 200). `outcome` is `answered(shown, hidden)`, `servedFromPage(shown, hidden)` or `rateLimited`. It is recorded when the relay acknowledges the answer, so the ask ledger and its outbox are untouched. History on the Agents tab and on the agent screen shows reads among asks. The phone answers 10 reads per agent per minute and declines the rest, and the relay words that decline as "reads are rate limited, try again in a minute". The Simulate button shows only with `EXPO_PUBLIC_PUFFER_DEV=1`.

#### Owner checks on the simulator, against the new relay on 8787

- `puffer://pair?relay=https://relay.example.invalid&key=dk_...` opened the confirmation, which named localhost:8787 under Replaces. "Don't Pair" left Puffer paired with localhost:8787 (`owner/pair-link-*.png`).
- The SDK OAuth client (`round-oauth/oauth-client.mts`) registered by DCR, and the page showed code 593 062. The notification and the connect row showed no code. The screen read "The app itself, not verified" and Approve stayed disabled until 6 digits were typed. 111111 got "That code does not match. 2 tries left." Then 593062 approved at Ask Every Time. The callback carried the code with matching state and `iss`, and the token was an `ak_` key. `ask_puffer` came back declined after Deny, and `get_puffer_changes` returned no events with `hidden_count: 0` (`owner/oauth-client.log`, `owner/connect-*.png`). After Disconnect the token got 401 (`owner/oauth-revoke-check.log`).
- Unredeemed approval. A hand-built `/authorize` for the same client was approved with its code. The page received the authorization code and redirected to a dead loopback callback, and nobody called `/token`. 60 s later the relay registry still held the agent. 8 s after Puffer came forward, the phone had removed it (`owner/abandon-check.txt`).
- Recent Changes shows the `window-cleaning.txt` "Added" row live, no longer dimmed (`owner/recent-changes.png`, before and after in `native/`).
- History shows "Claude Code, Read 16 changes, 2 more held back" after `ask.mts changes`, and the OAuth client's read (`owner/history-change-read.png`).
- Simulate is hidden. The test request "a printed receipt" was denied and Waiting for You is empty (`owner/receipt-denied.png`). Claude Code stays at Everything.
- The test OAuth clients were deleted from `oauth-clients.json` afterwards, and the relay was restarted with its default config.

#### Not fixed, or not verified

- Lock-screen banners still show agent-written question text and relay-provided client names, and pages for every agent still ride on every sync (both from review native 13). Neither was in the brief.
- Connections and `revokedKeys` records live in relay memory. After a relay restart, an approval that was then still unredeemed leaves an agent whose key nobody holds, as before this round.
- A confirmed connection cannot be declined from the phone. It ends abandoned at its deadline, and `revokedKeys` removes its agent if the phone added one.
- A read the relay serves from a pre-sent page is recorded only when it moves the agent's cursor. A read with nothing new is invisible to the phone. The path was not exercised at runtime.
- The Dockerfile was not built, because no image can be pulled here. A non-loopback bind was not run, because it would open a LAN port; e2e calls the announcement function with `0.0.0.0` instead.
- The 3-wrong-code decline was verified in e2e only; on the simulator one wrong code was tried.
- `npx tsc --noEmit` at the app root still reports errors. The ones under `design/` were there before this round. Three under `relay/` are new: the app's tsconfig type-checks relay files against DOM types, so node `URL` and DOM `URL` disagree. The relay's own `npm run typecheck` is clean.

### HTTP API round: the agent operations over plain HTTP (2026-10-07)

Agents that cannot speak MCP can now reach Puffer with JSON over HTTP and the same `ak_` key. Their calls land in the same mailbox, count against the same per-agent limits and get the same words as MCP calls. The phone still decides every answer, and History lists HTTP asks and reads like MCP ones. Evidence is in the session scratchpad under `round-http/`. `npm run e2e` passes 94 of 94 (84 before).

- Shape. `relay/src/operations.ts` holds `operations(mailbox, openUrl)` with `ask`, `answer` and `changes`, each resolving to a `Reply` (`result { structured, message, images }` or `refused { reason, message }`), plus `render` and the tool descriptions, moved unchanged from `mcp.ts`. `mcp.ts` and the new `http.ts` only change the envelope. MCP wire output is byte-identical to the pre-round tree (`golden.mts`, `golden-before.json`, `golden-after.json`).
- Endpoints. `POST /v1/ask` `{question, broaden?, wait?, include_images?}`, `GET /v1/answers/<request_id>?wait=&include_images=`, `GET /v1/changes?since=&limit=&wait=`, and `GET /openapi.json` (no key, OpenAPI 3.1, operationIds equal the MCP tool names so the answer texts stay true, server is the public base plus `/v1`). One table, `ENDPOINTS` in `http.ts`, drives routing, the method check and the document.
- Decisions. `wait` defaults to 25 s (the brief's premise that many HTTP tool callers stop near 30 s, not checked), takes 0 to 50 and never exceeds `--wait-ms`. Every outcome status is 200. An unknown or foreign id is 200 `expired`, as over MCP. `rate_limited` is 429 with `Retry-After: 60`; `too_many_open_requests` is 429 without it. The 401 carries the `/mcp` challenge. The key is read only from the `Authorization` header. Approved photo bytes are opt-in (`include_images`); by default `images_omitted` counts them, because one photo measured 110 KB of base64. Errors are `{error, message}` with `no-store`, including the Host and Origin guard (except `/mcp`, which keeps its JSON-RPC body), 404, 405 and 500. No CORS.
- Fixed in passing. A body over a route's cap crashed the relay: `for await` destroyed the request on overflow, `req.socket` became null and the error handler dereferenced it. One unauthenticated 70 KB POST to `/register` stopped the pre-round relay. `readBody` now uses `req.iterator({ destroyOnReturn: false })` and body errors answer with `Connection: close`. An e2e check covers it.
- Checks. 10 new and 4 extended e2e assertions; 19 planted defects were each caught, and a twentieth turned out to change no behavior (`mutations*.txt`). An independent reviewer found no high-severity issue; its two medium findings (nullable `text` and `excerpt` in the schema, photo bytes inline by default) and the low ones were fixed. Live on 8787: `POST /v1/ask` "When is the vet appointment?" answered in 0.38 s, identical to MCP `get_puffer_answer` for the same id; a `broaden` ask returned `waiting_for_user` after 25.0 s, and a long poll returned `answered`, `approved_by: user`, right after Approve on the simulator. Connect Agent shows the HTTP API and OpenAPI URLs with Copy OpenAPI URL and Copy Key (JS only, no native change); a key copied there worked over HTTP and got 401 after Disconnect.
- Not verified. No real non-MCP agent connected; whether a given platform imports OpenAPI or sends an `Authorization` header is unknown. No OpenAPI validator or importer ran. The 401 names the `/mcp` resource metadata, which a strict RFC 9728 client could reject for `/v1`. HTTP agents cannot subscribe to MCP Events; they poll `/v1/changes` or use the Notify webhook set in Puffer. A multi-megabyte body over a kept-alive Node client gets EPIPE instead of the 413 (curl reads the 413).

**Search round (2026-10-07).** Query prompt measured, not switched: on 30 labeled needs in two phrasings, `task: question answering` moved scores at most 0.02 either way and full questions overlapped under every prompt (text answers 0.651 vs no-answer 0.653, photos 0.636 vs 0.654), while short descriptions separate (text 0.705 vs 0.619, photos 0.700 vs 0.658), so search keeps `task: search result` and the 0.68 floor, and agents expand questions into short queries.
Metadata: one `ItemMetadata` per item (Metadata.swift: file name, folder, source, type, dates, size, PDF attributes; photo taken date, subtypes, favorite, albums, size, camera, location kept on the phone only), keyword-indexed, backfilled on catch-up, passages re-embedded once under `title: {folder}/{file}`; asks take optional `filters {kind, after, before, source}` passed through the relay untouched, and shared items carry date, folder, file_type and albums, never location.

**QR approval round (2026-10-07).** OAuth sign-ins now approve like connect by message: every pending connection has a link secret and an approve URL `/c/<secret>`, the `/authorize` page shows it as a server-rendered inline SVG QR code (`qrcode`) with an Open in Puffer link, and the phone confirms with `{"v":1,"link":"<secret>"}`, so the 6-digit pairing code, its entry field, the connect notification and `Route.connect` are gone.
The relay still lists every waiting connection on each sync, because the phone needs the record when a link opens it, and the phone shows none until opened through its link; three wrong secrets still decline (the reply keeps its `wrongCode` wire name), and expiry, per-caller limits, PKCE and `revokedKeys` are unchanged.

**Connect callback round (2026-10-07).** `POST /v1/connect` takes an optional `callback_url` (https, the notify egress policy, loopback only with `--dev-callbacks`), stored on the link connection and cleared when sent, so `announce()` in oauth.ts POSTs `{"event": "connect.approved" | "connect.declined" | "connect.expired", "connect_id", "timestamp"}` at most once when the phase reaches approved, declined, or expired/abandoned, through notify.ts's `deliverEvent` (5 attempts on transient failures) and signed Standard Webhooks style with the poll token's UTF-8 bytes as the HMAC key.
The body never holds the key; on `connect.approved` the agent collects it at the unchanged token endpoint, a failed callback changes nothing, expiry is noticed by the 30 s sweep, and `/start` and the README describe it. Verified by typecheck only.

**OAuth sessions round (2026-10-09).** OAuth clients get spec-style sessions (`relay/src/sessions.ts`): `/token` answers with a stateless HMAC-signed `at_` access token (1 h, tenant + agent digest + expiry, key in `oauth-session-key.json`) and an opaque `rt_` refresh token that rotates on every use, slides 90 days, and revokes its session on reuse (the last-replaced token may be repeated within 60 s for the same reply), persisted as digests in `oauth-sessions.json`; the connection's `ak_` key stays the agent's identity by digest but never leaves the relay.
`oauth.claim` is the one credential check behind `/mcp` and `/v1` (ak_ by digest, at_ by signed claim, then the registry and revocations); a revoked or expired session lands in `revokedKeys` so the phone removes its agent, existing `ak_` keys and connect-by-message keys keep working without expiry, and only `npm run typecheck` verified it.
