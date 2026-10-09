import type { Answer, Ask, AgentId, RequestId } from './protocol';

// One state machine owns every request on the relay. MCP tools and the device socket only call into it.
// State lives in memory. A relay restart drops pending requests, and agents see `expired`.
// Results are deleted when the agent collects them or the TTL passes. The relay never keeps an index or a cache.

export type Entry =
  | { state: 'queued'; ask: Ask }
  | { state: 'delivered'; ask: Ask; deliveredAt: number }
  | { state: 'answered'; ask: Ask; answer: Answer }
  | { state: 'expired'; ask: Ask };

export type Presence = 'online' | 'offline';

export type AgentView =
  | { status: 'answered'; answer: Answer }
  | { status: 'pending_user' }
  | { status: 'phone_offline' }
  | { status: 'expired' }
  | { status: 'unknown_request' };

export interface Mailbox {
  /** Idempotent on requestId. */
  enqueue(ask: Ask): Entry;
  /** Asks the device has not answered, oldest first. Marks them delivered. */
  takeForDelivery(answered: ReadonlySet<RequestId>): Ask[];
  /** First answer wins. A duplicate answer returns false and changes nothing. */
  answer(answer: Answer): boolean;
  setPresence(p: Presence): void;
  /** Resolves when the request leaves `queued`/`delivered`, or when waitMs passes. Scoped to the owning agent. */
  view(agentId: AgentId, requestId: RequestId, waitMs: number): Promise<AgentView>;
  sweep(now: number): void;
}

export function createMailbox(clock: () => number): Mailbox {
  throw new Error('not implemented');
}
