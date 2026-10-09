// relay/scripts/e2e.ts
// The verification lever. Drives the real simulator app and a real relay with an MCP SDK client,
// the same path Claude Code takes. Each step asserts an observable outcome; a failing step stops the run.
//
// Preconditions: relay running on localhost, app installed and indexed on the booted simulator,
// one agent connected in the app with its key in PUFFER_AGENT_KEY. Approvals on the phone are done by
// hand: the script prints what to tap and waits for the request to settle.
//
// Steps
//  1. pair         xcrun simctl openurl booted <pairing link>; poll /healthz until phone.online.
//  2. unauthorized tools/call with a wrong key -> HTTP 401.
//  3. ask/approve  ask_puffer("deposit in my lease") -> waiting_for_user; approve on the phone;
//                  get_puffer_answer -> answered with >= 1 passage and no field named like vec/embedding.
//  4. deny         ask_puffer(...) -> deny on the phone -> declined.
//  5. grant        grant the matching collection in the app; ask again -> answered with no UI step,
//                  structuredContent shows the grant path.
//  6. photo        ask for a photo -> waiting_for_user, photo off by default; approve with the photo on
//                  -> one image content item.
//  7. offline      xcrun simctl launch booted com.apple.Preferences (Puffer to background), wait 40 s,
//                  ask -> phone_offline within 5 s; run "Check Agent Requests" from Shortcuts;
//                  get_puffer_answer -> answered (grant path).
//  8. revoke       revoke the agent in the app; the next tools/call -> 401.
//  9. replay       re-post a captured sync body twice -> same acks, no duplicate ledger rows on the phone.

export type Step = { name: string; run(): Promise<void> };

export async function runE2E(options: { relay: string; agentKey: string; pairingLink: string }): Promise<void> {
  throw new Error('not implemented');
}
