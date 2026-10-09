# Candidate c: "Ask, then decide who else can"

## Thesis
Puffer is a search box first and a settings app never. Search is the default tab, in the native
tab bar's detached search slot. Setup is one modal checklist (model, then what to remember), shown
once on first launch. The agent bridge is an honest preview tab where the user's decision, not the
agent's request, is the product.

## Information architecture
- Tabs (NativeTabs): Library, Agents (badge = waiting requests), Settings, Search (role `search`, opens first).
- Search: native search bar, suggestion rows, segmented scope (All/Photos/Documents), one ranked
  list mixing photos and passages. Tap opens an item sheet; "Find similar" pushes More like this.
- Library: counts, collections (saved searches, local only), recently added, granted folders,
  `+` toolbar menu. Sub-screens: photo grid, documents grouped by folder, collection results.
- Agents (preview): labeled concept banner, simulated requests, per-agent pre-approved collections.
  Request detail runs a real search for the question and lists exactly what would be shared,
  per-item toggles, photos off by default, Approve or Deny.
- Settings: privacy summary, Search settings (mode, vector size, re-rank, last timings), model
  status, Clear index behind a confirmation dialog.
- Root modals: setup, item formSheet, similar.

## Considered and rejected
- Home feed of auto-generated "memories": a feature demo with no query intent, and needs a captioner we lack.
- Agents inside Settings: hides the one genuinely new idea, and the approval badge needs a tab.
- Engine controls (dim, mode) in a filter sheet on Search: power-user noise on the main screen.
- Photo-only grid as the Library root: wastes the documents half of the product.
- Onboarding carousel: a checklist that does the work beats slides that explain it.

## Not verified (nothing was run, per the brief)
- Everything below typechecks and lints but was never rendered.
- `Image uiImage={thumbUri}` loads file URLs synchronously in Swift; 60 rows may hitch.
- Tab `role="search"` with `Stack.SearchBar placement="automatic"` and `unstable_settings.initialRouteName`
  landing on the search tab at launch.
- `router.replace` from the item formSheet to a pushed screen: transition may look odd.
- `Stack.SearchBar` ref `setText` firing no `onChangeText`; I set state directly for suggestions.
- SwiftUI `List` inside `Host` under a large-title header does not collapse the title on scroll.
- `onTapGesture` rows lack the native row highlight.
- Toggle with two `Text` children rendering title and subtitle as documented.
- Collections and agent data are in-memory, seeded, and reset on relaunch.
