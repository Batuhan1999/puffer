import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { RequestId, ToPhone, ToRelay } from '../../shared/bridge-protocol';
import type { Ledger, RelayRequest } from './ledger';

// The phone's side of the relay: one outbound WebSocket from the app (the phone cannot be a server). Presence is
// derived from heartbeats. There is no wake-up path: a suspended app has no socket, and push needs a paid Apple
// team the project does not have. `Wake` is the seam for adding APNs later; `none` is the only implementation now.

export type Presence = { kind: 'online'; since: number } | { kind: 'offline'; since: number; lastSeen: number | null };

export interface Wake {
  /** Ask the OS to bring the app up for a request. `none` resolves false immediately. */
  wake(request: RelayRequest): Promise<boolean>;
}
export const noWake: Wake = { wake: async () => false };

export class PhoneLink {
  private socket: WebSocket | null = null;
  private waiters = new Map<RequestId, Set<(r: RelayRequest) => void>>();

  constructor(private ledger: Ledger, private wake: Wake) {}

  presence(): Presence {
    throw new Error('not implemented');
  }

  /** HTTP upgrade on GET /link with `Authorization: Bearer <deviceToken>`. Replaces any previous socket. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    throw new Error('not implemented');
  }

  /** Hands a request to the phone if online, else leaves it queued; both cases resolve when `decided` arrives. */
  deliver(request: RelayRequest): void {
    throw new Error('not implemented');
  }

  /** Resolves with the decided request, or `null` when `signal` aborts first. Never throws on disconnect. */
  awaitDecision(id: RequestId, signal: AbortSignal): Promise<RelayRequest | null> {
    throw new Error('not implemented');
  }

  private onMessage(msg: ToRelay): void {
    // hello -> mark online, send `pending` with ledger.undecided()
    // agents -> ledger.replaceAgents
    // decided -> ledger.decide (idempotent), notify waiters, send decided-ack
    // heartbeat -> refresh presence
    throw new Error('not implemented');
  }

  private send(msg: ToPhone): void {
    throw new Error('not implemented');
  }
}
