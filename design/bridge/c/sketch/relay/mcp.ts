import type { AgentAuthenticator } from './pairing';
import type { Mailbox } from './mailbox';
import type { Answer } from './protocol';

/**
 * Streamable HTTP MCP endpoint at /mcp (spec 2025-11-25), stateless per request, built on the official TypeScript SDK.
 *
 * Tools (the whole agent-facing surface):
 *  search(query, broaden?)       enqueue and wait up to WAIT_MS. Returns an AgentResult.
 *  check_request(requestId)      long-poll an earlier request for up to WAIT_MS.
 *
 * Why two tools and not MCP tasks: tasks are experimental in 2025-11-25 and need client opt-in.
 * Every client can call a second tool. `tools[].execution.taskSupport` can be added later without a contract change.
 *
 * Progress notifications keep the HTTP request alive while the user decides. WAIT_MS stays under Claude Code's
 * 60 s first-byte timer. After that the agent gets `pending_user` and polls.
 */
export const WAIT_MS = 45_000;

export type AgentResult =
  | { status: 'answered'; via: 'auto' | 'user'; items: ToolItem[]; photosWithheld: number; note?: string }
  | { status: 'pending_user'; requestId: string; hint: string }
  | { status: 'phone_offline'; requestId: string; hint: string }
  | { status: 'denied' }
  | { status: 'expired' };

export type ToolItem = { ref: string; kind: 'passage' | 'photo'; title: string; snippet?: string };

export function toAgentResult(answer: Answer): { result: AgentResult; images: { data: string; mimeType: 'image/jpeg' }[] } {
  throw new Error('not implemented');
}

export function mountMcp(app: import('node:http').RequestListener, auth: AgentAuthenticator, mailbox: Mailbox): void {
  throw new Error('not implemented');
}
