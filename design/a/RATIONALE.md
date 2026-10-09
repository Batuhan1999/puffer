# Puffer, candidate a

**Thesis.** Puffer is a memory you ask, plus a gate you control. Search is the front door. Library shows what the memory holds and where it came from. Agents shows who may ask it and what would leave. Every screen answers one of three questions: what can I find, what does Puffer know, what leaves this iPhone.

**Information architecture.** A root Stack holds the tabs and three modals (Settings, Collection editor, Request review). Native tabs:
- Library (`square.stack`). Model status while not ready, Collections, Everything (Photos grid, Documents by source and file), Recently Added (the last five things Puffer read, one row per document), and Sources (Photo Library, folders, files). The `+` menu and the Settings gear live in the nav bar.
- Agents (`person.2.badge.key`, badge = pending requests). A "Preview" banner, Waiting for You, Agents (per-agent collection access), How It Would Work, History.
- Search (`role="search"`). `Stack.SearchBar` puts the field at the bottom on iOS 26. With no query it shows Recent and example questions grouped by use case, plus a note about searching across languages. With a query it shows a segmented All/Photos/Documents picker over one list in the engine's relevance order: runs of photos pack into 3-column rows and passages stay full width.
- Item and Similar screens mount in every tab's stack (re-export route files), so a result opens in place and Back returns to the same list.
- Onboarding runs only when the model is missing at launch. One page explains the product, the second shows download progress and source choices. "Continue" works before the download finishes; progress then moves to the tab bar's bottom accessory.

**Native components per surface.** NativeTabs with a BottomAccessory for download, indexing and "Indexed N" notices, with a Stop button where the job can be cancelled. `Stack.Toolbar` Button and Menu for nav-bar actions. SwiftUI `List`/`Section`/`LabeledContent`/`Toggle`/`Picker`/`DisclosureGroup`/`ConfirmationDialog`/`ContentUnavailableView`/`TextField` for every list, form and empty state. `expo-image` grids for photos. `Link.Preview` lets you peek at a passage. `Link.Menu` offers Find Similar, Share Text and "Not in This Collection". RN `Share` and `Alert` cover the share sheet and errors.

**Product decisions.**
- Collections are saved descriptions, not folders: "Receipts" means "a receipt, invoice or bill". Members are whatever the index ranks, minus items the user removes. They need no new API, and they become the unit of agent pre-approval.
- Agent requests run a real local search on the question, so the review shows the user's actual items. Passages in the top 3 are offered by default, photos never are. The approve button names what leaves ("Approve and Share 2 Snippets"). Approving records history and states that nothing was sent.
- Pre-approval covers text snippets only. Photos always wait for approval, which is stricter than the brief allows.
- Engine details (mode, dimension, re-rank, model load time, last-search timings, index bytes) live in Settings > Search Engine. Main screens show no numbers about the engine.

**Rejected.**
- Search as the home tab. iOS 26 always places the search role tab at the trailing edge, and a first-run user needs Library's sources more than an empty field.
- A Collections tab. It would split browsing from sources. Collections are a section of Library.
- A bottom toolbar for Approve/Deny. A modal with Deny on the left and a prominent Share on the right matches iOS confirmation sheets and avoids toolbar-over-tab-bar layout.
- Similarity scores or "match %" in results. Ranking is shown, numbers are not. The engine's relative cutoff decides what counts as a match, so the UI adds no second threshold.
- Full-resolution photos in detail. Reading the original needs media-library calls outside the `@/store` contract, so detail shows the 256px thumbnail and says the original stays in Photos.

**Not verified (no simulator run; tsc and lint only).**
- Whether a SwiftUI `List` inside `Host` drives large-title collapse.
- Whether adding and removing the BottomAccessory at runtime animates cleanly.
- Toggle rows with custom `ItemLabel` children. Spacers as the full-width stretch on welcome buttons. The `palette` Picker with SF Symbol `Image` children.
- Long-press menus on tiles and passage rows inside a `FlatList`.
- Collections, agents, requests and search prefs live in memory and reset on relaunch.
