# Editor decision: native vs Tiptap vs patched enriched

Status: recommendation, written before any of the three candidates besides native has run on a simulator or device.
Notes are Markdown on disk; the choice is which editor reads and writes it (`EXPO_PUBLIC_PUFFER_EDITOR=native|tiptap|enriched`).

## Recommendation

Keep **native** (Swift `UITextView`, `modules/puffer-native/ios/Editor/`) as the shipping editor. Keep **Tiptap** as the one fallback worth finishing, and only if native editing proves too costly to maintain. Do **not** pursue enriched: 22% of the test documents change content through its Markdown conversion alone, and closing that gap means patching a Software Mansion library in five areas it has no concept of (tables, nesting, colors beyond the patch, folding, document-level merge). Details below.

## Comparison

| | Native (Swift) | Tiptap (DOM component) | Enriched, patched |
|---|---|---|---|
| Format fidelity (5025 docs, 3000 random + 2000 fuzz + 25 hand-made) | Reference: `NoteDocument.swift` defines the format | All 5025 pass Markdown -> Tiptap schema -> Markdown (1 of them has an orphan list indent moved up a level, an accepted change). Byte equality with native not yet checked (needs the Swift binary on a Mac) | 2424 exact (48.2%), 1489 differ only cosmetically (trailing newline, `*` written as `-`, implicit title kept without `#`), **1112 change content (22.1%)**, 0 throw. Seed 1; seed 2 gave 1079 (21.5%) |
| Tables, nested lists, nested checklists | Yes | Yes (schema extensions) | No: nesting flattened (`* a / * b / * c` -> three top-level items), tables stay as pipe text |
| Colored highlights (5) | Yes | Yes | Patched (`HighlightStyle.mm`, 11 files in `patches/`), device-unverified |
| Quoted lists/headings (`> - [ ] x`, `> ## h`) | Yes | Yes | No: markers get escaped (`\-`, `\##`) |
| Inline attachments | Yes | Yes | `<img>` via `ImageStyle` exists; non-images become links |
| Folding headings | Editor-only, doable in TextKit | Doable (decorations) | Not present; would be a layout-manager patch |
| Apple Notes feel (selection, caret, loupe, keyboard, scroll) | Real `UITextView`: exact | `contenteditable` in a `WKWebView`: close, never identical (selection handles, keyboard accessory, scroll bounce and rubber-banding behave differently) | Real `UITextView` underneath: close to native |
| Dark mode | `PlatformColor`/trait collection | CSS tokens, must be wired and kept in sync | Colors passed as props; highlight uses system colors at 0.3 alpha |
| Large notes | TextKit, scales; native merge exists | Whole document in a WebView, JS bridge per save; unmeasured | One attributed string, HTML regenerated per change; unmeasured |
| Maintenance | ~3600 lines Swift we own, no upstream | TS in `src/ui/editor/` (Markdown port, schema extensions) plus Tiptap upgrades | Fork-by-patch of a 1.x library: every upgrade re-applies 11+ files of Objective-C++ |
| Verified | Simulator, earlier rounds (the latest Swift changes are unverified) | No | No |

PencilKit drawings, document scan and pickers stay native in every option; this decision does not touch them.

## Measurement (what the numbers mean)

`scripts/editor-markdown-check/enriched.mjs` runs each document Markdown -> HTML -> Markdown through `src/ui/editor-enriched/markdown.ts` and compares it with `normalize` from `src/ui/editor/markdown.ts`.
- 5025 documents (SEED=1): 2424 exact, 2601 differ, 0 throw. Of the 2601, 1489 are cosmetic; 1112 lose or change content.
- Content changes per feature present in the source (a document counts under each of its features): quotes 619/1128 (55%), nested lists 368/838 (44%), underline 452/1470 (31%), checklists 392/1303 (30%), colored highlights 385/1271 (30%), links 355/1112 (32%), attachments 276/927 (30%), tables 175/798 (22%), headings 946/4019 (24%), plain text only 3/116. The feature tags are regex heuristics and overlap, so read them as where losses concentrate, not as causes. Several are bugs in this spike's converter, not the library (for example single `~c~` becoming `~~c~~`) and could be fixed in a day; nesting, tables and quoted blocks cannot be, because the HTML dialect has no way to say them.
- **Limit:** Node measures only the JS conversion. On device `EnrichedTextInput` parses the HTML into attributed text and writes HTML back, which can normalize it further, so device numbers can only be worse. `RoundTrip.tsx` (route `/notes/enriched/roundtrip`) measures that on real notes; it has not been run.
- Tiptap's result (all pass, 1 indent moved up) is the same corpus through its schema in Node; it does not exercise the WebView.

