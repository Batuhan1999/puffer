import type { AgentId, Disclosure, RequestId } from '../../shared/bridge-protocol';
import type { Ledger } from './ledger';
import type { PhoneLink } from './phone';

// MCP surface. Three read-only tools over one request model. `search` blocks while the phone decides and keeps
// the call alive with progress notifications (Claude Code idles out HTTP tool calls after 5 min without progress
// and moves calls over 2 min to a background task; the per-server `timeout` is a hard cap). If the cap is near,
// `search` returns `pending` with the request id and `result` picks it up later. MCP tasks (2025-11-25,
// experimental) map one to one onto RelayRequest.state and replace this fallback once the server SDK exposes
// them; the TS SDK's tasks support was not verified this round.

export type SearchInput = { question: string };
export type SearchOutput =
  | { status: 'answered'; requestId: RequestId; auto: boolean; disclosures: readonly Disclosure[] }
  | { status: 'nothing'; requestId: RequestId }
  | { status: 'denied'; requestId: RequestId }
  | { status: 'pending'; requestId: RequestId; phone: 'online' | 'offline'; hint: string };

export type ResultInput = { requestId: RequestId };
export type StatusOutput = { agent: string; phone: 'online' | 'offline'; lastSeen: number | null; pendingForYou: number };

export type RelayOptions = {
  /** How long `search` may block before returning `pending`. Default 540_000 (under Claude Code's default idle). */
  maxWaitMs: number;
  progressEveryMs: number;
  dedupeMs: number;
};

/** Identity the HTTP layer resolved from the bearer token before the MCP handler ran. */
export type AgentContext = { agentId: AgentId; name: string };

/**
 * Builds a fresh McpServer per session (the `@modelcontextprotocol/server` factory style) with:
 *   search(question)  readOnlyHint, idempotentHint  -> SearchOutput as structuredContent (+ image content blocks for images)
 *   result(requestId) readOnlyHint                  -> SearchOutput
 *   status()          readOnlyHint                  -> StatusOutput
 * Each tool is scoped to `agent`; a request id from another agent is "not found".
 */
export function buildServer(agent: AgentContext, ledger: Ledger, phone: PhoneLink, options: RelayOptions): unknown {
  throw new Error('not implemented');
}

/** Converts an Outcome into tool content: snippets as text, images as `image` content blocks, nothing else. */
export function toToolResult(output: SearchOutput): { content: unknown[]; structuredContent: SearchOutput } {
  throw new Error('not implemented');
}
