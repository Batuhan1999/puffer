// src/bridge.tsx
// React view of Bridge state. Replaces the collections, agents and requests slices of
// src/ui/preview.tsx (which keeps only prefs, recents and timings). No reducer: the native Bridge is
// the single owner, and this provider re-reads its snapshot when an onChange event names a slice.

import type { ReactNode } from 'react';

import type { Item } from '@/domain';
import type {
  Agent,
  AgentCredential,
  AgentRequest,
  BridgeSnapshot,
  Collection,
  PolicyEdit,
  UserDecision,
} from '../../modules/puffer-native/src';

type BridgeView = BridgeSnapshot & {
  edit(edit: PolicyEdit): Promise<void>;
  connectAgent(name: string): Promise<AgentCredential>;
  pair(link: string): Promise<void>;
  unpair(): Promise<void>;
};

/** Subscribes to 'policy', 'requests' and 'relay' changes. Mounted inside PufferProvider in src/app/_layout.tsx. */
export function BridgeProvider({ children }: { children: ReactNode }): ReactNode {
  throw new Error('not implemented');
}

export function useBridge(): BridgeView {
  throw new Error('not implemented');
}

/** Review screen data. `decide` only accepts ids from the frozen candidates; native re-checks. */
export function useAgentRequest(id: string): {
  request: AgentRequest | undefined;
  agent: Agent | undefined;
  decide(decision: UserDecision): Promise<void>;
} {
  throw new Error('not implemented');
}

/**
 * Collection screen data. Members come from bridge.members(id): canonical search minus hidden,
 * the same function triage uses. Refetched on 'items' and 'policy' changes, not on prefs.
 */
export function useCollection(id: string): {
  collection: Collection | undefined;
  members: readonly Item[] | null;
  grantedTo: readonly Agent[];
  edit(edit: PolicyEdit): Promise<void>;
} {
  throw new Error('not implemented');
}

/** Badge count for the Agents tab and the in-app "<Agent> asks" banner. */
export function awaitingUser(requests: readonly AgentRequest[]): readonly AgentRequest[] {
  throw new Error('not implemented');
}
