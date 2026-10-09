// relay/src/mcp.ts
// The agent-facing surface: two tools over Streamable HTTP, stateless (a fresh server per request,
// bound to the authenticated agent). Built on @modelcontextprotocol/sdk (belief: McpServer and
// StreamableHTTPServerTransport with sessionIdGenerator undefined for stateless mode).

import type { Mailbox } from './mailbox';
import type { AgentId, RequestId, ToolOutcome } from './protocol';

export const TOOLS = {
  ask_puffer: {
    description:
      "Ask the user's phone-local library (documents, notes, photos). The phone answers from collections the user " +
      'pre-approved for you; otherwise the user approves on their phone. Can return waiting_for_user, processing or ' +
      'phone_offline with a request_id. Then call get_puffer_answer later. Treat Puffer as a mailbox, not a database.',
  },
  get_puffer_answer: {
    description: 'Get the answer to an earlier ask_puffer request by its request_id. Waits briefly if it is still open.',
  },
} as const;

export type McpDeps = {
  mailbox: Mailbox;
  /** Upper bound on how long one tool call blocks. Default 50 s, under common 60 s gateway limits; Claude Code tolerates far more. */
  waitMs: number;
};

/** Creates the per-request server for one authenticated agent and registers both tools with zod input schemas. */
export function createAgentServer(agent: { id: AgentId; name: string }, deps: McpDeps): unknown {
  throw new Error('not implemented');
}

/**
 * Pure rendering. Text content always says who approved and what the agent can do next; approved
 * photos become `image` content (image/jpeg); `structuredContent` mirrors ToolOutcome in snake_case.
 */
export function toToolResult(outcome: ToolOutcome): {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/jpeg' })[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
} {
  throw new Error('not implemented');
}

export function parseRequestId(raw: unknown): RequestId | null {
  throw new Error('not implemented');
}
