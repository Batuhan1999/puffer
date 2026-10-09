import { NativeModule, requireOptionalNativeModule } from 'expo';
import type { Item, Kind } from '../../../../src/domain';

// Typed face of the native core. The only wire between JS and the index.
// Vectors cross once, at add time. Search never returns text or vectors, only ids and scores; JS maps ids to the
// `items` read model it already holds.

export type SearchArgs = {
  subject: { kind: 'text'; text: string } | { kind: 'like'; id: string };
  mode: 'vector' | 'keyword' | 'hybrid';
  dim: 128 | 256 | 512 | 768;
  rerank: boolean;
};
export type SearchHits = {
  hits: { id: string; score: number; similarity: number | null }[];
  timings: { embedMs: number | null; scanMs: number | null; rerankMs: number | null; keywordMs: number | null; n: number; dim: number; indexBytes: number };
};

export type CollectionView = { id: string; name: string; query: string; symbol: string; hidden: string[] };
export type AgentView = { id: string; name: string; role: string; symbol: string; allowed: string[]; revoked: boolean };
export type RequestView = {
  id: string; agentId: string; question: string; receivedAt: number;
  status:
    | { kind: 'pending'; offered: string[]; preselected: string[] }
    | { kind: 'shared'; via: 'auto' | 'user'; itemIds: string[]; at: number }
    | { kind: 'denied'; at: number };
};
export type BridgeSnapshot = {
  revision: number;
  connection: 'unpaired' | 'offline' | 'connecting' | 'online';
  relay: string | null;
  spotlight: boolean;
  collections: CollectionView[];
  agents: AgentView[];
  requests: RequestView[];
};

declare class PufferCoreModule extends NativeModule<{ changed: (e: { indexRevision: number; bridgeRevision: number }) => void }> {
  listItems(): Promise<Item[]>;
  hasItem(id: string): Promise<boolean>;
  addItem(item: Omit<Item, 'thumbUri'> & { kind: Kind }, thumbName: string | null, vec: number[]): Promise<void>;
  clearIndex(): Promise<void>;
  search(args: SearchArgs): Promise<SearchHits>;

  snapshot(): Promise<BridgeSnapshot>;
  saveCollection(c: Omit<CollectionView, 'hidden'>): Promise<void>;
  removeCollection(id: string): Promise<void>;
  hideInCollection(id: string, itemId: string): Promise<void>;
  allow(agentId: string, collectionId: string, allowed: boolean): Promise<void>;

  pair(relayUrl: string, code: string): Promise<void>;
  createAgent(name: string, role: string, symbol: string): Promise<{ agent: AgentView; token: string; mcpCommand: string }>;
  revokeAgent(id: string): Promise<void>;
  approve(requestId: string, itemIds: string[], imageIds: string[]): Promise<void>;
  deny(requestId: string): Promise<void>;
  setSpotlight(on: boolean): Promise<void>;
}

const native = requireOptionalNativeModule<PufferCoreModule>('PufferCore');
export default function puffer(): PufferCoreModule {
  if (!native) throw new Error('PufferCore is iOS only. Build with `npx expo run:ios`.');
  return native;
}
