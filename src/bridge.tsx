// React view of the native Bridge: agents, History and the relay link. Bridge owns the state; this provider re-reads its
// snapshot when a change event names a slice.
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

import {
  type AgentRequest,
  bridge,
  type BridgeSnapshot,
  type ChangeRead,
  onChange,
  type PendingConnect,
} from '../modules/puffer-native/src';
import { errorText } from './store';

export type {
  Agent,
  AgentRequest,
  ChangeRead,
  PendingConnect,
  RelayStatus,
  RequestPhase,
} from '../modules/puffer-native/src';

type BridgeView = BridgeSnapshot & {
  loaded: boolean;
  disconnect(agentId: string): Promise<void>;
  pair(link: string): Promise<void>;
  unpair(): Promise<void>;
  approveConnect(connect: PendingConnect): Promise<string>;
  openConnectLink(connectId: string, secret: string): Promise<void>;
  declineConnect(connectId: string): Promise<void>;
};

const EMPTY: BridgeSnapshot = { relay: { kind: 'unpaired' }, agents: [], requests: [], connects: [], reads: [] };
const BridgeContext = createContext<BridgeView | null>(null);

/** Refetches on every change except item writes. */
export function BridgeProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      bridge.snapshot().then(
        (next) => alive && setSnapshot(next),
        (e) => console.warn('bridge snapshot failed', errorText(e)),
      );
    const unsubscribe = onChange(({ topic }) => topic !== 'items' && topic !== 'notes' && refresh());
    refresh();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const value: BridgeView = {
    ...(snapshot ?? EMPTY),
    loaded: snapshot !== null,
    disconnect: bridge.disconnect,
    pair: bridge.pair,
    unpair: bridge.unpair,
    approveConnect: bridge.approveConnect,
    openConnectLink: bridge.openConnectLink,
    declineConnect: bridge.declineConnect,
  };
  return <BridgeContext value={value}>{children}</BridgeContext>;
}

export function useBridge(): BridgeView {
  const view = useContext(BridgeContext);
  if (!view) throw new Error('useBridge must be used inside <BridgeProvider>');
  return view;
}

export type HistoryEntry =
  | { kind: 'request'; at: number; request: AgentRequest }
  | { kind: 'read'; at: number; read: ChangeRead };

/** Requests and change reads in one list, newest first. */
export function historyOf(requests: readonly AgentRequest[], reads: readonly ChangeRead[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    ...requests.map((request) => ({ kind: 'request' as const, at: request.receivedAt, request })),
    ...reads.map((read) => ({ kind: 'read' as const, at: read.at, read })),
  ];
  return entries.sort((a, b) => b.at - a.at);
}

/** When the agent last read or wrote anything, or when it connected. */
export function lastActivity(agentId: string, connectedAt: number, view: Pick<BridgeSnapshot, 'requests' | 'reads'>) {
  let at = connectedAt;
  for (const request of view.requests) if (request.agentId === agentId && request.receivedAt > at) at = request.receivedAt;
  for (const read of view.reads) if (read.agentId === agentId && read.at > at) at = read.at;
  return at;
}
