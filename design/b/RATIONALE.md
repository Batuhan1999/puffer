# Candidate b: a memory you can ask

## Thesis
Puffer is not a search box bolted onto a photo grid. It is a private memory with three verbs: feed it, ask it, and decide who else may ask it. The tab bar says exactly that: Memory, Agents, Search. The search tab uses the iOS 26 search role so the query field sits where the system puts it, and the first run is a single screen that explains the three promises (photos and documents together, describe instead of name, nothing leaves the phone) before asking for the 390 MB download.

## Information architecture
- Root `Stack`: `(tabs)` plus a `settings` modal (gear in the Memory header). Engine knobs (mode, vector detail, re-rank, last-search timings, backend) live only there.
- `memory/`: first-run onboarding while the model is absent, downloading, loading or failed. Once ready, a SwiftUI `List`: running job with progress and Stop, counts, "Browse everything" (full grid with a segmented filter), add actions (photo library, documents, folder), folder list with rescan, privacy section.
- `search/`: `Stack.SearchBar` with integrated placement. Empty query shows recent queries and "Try asking" suggestions grouped by use case (money and paperwork, travel and documents, things photographed). A query shows one relevance-ordered list where runs of photos pack into 3-up grid rows and passages stay full-width rows with a snippet. Segmented All / Photos / Documents filter in the list header.
- `item/[id]` exists in all three tab stacks (one shared `ItemScreen`) so a push never switches tabs. The screen shows the photo or passage text, source and age, then "More like this" using the item itself as the query.
- `agents/`: labelled preview. Pending requests (badge on the tab), connected-agent toggles, pre-approved collections, history, and a plain list of what can and cannot leave the phone. A request screen runs the real on-device search for the agent's question and shows exactly which photos and snippets would go out, with Deny and "Approve and send" in a native bottom toolbar. A collection screen has per-agent pre-approval toggles and the collection's real contents.

## Data shapes
- `prefs.tsx`: `SearchOptions` plus recent queries and the last `Timings`, one context.
- `agents.tsx`: a reducer over `{agents, collections, requests}`; a request is a small state machine `pending -> approved | denied` with the shared counts recorded on approval. Collections are saved queries with an `AgentId[]` allow list.
- `ItemGrid.tsx`: `buildRows(items, filter)` turns a relevance-ordered item list into `photos | passage` rows, so search, library, detail and collection screens share one list.

## Alternatives rejected
- A single-screen app with search on top. Rejected because onboarding, indexing and the agent bridge each need room, and the brief asks for a product, not a feature demo.
- Mixed SwiftUI `List` and RN grid on one scrolling Memory screen. Rejected because a `List` inside a `ScrollView` has no reliable intrinsic height; the grid got its own "Browse everything" screen instead.
- Timings and result scores on the results list. Rejected per brief; they live in Settings under "Last search".
- Editable collections and per-item deselection inside a request. Deferred; there is no API, and the approval flow is the thing to test first.

## Not verified (no simulator run allowed)
- `Stack.SearchBar` with `placement="integrated"` inside a `role="search"` native tab, and `ref.setText` filling the field when a suggestion is tapped.
- `Host matchContents` sizing for a segmented `Picker` and for a `VStack` of `Toggle`s used as a `FlatList` header.
- `Button` with `buttonStyle('plain')` and custom children as a navigation row inside a `List`, and `ContentUnavailableView` inside a `Section`.
- `Stack.Toolbar placement="bottom"` on a pushed screen under native tabs on iOS 26, and `Text date dateStyle="relative"` output.
- Whether `Item.id` values are URL-safe; they are passed through `encodeURIComponent` and looked up by equality.
