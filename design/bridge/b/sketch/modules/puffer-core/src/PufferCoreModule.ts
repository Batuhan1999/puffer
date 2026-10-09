import { NativeModule, requireOptionalNativeModule } from 'expo';

import type { AgentId, Disclosure, ItemId, Outcome, RequestId } from '../../../shared/bridge-protocol';

// This replaces `gemma-embed`. The module is the single owner of all durable state on the phone:
// items and vectors, collections, agents and grants, requests and the disclosure log. JS reads snapshots
// and asks for changes. JS never receives a vector; there is no function here that returns one.

export type Kind = 'photo' | 'passage';
export type Dim = 128 | 256 | 512 | 768;
export type Mode = 'vector' | 'keyword' | 'hybrid';

export type Item = {
  id: ItemId;
  kind: Kind;
  title: string;
  text?: string;
  sourceUri: string;
  thumbUri?: string;
  addedAt: number;
};

export type Query = { kind: 'text'; text: string } | { kind: 'like'; itemId: ItemId };
export type SearchOptions = { mode: Mode; dim: Dim; rerank: boolean };
export type Hit = { item: Item; score: number; similarity: number | null };
export type Timings = {
  embedMs: number | null;
  scanMs: number | null;
  rerankMs: number | null;
  keywordMs: number | null;
  n: number;
  dim: Dim;
  indexBytes: number;
};
export type SearchResult = { hits: Hit[]; timings: Timings };

export type PassageInput = { id: ItemId; title: string; text: string; sourceUri: string; addedAt: number };
export type PhotoInput = { id: ItemId; title: string; sourceUri: string; jpegUri: string; thumbName: string; addedAt: number };

export type Collection = { id: string; name: string; query: string; symbol: string; hidden: readonly ItemId[] };
export type Agent = { id: AgentId; name: string; role: string; symbol: string; createdAt: number; grants: readonly string[] };

/** One item the phone would disclose for a request, with the exact preview of what would leave. */
export type Candidate = {
  item: Item;
  rank: number;
  similarity: number;
  /** Granted collections (for this agent) that contain the item. Empty means the user must look at it. */
  covered: readonly string[];
  /** On by default in the review screen. Passages near the top only. Photos are never offered. */
  offered: boolean;
  preview: Disclosure;
};

/**
 * What `prepare` returns. `auto` is true when every offered candidate is covered by a grant, in which case the
 * caller releases without showing UI. The release still goes through `release`, so the log has one path.
 */
export type Proposal = {
  requestId: RequestId;
  agentId: AgentId;
  question: string;
  candidates: readonly Candidate[];
  auto: boolean;
};

export type BridgeRequest = {
  id: RequestId;
  agentId: AgentId;
  question: string;
  receivedAt: number;
  status: { kind: 'pending' } | Outcome;
};

export type Folder = { id: string; name: string };
export type FolderFile = { path: string; name: string; kind: 'text' | 'pdf' | 'image'; size: number; modified: number };

type Events = {
  /** Spotlight tap or an OpenPufferItem intent asked the app to show an item. */
  onOpenItem(event: { itemId: ItemId }): void;
  /** Any table changed (ingest, collections, agents, requests). JS re-reads the snapshot it cares about. */
  onChange(event: { tables: readonly ('items' | 'collections' | 'agents' | 'requests')[] }): void;
};

declare class PufferCoreModule extends NativeModule<Events> {
  // Model
  load(modelUri: string): Promise<'gpu' | 'cpu'>;

  // Index. Embedding happens inside; vectors never cross this boundary.
  addPassages(inputs: PassageInput[]): Promise<number>;
  addPhoto(input: PhotoInput): Promise<boolean>;
  has(id: ItemId): boolean;
  items(): Promise<Item[]>;
  counts(): Record<Kind, number>;
  clear(): Promise<void>;
  search(query: Query, options: SearchOptions): Promise<SearchResult>;

  // Collections (saved description queries)
  collections(): Promise<Collection[]>;
  saveCollection(collection: Omit<Collection, 'hidden'>): Promise<void>;
  removeCollection(id: string): Promise<void>;
  hideFromCollection(id: string, itemId: ItemId): Promise<void>;

  // Agents and grants. The secret is returned exactly once and never stored on the phone.
  agents(): Promise<Agent[]>;
  createAgent(input: { name: string; role: string; symbol: string }): Promise<{ agent: Agent; secret: string; tokenHash: string }>;
  removeAgent(id: AgentId): Promise<void>;
  setGrant(agentId: AgentId, collectionId: string, allowed: boolean): Promise<void>;

  // Requests. `prepare` is idempotent on `id`; a second call returns the stored proposal.
  prepare(input: { id: RequestId; agentId: AgentId; question: string; receivedAt: number }): Promise<Proposal>;
  release(id: RequestId, itemIds: ItemId[]): Promise<Outcome>;
  deny(id: RequestId): Promise<Outcome>;
  requests(): Promise<BridgeRequest[]>;

  // Navigation handoff for cold launches, when the event fired before JS listened.
  takePendingOpen(): ItemId | null;

  // Folder store (unchanged)
  pickFolder(): Promise<Folder | null>;
  listFolders(): Promise<Folder[]>;
  scanFolder(id: string): Promise<FolderFile[]>;
  readFolderText(id: string, path: string): Promise<string[]>;
  copyFolderFile(id: string, path: string): Promise<string>;
  pdfText(fileUri: string): Promise<string[]>;
}

const native = requireOptionalNativeModule<PufferCoreModule>('PufferCore');

export default function puffer(): PufferCoreModule {
  if (!native) throw new Error('PufferCore is iOS only. Build with `npx expo run:ios`.');
  return native;
}
