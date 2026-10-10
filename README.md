# Puffer

**Apple Notes, but your AI agents can use it.**

Apple Notes is the best note-taking app there is, but iOS gives other apps no way into it: no API, nothing an agent can
read or write. So I rebuilt it. Puffer is an Apple Notes clone for iPhone that Claude and other agents can search, read and
write, with every change they make visible on the phone.

<p align="center">
  <img src="screenshots/notes.png" width="220" alt="Folders and notes, as in Apple Notes" />
  <img src="screenshots/note.png" width="220" alt="A note with a checklist, a table and a highlight" />
  <img src="screenshots/agents.png" width="220" alt="Connected agents" />
  <img src="screenshots/history.png" width="220" alt="What each agent read and wrote" />
</p>

## What it does

- **Feels like Apple Notes.** Folders, pinned notes, checklists, tables, colored highlights, headings you can fold, links
  between notes, #tags, photos, scans and drawings, lined and grid paper, light and dark.
- **Brings your notes over.** A Shortcut imports your existing Apple Notes, and files shared to Puffer become notes.
- **Agents can work with it.** Claude Code (over MCP) or anything that speaks HTTP can search, read, create and edit
  notes. You approve an agent once; after that, History shows everything it read and wrote.
- **Search runs on the phone.** Notes are indexed on the device with EmbeddingGemma 2, so search works offline and the
  index never leaves the phone.
- **Works while the phone sleeps.** Agent writes made while the phone is offline wait on the relay and are merged with
  your own edits when it comes back.

## How it works

```
Claude / agent  ──MCP or HTTP──▶  relay (Node, hosted)  ◀──sync──  iPhone app (notes + search on device)
```

The phone holds the notes. The relay is a small mailbox in the middle: agents leave requests there, the phone picks them
up, runs them against its own notes and sends the answer back. Accounts on the relay use Better Auth.

## Built with

Expo (React Native) with native SwiftUI and UIKit screens · a Swift note editor on TextKit · SQLite · EmbeddingGemma 2 on
LiteRT-LM for on-device search · Node + TypeScript relay with the Model Context Protocol, OAuth 2.1 and Better Auth ·
Fly.io.

## Development

- App: `npm install`, `scripts/fetch-litert.sh`, `npx expo run:ios` (Xcode, Node 24). The editor is native by default;
  `EXPO_PUBLIC_PUFFER_EDITOR=tiptap` or `enriched` selects the alternatives (see `design/EDITOR-DECISION.md`).
- Relay: `cd relay && npm install && npm run relay`. Flags, the HTTP API and accounts are in `relay/README.md`.
- Tests: `npm run test:editor`, `cd relay && npm run e2e && npm run e2e:auth`, `npx tsc --noEmit`, `npx expo lint`.
- Architecture: `design/ARCHITECTURE.md`. Trying it with real agents: `TESTING.md`.
