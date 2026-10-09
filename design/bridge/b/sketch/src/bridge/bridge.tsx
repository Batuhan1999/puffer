import { createContext, ReactNode, useContext } from 'react';

import type { AgentId, RequestId } from '../../shared/bridge-protocol';
import type { Agent, BridgeRequest, Proposal } from '../../modules/puffer-core/src/PufferCoreModule';
import type { ChannelState } from './channel';

// The bridge provider: glue between the relay channel and the native engine. It holds no durable state. For each
// `request` from the relay it calls `puffer().prepare`; if the proposal is `auto` it releases immediately and
// sends the decision, otherwise the request shows up in the Agents tab and `/request/[id]` for review.
// Reconnects replay `pending`; `prepare` is idempotent so replays are harmless.

export type Bridge = {
  channel: ChannelState;
  agents: readonly Agent[];
  requests: readonly BridgeRequest[];
  pending: readonly BridgeRequest[];

  pair(relayUrl: string, code: string): Promise<void>;
  unpair(): Promise<void>;

  /** Returns the one-time secret and the ready-to-paste `claude mcp add` line. The secret is not kept anywhere. */
  addAgent(input: { name: string; role: string; symbol: string }): Promise<{ agent: Agent; secret: string; command: string }>;
  removeAgent(id: AgentId): Promise<void>;
  setGrant(agentId: AgentId, collectionId: string, allowed: boolean): Promise<void>;

  /** The proposal the review screen renders. Same object the engine used to decide `auto`. */
  proposal(id: RequestId): Promise<Proposal>;
  approve(id: RequestId, itemIds: readonly string[]): Promise<void>;
  deny(id: RequestId): Promise<void>;
};

const BridgeContext = createContext<Bridge | null>(null);

export function BridgeProvider({ children }: { children: ReactNode }) {
  // subscribe to puffer().addListener('onChange') for agents/requests; to channel.onMessage for requests;
  // on 'request': prepare -> auto ? release(all offered) + sendDecision : nothing (UI shows pending)
  // on 'cancel': deny with kind 'expired'
  // on channel 'online': syncAgents(agents.map(hash)) so the relay can authenticate new agents
  throw new Error('not implemented');
}

export function useBridge(): Bridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error('useBridge must be used inside <BridgeProvider>');
  return bridge;
}

/** `claude mcp add --transport http puffer <relayUrl>/mcp --header "Authorization: Bearer <secret>"` */
export function claudeMcpAddCommand(relayUrl: string, secret: string): string {
  throw new Error('not implemented');
}
