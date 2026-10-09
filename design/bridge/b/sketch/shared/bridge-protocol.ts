// Wire protocol between the phone and the relay. Imported by both `src/bridge/` (app) and `relay/src/` (Mac),
// so there is exactly one definition of what crosses the network. The relay's MCP tool schemas derive from these.

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type AgentId = Brand<string, 'AgentId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type DeviceId = Brand<string, 'DeviceId'>;

/** The only shapes that ever leave the phone. No vectors, no full text, no file paths, no index metadata. */
export type Disclosure =
  | { kind: 'snippet'; itemId: ItemId; title: string; excerpt: string; source: string }
  | { kind: 'image'; itemId: ItemId; title: string; mimeType: 'image/jpeg'; base64: string };

/** How a request ended on the phone. `nothing` means the index had no relevant item, so there was nothing to approve. */
export type Outcome =
  | { kind: 'released'; disclosures: readonly Disclosure[]; auto: boolean; at: number }
  | { kind: 'denied'; at: number }
  | { kind: 'nothing'; at: number }
  | { kind: 'expired'; at: number };

/** Relay -> phone. */
export type ToPhone =
  | { type: 'request'; id: RequestId; agentId: AgentId; question: string; receivedAt: number }
  | { type: 'cancel'; id: RequestId }
  /** Sent once per connection, right after `hello` is accepted: every request the relay still waits on. */
  | { type: 'pending'; requests: readonly { id: RequestId; agentId: AgentId; question: string; receivedAt: number }[] }
  | { type: 'decided-ack'; id: RequestId };

/** Phone -> relay. */
export type ToRelay =
  | { type: 'hello'; deviceId: DeviceId; deviceName: string; protocol: 1 }
  /** Full replacement of the agent roster. The relay never learns grants; it only authenticates. */
  | { type: 'agents'; agents: readonly AgentRoster[] }
  | { type: 'decided'; id: RequestId; outcome: Outcome }
  | { type: 'heartbeat'; at: number };

/** What the relay knows about an agent: enough to authenticate a bearer token, nothing about permissions. */
export type AgentRoster = { agentId: AgentId; name: string; tokenHash: string };

/** Pairing happens once over plain HTTP on the relay before the WebSocket is opened. */
export type PairRequest = { code: string; deviceId: DeviceId; deviceName: string };
export type PairResponse = { deviceToken: string; relayName: string };

export const PROTOCOL_VERSION = 1 as const;
export const HEARTBEAT_MS = 20_000;
/** A phone that misses this many heartbeats is `offline` and the relay says so to agents. */
export const OFFLINE_AFTER_MISSED = 2;

export function parseToPhone(raw: string): ToPhone {
  throw new Error('not implemented');
}
export function parseToRelay(raw: string): ToRelay {
  throw new Error('not implemented');
}
