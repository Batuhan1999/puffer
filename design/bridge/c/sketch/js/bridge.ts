import type { AgentView, BridgeSnapshot, CollectionView, RequestView } from './puffer-core';

// Replaces the collections, agents and requests slices of src/ui/preview.tsx. Native owns that state because native
// enforces it. This hook is a read model: subscribe to `changed`, refetch `snapshot()`, expose action methods.
// usePreview keeps only UI preferences (prefs, recents, lastTimings). Screens change an import, not their shape.
export type Bridge = BridgeSnapshot & {
  saveCollection(c: Omit<CollectionView, 'hidden'>): void;
  removeCollection(id: string): void;
  hideFromCollection(id: string, itemId: string): void;
  allow(agentId: string, collectionId: string, allowed: boolean): void;
  approve(requestId: string, itemIds: string[], imageIds: string[]): Promise<void>;
  deny(requestId: string): Promise<void>;
  pair(relayUrl: string, code: string): Promise<void>;
  addAgent(name: string): Promise<{ agent: AgentView; token: string; mcpCommand: string }>;
};
export function useBridge(): Bridge { throw new Error('not implemented'); }
export const pendingRequests = (requests: readonly RequestView[]) => requests.filter((r) => r.status.kind === 'pending');
