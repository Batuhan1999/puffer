# Arena synthesis: Puffer product UI

Runners: a (Opus), b (Fable), c (Sonnet), all from `design/BRIEF.md`. Cross-judge: Fable. Rubric: native fidelity, product clarity, search experience, library and sources, agent bridge, code fit.

## Scores

| Criterion | a | b | c |
|---|---|---|---|
| Native fidelity | 4 | 3 | 4 |
| Product clarity | 5 | 4 | 4 |
| Search experience | 4 | 5 | 4 |
| Library and sources | 5 | 4 | 3 |
| Agent bridge | 5 | 3 | 4 |
| Code fit | 3 | 4 | 5 |
| Total | 26 | 23 | 24 |

The judge and the parent agreed on the base and on the root cause of a's crash.

## Convergence

All three chose the same shape: native tabs with the iOS 26 search-role tab, a library tab, an agents tab with a pending badge, engine knobs in settings, collections as saved searches, and agent requests that run a real local search and show exactly what would be shared. That shape ships.

## Base: a

a is the base because it encodes the product invariants in one typed reducer (`preview.tsx`: removing a collection cascades out of every agent's allow list, request status is a discriminated union), keeps jobs visible across tabs through the native tab bar's bottom accessory, mounts item screens per tab so Back returns to the originating list, and has the most complete agent surface (per-agent collection access, per-item share choices with photos off by default, history). c is smaller mostly because it has fewer features.

## Runtime evidence (iOS 26.3 simulator)

- a: library and collections render; opening a collection with photos crashed. Cause: `ItemMenu` wraps `<Link.Menu>` in its own component, and Expo Router's `isLinkWithPreview` only checks direct children for `Link.Menu`, so the link falls back to `asChild` with two children.
- b: launch showed "Unmatched Route" (no index route); the request screen's bottom Approve/Deny toolbar sat hidden under the native tab bar.
- c: no runtime errors seen.

## Grafts

- From b: `buildRows` interleaving, so the "All" scope is one relevance-ordered list where runs of photos pack into grid rows and passages stay full width. Replaces a's Top Hit plus Photos plus Documents split, which buried documents under photos.
- From b: "Try asking" suggestions grouped by use case.
- From c: a "Recently added" section in Library.
- From c: the clearer approval label, "Approve and share N snippets".

## Drops from a

- The `ItemMenu` wrapper (the crash); menus become inline `Link.Menu` elements.
- `splitByStrength` and "Show N weaker matches": the shared engine now applies a relative relevance cutoff, so a second uncalibrated margin is redundant.
- `withAppleZoom` without a zoom target, until it is verified on device.
- `frame({ maxWidth: 10000 })` as a stand-in for full width.
- The tinted caption color in navigation rows.
- One of the two duplicate notice surfaces (auto-dismissing info notice vs bottom accessory notice).

## Rejected

- b's bottom toolbar for Approve/Deny (hidden under the tab bar); a's modal with header actions stays.
- c's Settings tab (four tabs); settings stay a modal from the library toolbar.
