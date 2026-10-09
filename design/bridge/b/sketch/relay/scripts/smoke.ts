// End-to-end check runnable on this Mac without Claude Code: starts the relay, pairs a fake phone over the real
// WebSocket protocol, then acts as an MCP client against /mcp and asserts:
//   1. unauthenticated /mcp -> 401
//   2. search() with phone offline -> pending within maxWaitMs=2000
//   3. fake phone connects, receives `pending`, answers `decided` with two snippets -> result() returns them
//   4. the JSON of every tool result contains no key named vec, vector, embedding, or sourceUri
//   5. a second search() with the same question while undecided re-attaches (same requestId)
// The same script, pointed at the simulator app instead of the fake phone, is the manual demo checklist.

export async function smoke(relayUrl: string): Promise<void> {
  throw new Error('not implemented');
}
