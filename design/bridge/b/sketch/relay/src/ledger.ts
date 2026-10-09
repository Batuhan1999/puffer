import type { AgentId, AgentRoster, Outcome, RequestId } from '../../shared/bridge-protocol';

// The relay's durable state: paired devices, the agent roster the phone pushed, and every request with its
// lifecycle. One SQLite file next to the relay (better-sqlite3 or node:sqlite). The relay is the source of truth
// for request ids and for "has the agent been answered"; the phone is the source of truth for everything else.

export type RelayRequest = {
  id: RequestId;
  agentId: AgentId;
  question: string;
  createdAt: number;
  state:
    | { kind: 'queued' } // phone offline or not yet acked
    | { kind: 'delivered'; at: number } // phone has it, user may be looking at it
    | { kind: 'decided'; outcome: Outcome }
    | { kind: 'cancelled'; at: number };
};

export type Device = { deviceId: string; deviceName: string; deviceTokenHash: string; pairedAt: number };

export class Ledger {
  static open(file: string): Ledger {
    throw new Error('not implemented');
  }

  // Pairing. The code is printed on the relay's stdout at start and accepted once.
  pairingCode(): string {
    throw new Error('not implemented');
  }
  pair(code: string, deviceId: string, deviceName: string): { deviceToken: string } {
    throw new Error('not implemented');
  }
  deviceFor(token: string): Device | null {
    throw new Error('not implemented');
  }

  // Agents. Full replacement on every `agents` message; the relay stores hashes only.
  replaceAgents(agents: readonly AgentRoster[]): void {
    throw new Error('not implemented');
  }
  /** Constant-time compare of sha256(bearer) against the roster. */
  agentFor(bearer: string): { agentId: AgentId; name: string } | null {
    throw new Error('not implemented');
  }

  // Requests. `create` dedupes an identical (agentId, question) still undecided within `dedupeMs`, so an agent
  // retrying after a timeout re-attaches to the same pending request instead of making the user approve twice.
  create(agentId: AgentId, question: string, dedupeMs: number): RelayRequest {
    throw new Error('not implemented');
  }
  get(id: RequestId): RelayRequest | null {
    throw new Error('not implemented');
  }
  /** Requests the phone has not decided. Sent on every reconnect as `pending`. */
  undecided(): RelayRequest[] {
    throw new Error('not implemented');
  }
  markDelivered(id: RequestId, at: number): void {
    throw new Error('not implemented');
  }
  /** Idempotent: a second `decided` for the same id is a no-op and still gets a `decided-ack`. */
  decide(id: RequestId, outcome: Outcome): boolean {
    throw new Error('not implemented');
  }
  cancel(id: RequestId, at: number): void {
    throw new Error('not implemented');
  }
}
