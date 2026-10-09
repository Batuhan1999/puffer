// modules/puffer-native/src/index.ts
// The only JS file that touches the native module. Raw results are parsed into domain types here,
// so screens never see a native record. Replaces modules/gemma-embed/src/GemmaEmbedModule.ts.
// There is no function that returns or accepts a vector.

import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { Item, Query, SearchResult } from '@/domain';
import type { SearchOptions } from '@/store';

export type Topic = 'items' | 'policy' | 'requests' | 'relay';
export type ChangeEvent = { topic: Topic; revision: number };

export type EngineStatus = {
  model:
    | { phase: 'absent' }
    | { phase: 'loading' }
    | { phase: 'ready'; backend: string; loadMs: number }
    | { phase: 'error'; message: string };
  counts: { photo: number; passage: number };
  revision: number;
};

export type NewPassage = { id: string; title: string; text: string; sourceUri: string; addedAt: number };
export type NewImage = { id: string; title: string; sourceUri: string; addedAt: number; embedJpegUri: string; thumbName: string };

// policy and ledger, mirrored from Bridge.swift

export type Collection = { id: string; name: string; query: string; symbol: string; hidden: readonly string[] };
export type Agent = { id: string; name: string; grants: readonly string[]; connectedAt: number };
export type AgentCredential = { agent: Agent; key: string; setupCommand: string };

export type PolicyEdit =
  | { type: 'collection/save'; collection: Omit<Collection, 'hidden'> }
  | { type: 'collection/remove'; id: string }
  | { type: 'collection/hide'; id: string; itemId: string }
  | { type: 'agent/allow'; agentId: string; collectionId: string; allowed: boolean }
  | { type: 'agent/revoke'; agentId: string };

export type Candidate = {
  itemId: string;
  kind: Item['kind'];
  title: string;
  preview: string | null;
  granted: boolean;
  offered: boolean;
};

export type SharedItemView = { title: string; kind: Item['kind']; text: string | null; image: boolean };

export type RequestPhase =
  | { kind: 'received' }
  | { kind: 'awaitingUser'; candidates: readonly [Candidate, ...Candidate[]] }
  | { kind: 'shared'; items: readonly SharedItemView[]; by: 'user' | 'grant'; at: number }
  | { kind: 'nothingFound'; at: number }
  | { kind: 'denied'; reason: 'user' | 'expired' | 'agentRevoked'; at: number };

export type AgentRequest = {
  id: string;
  agentId: string;
  question: string;
  receivedAt: number;
  phase: RequestPhase;
  delivered: boolean; // the relay acknowledged the current phase
};

export type RelayStatus =
  | { kind: 'unpaired' }
  | { kind: 'paired'; url: string; lastContact: number | null; lastError: string | null };

export type BridgeSnapshot = {
  relay: RelayStatus;
  collections: readonly Collection[];
  agents: readonly Agent[];
  requests: readonly AgentRequest[];
};

export type UserDecision = { kind: 'share'; itemIds: readonly string[] } | { kind: 'deny' };

declare class PufferNativeModule extends NativeModule<{ onChange(event: ChangeEvent): void }> {
  readonly modelPath: string;
  start(): Promise<unknown>;
  status(): Promise<unknown>;
  search(query: unknown, options: SearchOptions): Promise<unknown>;
  items(): Promise<unknown>;
  addPassages(batch: NewPassage[]): Promise<number>;
  addImage(image: NewImage): Promise<void>;
  clear(): Promise<void>;
  snapshot(): Promise<unknown>;
  edit(edit: unknown): Promise<void>;
  members(collectionId: string): Promise<unknown>;
  connectAgent(name: string): Promise<unknown>;
  pair(link: string): Promise<void>;
  unpair(): Promise<void>;
  decide(requestId: string, decision: UserDecision): Promise<void>;
  // folder functions unchanged from GemmaEmbedModule
}

const native = requireOptionalNativeModule<PufferNativeModule>('Puffer');

function module(): PufferNativeModule {
  if (!native) throw new Error('Puffer is iOS only. Build with `npx expo run:ios`.');
  return native;
}

export const engine = {
  modelPath: (): string => module().modelPath,
  start: async (): Promise<EngineStatus> => {
    throw new Error('not implemented');
  },
  status: async (): Promise<EngineStatus> => {
    throw new Error('not implemented');
  },
  /** `{ kind: 'like', item }` is sent as the item id; native looks up the vector. */
  search: async (query: Query, options: SearchOptions): Promise<SearchResult> => {
    throw new Error('not implemented');
  },
  items: async (): Promise<Item[]> => {
    throw new Error('not implemented');
  },
  addPassages: (batch: NewPassage[]) => module().addPassages(batch),
  addImage: (image: NewImage) => module().addImage(image),
  clear: () => module().clear(),
};

export const bridge = {
  snapshot: async (): Promise<BridgeSnapshot> => {
    throw new Error('not implemented');
  },
  edit: (edit: PolicyEdit) => module().edit(edit),
  members: async (collectionId: string): Promise<Item[]> => {
    throw new Error('not implemented');
  },
  connectAgent: async (name: string): Promise<AgentCredential> => {
    throw new Error('not implemented');
  },
  pair: (link: string) => module().pair(link),
  unpair: () => module().unpair(),
  decide: (requestId: string, decision: UserDecision) => module().decide(requestId, decision),
};

export function onChange(listener: (event: ChangeEvent) => void): () => void {
  throw new Error('not implemented');
}
