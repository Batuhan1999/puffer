// Wire contract between relay and phone. Mirrored by Swift Codable types in ios/PufferCore/Bridge.swift.
// The two sides are held together by golden JSON files in ../contract/, decoded by both test suites.
// Everything here is parsed at the socket boundary; code past parse() trusts these types.

export type AgentId = string & { readonly __brand: 'AgentId' };
export type RequestId = string & { readonly __brand: 'RequestId' };
export type DeviceId = string & { readonly __brand: 'DeviceId' };

export const LIMITS = {
  queryChars: 300,
  itemsPerAnswer: 8,
  snippetChars: 600,
  imageBytes: 400_000,
  requestTtlMs: 10 * 60_000,
  frameBytes: 2_000_000,
} as const;

/** What the agent asked for. `broaden` is the agent's explicit request to look beyond its granted collections. */
export type AskScope = 'granted' | 'broaden';

export type Ask = {
  requestId: RequestId;
  agentId: AgentId;
  agentName: string; // display only, phone prefers its own record for agentId
  query: string;
  scope: AskScope;
  receivedAt: number;
  expiresAt: number;
};

/** Item as the agent sees it. `ref` is a per-request opaque handle, never the phone's item id. */
export type SharedItem =
  | { ref: string; kind: 'passage'; title: string; snippet: string }
  | { ref: string; kind: 'photo'; title: string; jpegBase64: string };

export type Outcome =
  | { kind: 'shared'; via: 'auto' | 'user'; items: SharedItem[]; photosWithheld: number }
  | { kind: 'denied' };

export type Answer = { requestId: RequestId; outcome: Outcome; answeredAt: number };

// relay -> phone
export type RelayFrame =
  | { t: 'hello'; nonce: string }
  | { t: 'paired'; deviceId: DeviceId }
  | { t: 'ask'; ask: Ask }
  | { t: 'cancel'; requestId: RequestId; reason: 'expired' | 'agent_gone' };

// phone -> relay
export type PhoneFrame =
  | { t: 'pair'; code: string; publicKeyDer: string }
  | { t: 'auth'; deviceId: DeviceId; signature: string }
  | { t: 'registerAgent'; agentId: AgentId; secretSha256: string; name: string; signature: string }
  | { t: 'revokeAgent'; agentId: AgentId; signature: string }
  /** Sent after auth and on every foreground. Relay re-sends asks the phone has not answered. */
  | { t: 'sync'; answered: RequestId[] }
  | { t: 'answer'; answer: Answer };

export function parseRelayFrame(raw: string): RelayFrame {
  throw new Error('not implemented');
}
export function parsePhoneFrame(raw: string): PhoneFrame {
  throw new Error('not implemented');
}
