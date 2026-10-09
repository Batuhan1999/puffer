# Synthesis: agent bridge and system access

Architect Phase B result. The contract for implementation is `a/DESIGN.md` plus `a/sketch/**`, amended by this file. Where they disagree, this file wins.

## Pick

| | a | b | c |
|---|---|---|---|
| Interface depth | 5 | 3 | 3 |
| Invariants in structure | 4 | 2 | 4 |
| Honest availability | 5 | 4 | 4 |
| Buildability here | 4 | 4 | 3 |
| Agent fit | 4 | 3 | 4 |
| Parsimony | 4 | 3 | 2 |
| Total | 26 | 19 | 20 |

Runners: a (Opus, second attempt; the first stalled and wrote nothing), b (Fable), c (Sonnet). Cross-judge: Fable. The parent's own read picked a before seeing the judge's scores.

**Base: a.** Two actors (`Engine` for items and search, `Bridge` for policy, ledger and relay sync) behind a seven-call app-target facade with `internal` vector types. The ledger phase is a state machine and the outbox is derived (`phase != reported`), so there is no second table to keep in step. One idempotent `sync` long-poll serves every wake: foreground, background grace, background refresh and a Shortcuts-automation intent. Consent membership uses fixed canonical search options, not UI prefs, which fixes a defect in today's code. Review shows candidates frozen at triage.

**Convergence.** All three put search and durable state in one native Swift engine, mint agent keys on the phone with only digests on the relay, keep the relay a data-free mailbox, decide consent on the phone, and put App Intents in the app target through a config plugin. That shape ships.

**Rejected.** b: JS owns the socket so approved content passes through JS, `Disclosure` puts item ids (which embed photo asset ids) on the wire, and the relay ledger stores decided outcomes with snippets and images durably. c: two pods with `EmbedRuntime` exposed across them, vectors still cross JS at `addItem(vec)`, P-256 device signing for a loopback relay, two Spotlight paths.

## Amendments to a (grafts and corrections)

1. **Unforgeable egress (from c).** `SharedItem` is constructible only inside `Egress`. `Egress.materialize` accepts only an `Approval`, whose initializer is `fileprivate` to the consent file. An `Approval` comes from `Triage` (grant-covered) or from `Bridge.decide` (user-approved).
2. **Reject, do not drop (from b).** `Bridge.decide` throws `notOffered` when any chosen id is outside the frozen candidates. No silent filtering.
3. **What you see is what leaves (from b).** Each frozen `Candidate` stores the exact outbound excerpt. The review screen renders that excerpt and `SharedItem.text` is that excerpt, byte for byte.
4. **Retry re-attaches (from b).** The relay dedupes an identical undecided question from the same agent within a window, so a timed-out retry re-attaches to the open request instead of prompting the user twice.
5. **Photos withheld is visible (from c).** Grant-covered answers carry `photosWithheld: n`. `ask_puffer` takes an optional `broaden: true`, which always routes to user review over the whole index.
6. **Rate limit (from c).** Per-agent cap on grant-covered auto answers per minute, beside a's open-request cap. Past the cap, requests go to review.
7. **Canonical options.** `SearchOptions.canonical` is hybrid at 768 dimensions with rerank off (rerank at 768d is a no-op when the scan is already 768d).
8. **App-target files.** The config plugin copies `app-target/*.swift` into `ios/<App>/` in `withDangerousMod`, then links them with `IOSConfig.XcodeUtils.addBuildSourceFileToGroup` (verified exported; it resolves groups by path inside the project, so in-place references to `../modules/...` are not used).
9. **Deployment target.** iOS 18.0. Any App Intents API newer than iOS 18 needs an availability guard.
10. **Disclosure in the design.** An `awaitingUser` status tells an agent that something matched outside its grants. Accepted and stated in the tool description.
11. **Timeouts are belief.** The three runners disagree on Claude Code's MCP tool timeouts. Read the current Claude Code MCP docs before fixing the relay's wait budget; until then use 50 s and return `waiting_for_user` with a request id.
12. **Spike scope.** Spotlight continuation forwarding is verified (`ExpoAppDelegateSubscriberManager.swift:282`) and the expo-sqlite path is verified (`Documents/SQLite/puffer.db`). The spike checks only intent hosting (app target via plugin) and whether `BGAppRefreshTask` registers on the simulator build.

## Amendments from the user (2026-10-07)

The user asked for "auto access to all files and documents" in Puffer and for agents to read without confirming every time. Product decisions, they win over earlier amendments where they conflict:

13. **Sources sync themselves.** Indexing is automatic, not a button. The photo library is indexed incrementally whenever the app runs (a `PHPhotoLibraryChangeObserver` plus a catch-up pass on launch and foreground) and in background refresh when iOS grants time. Granted folders are rescanned the same way. Onboarding asks once for full photo access and suggests granting the top level of iCloud Drive and On My iPhone (and any other file provider the user uses), so everything inside is covered. Manual "Index"/"Rescan" actions stay as a fallback, not the main path. Indexing is idempotent per item (existing ids skipped), so overlapping runs are safe.
14. **Agent access levels.** Each agent has one level, stored by `Bridge`: `askEveryTime` (default), `collections(Set<CollectionID>)`, `everything`. Separately, `includePhotos: Bool` (default false). `Triage` auto-shares when every offered candidate is covered by the level: for `everything`, all text passages are covered; photos are covered only when `includePhotos` is true (this replaces amendment 5's "photos are never auto" for agents where the user switched it on). Rate limit (amendment 6) still applies, and History records every automatic share. The Agents UI shows the level as a native picker with a plain warning for `everything` and for photos. Existing grants map to `collections`.

## Delivery order (from a, each unit ends in a check)

1. Spike: app-target intent via plugin shows "Search Puffer" in the Shortcuts app; background refresh registers.
2. `Engine` port and parity: in-app dev parity harness, 30 queries across modes and dims, top-10 ids and order match the JS `search()`; then delete `src/puffer.ts` and `src/library.ts`.
3. `Bridge` policy and ledger: collections, agents, grants, ledger in Swift; collection membership no longer changes with UI search mode.
4. Relay, sync and MCP: `relay/scripts/e2e.ts` passes against a fake phone, then against the simulator app.
5. Background: ask while suspended returns `phone_offline`; running the Shortcuts intent answers it.
6. Siri, Shortcuts and Spotlight: Shortcuts run of "Search Puffer"; a Spotlight query finds an item and opens it.
