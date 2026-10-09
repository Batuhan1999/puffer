# Testing Puffer with real agents

The relay runs at `https://puffer.fly.dev` (one machine in Frankfurt). Puffer in the iPhone simulator is paired with it. Your notes and documents never leave the simulator unless Puffer shares them to answer an agent's request.

Keep the simulator running with Puffer open while you test. When Puffer is closed, agents get "phone offline" plus a link, and their question waits until Puffer opens again.

## 1. Connect your Claude Code (MCP + OAuth)

```bash
claude mcp add --transport http puffer https://puffer.fly.dev/mcp
```

1. In a Claude Code session, type `/mcp`, pick `puffer` and sign in. A browser page opens with a QR code.
2. Scan the QR code with your iPhone's camera and open the link. Puffer shows "Claude Code wants to connect". Tap Approve. This is the only approval: a connected agent's requests are answered without asking again. With the simulator, open the page's Open in Puffer link in the simulator's Safari instead, or open the QR code's URL there.
3. Ask Claude Code something your notes know, for example:
   - "Use Puffer: when is the vet appointment?"
   - "Ask Puffer what deposit I paid for the apartment."
   - "What changed in my Puffer library recently?"
   - "Ask Puffer for chess openings." This one should come back with nothing found.
4. Try the note tools: "Create a note in Puffer called Packing list", then "Append a passport reminder to it", then "Delete it". Each change shows up in the Notes tab, and the History of the agent (Agents, the agent) lists every request.

Claude Code shows up as "not verified" when it connects, because its sign-in returns to your own computer. That is expected.

To remove it again, disconnect it in Puffer (Agents, the agent, Disconnect). Run `claude mcp remove puffer` to remove it from Claude Code too.

## 2. Plain HTTP (for agents without MCP, such as Instinct)

Easiest: send the agent this one line. It contains no key.

```text
Connect to my Puffer: https://puffer.fly.dev/start
```

The agent reads the instructions there, asks the relay for access and texts you an approval link. Tap it on the iPhone and approve. The agent then collects its own key. In Puffer, Agents shows the same message under "Connect by Message" with Copy Message and Share buttons.

The agent finishes with an `ak_` key and calls the API with it. If you already have a key, for example from an earlier connection:

```bash
export PUFFER_KEY='paste the ak_ key here'
```

```bash
curl -s https://puffer.fly.dev/v1/ask -H "Authorization: Bearer $PUFFER_KEY" -H 'Content-Type: application/json' -d '{"question": "When is the vet appointment?"}'
```

```bash
curl -s "https://puffer.fly.dev/v1/changes" -H "Authorization: Bearer $PUFFER_KEY"
```

An agent that imports OpenAPI can use `https://puffer.fly.dev/openapi.json`. The key always goes in the `Authorization` header. An agent that cannot set a header cannot use the API directly.

## 3. ChatGPT and dots

Add a custom MCP connector (developer mode) with the URL `https://puffer.fly.dev/mcp`. It signs in the same way as in section 1: scan the QR code with your iPhone and approve in Puffer. ChatGPT's menu names change often, so look under Settings for apps or connectors. This path is untested.

## 4. Apple Notes through Shortcuts

Puffer cannot read Notes directly. A Shortcut hands your notes to Puffer, which turns them into Puffer notes (default folder "Imported", source "Apple Notes"). Agents can search and read them like any other note. The in-app guide is Notes, then Import from Apple Notes.

After installing a new build, re-add the action in your existing Shortcut, so it matches the new build's action:

1. In Shortcuts, open your Apple Notes sync shortcut (or tap New Shortcut).
2. Keep Find Notes on All Notes, with no filter and Limit off.
3. Remove the old Puffer action if there is one and add **Sync Notes to Puffer** again after Find Notes. The action accepts files, text and rich text, so it takes the found notes on its own. Optional: Show More, then a Folder name.
4. Run it. Puffer can stay closed. It reports how many notes it added, updated and skipped.

Check that:

- Headings, bold, italic, lists, checklists and links keep their formatting, and the notes appear in the Imported folder.
- Running it again adds nothing new. A note you edited or deleted in Puffer stays as it is. A note you changed only in Notes is updated.
- An agent finds an imported note ("Search my Puffer notes for ...").

Keep it current with an automation:

1. In Shortcuts, open Automation and add a Time of Day automation.
2. Choose Daily and Run Immediately.
3. As the action, use Find Notes (All Notes) and then Sync Notes to Puffer.

To add notes without touching others, use the **Add to Puffer** action instead. It also takes a title, text, dates and a folder, for example inside Repeat with Each.

The simulator has no Notes app. There, export a note from a Mac as Markdown (or use any `.md` file) and open it in Puffer through the share sheet or the Files app: Markdown becomes a note in Imported.

## 5. Automated checks

Node checks, no device needed:

```bash
npm run test:editor
```

Needs Node 24. It runs the Tiptap editor's Markdown codec (`src/ui/editor/markdown.ts`) through round trips over 5000+ documents. It does not run the byte-for-byte comparison with the native parser: that needs Swift, so it only runs on the Mac through `scripts/editor-markdown-check/run.sh` (which also runs the native parser, serializer and merge checks, then `tiptap.mjs` against the native output).

```bash
cd relay && npm run e2e
```

Starts the real relay as a child process, plays the phone and the agent over MCP and prints one PASS or FAIL line per assertion. `npm run typecheck` in `relay/` checks types, and `npm run lint` at the repo root runs Expo's ESLint.

## 6. Compare the editors

Start Metro with the editor you want and open the same notes in each (a long note with headings, lists, a checklist, a table and an attachment is a good test):

```bash
EXPO_PUBLIC_PUFFER_EDITOR=native npx expo start   # the default
EXPO_PUBLIC_PUFFER_EDITOR=tiptap npx expo start   # Tiptap in an Expo DOM component
EXPO_PUBLIC_PUFFER_EDITOR=enriched npx expo start # react-native-enriched-html spike
```

Check each in light and dark mode: typing, the keyboard bar and Aa panel, checklists, undo, saving (close and reopen the note), and an edit from an agent while the note is open. Rebuild or restart Metro with `--clear` after changing the variable, since it is inlined at bundle time.

## Things to know

- Every redeploy restarts the relay. Waiting questions and unfinished sign-ins are lost, and agents ask again.
- History (Agents) lists every request and every change read, per agent.
- Server logs: `fly logs -a puffer`. The pairing key is never printed there.
