# Testing Puffer with real agents

The relay runs at `https://puffer.fly.dev` (one machine in Frankfurt). Puffer in the iPhone simulator is paired with it. Your documents and photos never leave the simulator unless Puffer shares them for a request.

Keep the simulator running with Puffer open while you test. When Puffer is closed, agents get "phone offline" plus a link, and their question waits until Puffer opens again.

## 1. Connect your Claude Code (MCP + OAuth)

```bash
claude mcp add --transport http puffer https://puffer.fly.dev/mcp
```

1. In a Claude Code session, type `/mcp`, pick `puffer` and sign in. A browser page opens with a QR code.
2. Scan the QR code with your iPhone's camera and open the link. Puffer shows "Claude Code wants to connect". Choose what it may read without asking (Ask Every Time is the default), and tap Approve. With the simulator, open the page's Open in Puffer link in the simulator's Safari instead, or open the QR code's URL there.
3. Ask Claude Code something the demo library knows, for example:
   - "Use Puffer: when is the vet appointment?"
   - "Ask Puffer what deposit I paid for the apartment."
   - "What changed in my Puffer library recently?"
   - "Ask Puffer for chess openings." This one should come back with nothing found.
4. With Ask Every Time, each question shows up in Puffer for review. Switch the agent to Everything in Agents to see automatic answers.

Claude Code shows up as "not verified" when it connects, because its sign-in returns to your own computer. That is expected.

To remove it again, disconnect it in Puffer (Agents, the agent, Disconnect). Run `claude mcp remove puffer` to remove it from Claude Code too.

## 2. Plain HTTP (for agents without MCP, such as Instinct)

Easiest: send the agent this one line. It contains no key.

```text
Connect to my Puffer: https://puffer.fly.dev/start
```

The agent reads the instructions there, asks the relay for access and texts you an approval link. Tap it on the iPhone, choose the access level and approve. The agent then collects its own key. In Puffer, Agents shows the same line under "Connect by Message" with Copy and Share buttons.

Fallback, connecting with a key yourself:

1. In Puffer, open Agents, use "Connect with a Key", give it a name, then tap Copy Key. The screen also shows the HTTP address and the OpenAPI link.
2. Use the key:

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

Puffer cannot read Notes directly. A Shortcut hands your notes to Puffer, which keeps them in its own folder and shows them in Library under the source "Apple Notes". Agents can ask for that source by name.

Build the shortcut on the iPhone:

1. In Shortcuts, tap New Shortcut.
2. Add Find Notes and leave it on All Notes.
3. Add Sync Notes to Puffer. Shortcuts passes the found notes in as text files.
4. Run it once. Puffer reports how many notes it added, updated and removed.

Keep it current with an automation:

1. In Shortcuts, open Automation and add a Time of Day automation.
2. Choose Daily and Run Immediately.
3. As the action, use Find Notes (All Notes) and then Sync Notes to Puffer.

Each run saves new and changed notes and removes notes that you deleted in Notes. Unchanged notes cost nothing. To add notes without removing others, use Add to Puffer instead. It also takes a title, text and dates, for example inside Repeat with Each.

To try it, edit a note, run the shortcut, and ask an agent "What changed in my Puffer library recently?". The edited note shows up as updated.

The simulator has no Notes app. A dev build reads the notes from a file instead and syncs them the way Sync Notes to Puffer does:

```bash
DEV=1D4B8ECF-A717-442E-9828-FCB3F93229DB
DATA=$(xcrun simctl get_app_container $DEV dev.local.puffer data)
cat > "$DATA/Documents/dev-notes.json" <<'EOF'
[{"title": "Packing list", "text": "Passport, charger, rain jacket.", "created": "2026-09-01T08:00:00Z", "modified": "2026-09-02T09:30:00Z"}]
EOF
xcrun simctl openurl $DEV "puffer://dev-sync-notes"
```

The file replaces the source's whole contents, so `[]` removes every note. `created` and `modified` are optional ISO 8601 dates. A note is named by its title and creation date, and `modified` becomes its file date. Puffer opens Library when the sync is done, and Metro logs a `dev-sync-notes` line with the counts.

## Things to know

- Every redeploy restarts the relay. Waiting questions and unfinished sign-ins are lost, and agents ask again.
- History in Puffer lists every answer and every change read, per agent.
- Server logs: `fly logs -a puffer`. The pairing key is never printed there.
