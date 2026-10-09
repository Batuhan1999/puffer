// relay/src/protocol.ts
// Authoritative schema for the phone <-> relay wire (v1). Swift mirrors it in
// modules/puffer-native/ios/Relay.swift; relay/scripts/e2e.ts fails on drift.
// Everything from the network is parsed here; the rest of the relay trusts these types.

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export type AgentId = string & { readonly __brand: 'AgentId' };
export type RequestId = string & { readonly __brand: 'RequestId' };
export type KeyDigest = string & { readonly __brand: 'KeyDigest' }; // "sha256:<hex>"

export const SharedItem = z.object({
  title: z.string().max(300),
  kind: z.enum(['passage', 'photo']),
  text: z.string().max(1000).nullable(),
  imageJpeg: z.string().max(2_000_000).nullable(), // base64; only for photos the user switched on
});
export type SharedItem = z.infer<typeof SharedItem>;

export const Outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answered'), id: z.string(), items: z.array(SharedItem).min(1).max(6) }),
  z.object({ kind: z.literal('nothingFound'), id: z.string() }),
  z.object({ kind: z.literal('declined'), id: z.string() }),
  z.object({ kind: z.literal('expired'), id: z.string() }),
  z.object({ kind: z.literal('awaitingUser'), id: z.string() }),
]);
export type Outcome = z.infer<typeof Outcome>;

export const WireRegistry = z.object({
  revision: z.number().int().nonnegative(),
  agents: z.array(z.object({ id: z.string(), name: z.string().max(80), keyDigest: z.string().startsWith('sha256:') })),
});
export type WireRegistry = z.infer<typeof WireRegistry>;

export const SyncBody = z.object({
  v: z.literal(PROTOCOL_VERSION),
  waitMs: z.number().int().min(0).max(25_000),
  outbox: z.array(Outcome).max(100),
  registry: WireRegistry.nullable(),
});
export type SyncBody = z.infer<typeof SyncBody>;

export type WireRequest = { id: RequestId; agentId: AgentId; question: string; askedAt: string; expiresAt: string };

export type SyncResponse = {
  v: typeof PROTOCOL_VERSION;
  requests: WireRequest[];
  acked: { id: RequestId; kind: Outcome['kind'] }[];
  registryRevision: number;
};

/** What an agent's tool call resolves to. Derived by mailbox.toolStatus; rendered by mcp.toToolResult. */
export type ToolOutcome =
  | { status: 'answered'; items: SharedItem[] }
  | { status: 'nothing_found' }
  | { status: 'declined' }
  | { status: 'expired' }
  | { status: 'waiting_for_user'; requestId: RequestId }
  | { status: 'processing'; requestId: RequestId }
  | { status: 'phone_offline'; requestId: RequestId; lastSeenAt: string | null };

/** 400 on a schema failure, 426 on a version mismatch. */
export function parseSyncBody(raw: unknown): { ok: true; body: SyncBody } | { ok: false; status: 400 | 426; error: string } {
  throw new Error('not implemented');
}
