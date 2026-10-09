// relay/src/mailbox.ts
// Parked requests and the device long-poll. In memory: a restart drops parked requests and agents
// see `expired`. No content decisions happen here; the phone decides, the mailbox carries.

import type { AgentId, RequestId, SharedItem, SyncBody, SyncResponse, ToolOutcome } from './protocol';

export type RequestState =
  | { kind: 'queued' } // not yet handed to the phone
  | { kind: 'withPhone'; since: number } // handed over, no status back yet
  | { kind: 'awaitingUser'; since: number }
  | {
      kind: 'settled';
      at: number;
      outcome: { kind: 'answered'; items: SharedItem[] } | { kind: 'nothingFound' } | { kind: 'declined' } | { kind: 'expired' };
    };

export type RelayRequest = {
  id: RequestId;
  agentId: AgentId;
  question: string;
  askedAt: number;
  expiresAt: number;
  state: RequestState;
};

export type DevicePresence = { online: boolean; lastSeenAt: number | null };

export type MailboxOptions = {
  clock: () => number;
  ttlMs: number; // queued and unanswered requests expire after this (default 24 h)
  settledRetentionMs: number; // answers are dropped this long after settling (default 1 h)
  offlineAfterMs: number; // no sync for this long means offline (default 35 s, longer than one long-poll)
  offlineGraceMs: number; // an ask waits this long for an offline phone before answering phone_offline (default 2 s)
  maxOpenPerAgent: number; // more open requests than this is refused, so one agent cannot flood the phone (default 10)
};

export class Mailbox {
  constructor(options: MailboxOptions) {
    throw new Error('not implemented');
  }

  /**
   * Creates the request and waits until it settles, the wait budget ends, or the phone is offline
   * past the grace period. Returns the derived ToolOutcome. Aborting the signal stops waiting but
   * keeps the request. Throws MailboxFull when the agent already has maxOpenPerAgent open requests;
   * mcp renders that as an isError result.
   */
  ask(agentId: AgentId, question: string, waitMs: number, signal: AbortSignal): Promise<ToolOutcome> {
    throw new Error('not implemented');
  }

  /** Same wait for an existing request. Another agent's id or an unknown id reads as `expired`. */
  check(agentId: AgentId, requestId: RequestId, waitMs: number, signal: AbortSignal): Promise<ToolOutcome> {
    throw new Error('not implemented');
  }

  /**
   * The device side. Applies the outbox (first terminal outcome per id wins; later ones are acked and
   * ignored), marks `awaitingUser`, then returns every request in `queued` or `withPhone` and moves
   * queued ones to `withPhone`. Answers immediately when the body carried outcomes or requests are
   * ready; otherwise parks until a request arrives or waitMs passes. A second concurrent sync
   * replaces the first parked one (the older is answered empty).
   */
  sync(body: SyncBody, signal: AbortSignal): Promise<Omit<SyncResponse, 'registryRevision'>> {
    throw new Error('not implemented');
  }

  /** Called when the phone drops an agent: its open requests settle as `expired`. */
  revoke(agentId: AgentId): void {
    throw new Error('not implemented');
  }

  presence(): DevicePresence {
    throw new Error('not implemented');
  }

  /** Expiry sweep, run on a timer and before every read. */
  sweep(): void {
    throw new Error('not implemented');
  }
}

/** Pure. The single mapping from relay state and presence to what the agent is told. */
export function toolStatus(request: RelayRequest, presence: DevicePresence): ToolOutcome {
  throw new Error('not implemented');
}