## Patch cost for enriched (my estimate from reading `ios/`, not measured)

Person-days include a simulator test pass; risk is the chance the result feels wrong or breaks on an upgrade.

| Feature | Where | Days | Risk |
|---|---|---|---|
| Multi-color highlights | Done: `HighlightStyle.mm`, `HtmlParser.mm`, `StyleUtils.mm` conflict maps | 1-2 more (device checks, typing attributes, copy/paste) | Low-medium |
| Checklists | Exist: `CheckboxListStyle.mm`; only conversion gaps remain | 1 | Low |
| Inline attachments/images | `ImageStyle.mm`, `ImageAttachment.mm`; needs `.drawing`/PDF/scan chips and tap handling | 3-5 | Medium |
| Nested lists, incl. nested checklists | List level is one `NSTextList` with fixed indent (`UnorderedListStyle.mm`, `OrderedListStyle.mm`, `CheckboxListStyle.mm`, markers drawn in `LayoutManagerExtension.mm`, numbering in `TextListsUtils.mm`); needs a depth attribute, Tab/Shift-Tab and Return/Backspace handling in `EnrichedTextInputView.mm`, nested `<ul>` in `HtmlParser.mm` both ways, per-level numbering | 8-12 | High |
| Tables | No concept at all; needs `NSTextAttachment`/custom layout, cell editing, serializer, parser | 15-25 | Very high; effectively a new editor component |
| Foldable headings | Hide ranges via layout manager and keep selection/undo coherent; lives in `LayoutManagerExtension.mm` and `EnrichedTextInputView.mm` | 5-8 | High |
| Quoted lists/headings | Block quote and lists are exclusive in `StyleUtils.mm` conflict maps | 3-5 | Medium |

Rough total for fidelity close to native: **35-55 person-days** plus ongoing re-basing, to reproduce what the native editor already does. Not worth it unless Android becomes a goal (the library supports it; our format and Swift editor do not).

## Upstream status

- Package `react-native-enriched-html` 1.1.1 (`software-mansion/react-native-enriched-html`). `npm view`: 1.0.0 on 2026-06-16, 1.0.1 07-13, 1.1.0 07-30, 1.1.1 08-14, nightly 1.2.0 builds through 2026-10-06. Active, roughly a release every 2-4 weeks.
- Not checked: GitHub issues and open pull requests for tables, highlights and nested lists. This session cannot reach that repository through the GitHub API, so I cannot say whether upstream has any of them in flight. The package README and iOS sources contain no table or nesting support, and I found no CHANGELOG file in the installed package. Check upstream issues before spending any patch time.
- Our existing patch (`patches/react-native-enriched-html+1.1.1.patch`, 11 files, highlight only) would have to be re-based on every upgrade.

## Not verified

- Tiptap and enriched have never run on a simulator or device; no feel, scroll, keyboard, dark-mode, performance or memory claim above for them is measured.
- Byte equality between Tiptap's `markdown.ts` and the Swift parser: only checked on a Mac.
- Large-note behavior for all three.
- Native merge (`NoteDocument.swift`) exists only in the native editor; Tiptap and enriched save whole documents and enriched currently saves as a copy.

## What to check on the Mac

1. `scripts/editor-markdown-check/run.sh` with the Swift binary: confirms Tiptap's 5025-document byte equality with native (decides whether Tiptap can be the fallback).
2. Run `/notes/enriched/roundtrip` on the simulator over real notes: device-side number to set against 22.1%. If it is far above, enriched is closed.
3. Same 300+ line note with 20 images in native and Tiptap: typing latency, scroll, memory (Instruments), cold open time.
4. Selection loupe, keyboard accessory, rubber-band scroll, dark mode in Tiptap next to native, side by side.
5. Upstream issues for tables/nesting in `react-native-enriched-html` (needs network access to GitHub).
