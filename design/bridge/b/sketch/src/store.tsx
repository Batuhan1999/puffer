import { createContext, ReactNode, useContext } from 'react';

import type {
  Collection,
  Folder,
  Item,
  Kind,
  Query,
  SearchOptions,
  SearchResult,
} from '../modules/puffer-core/src/PufferCoreModule';
import type { ModelState } from './model';

// `store.tsx` after the move. The same `Store` contract screens already use, minus everything the native engine
// now owns. `src/puffer.ts` and `src/library.ts` are deleted; `src/model.ts` keeps download/isDownloaded only.
// `useSearch` is unchanged in shape: it calls `store.search`, which is now one native call.

export type JobKind = 'photos' | 'documents' | 'folders';
export type Job = { kind: 'idle' } | { kind: JobKind; progress: { done: number; total: number; failed: number } };
export type Notice = { id: number; text: string; tone: 'info' | 'error' };

export type Store = {
  model: ModelState;
  ready: boolean;
  items: readonly Item[];
  counts: Readonly<Record<Kind, number>>;
  collections: readonly Collection[];
  folders: Folder[];
  job: Job;
  notice: Notice | null;
  dismissNotice(): void;
  downloadModel(): Promise<void>;
  retryModel(): Promise<void>;
  indexPhotos(): Promise<void>;
  addDocuments(): Promise<void>;
  addFolder(): Promise<void>;
  rescanFolders(): Promise<void>;
  cancelJob(): void;
  clearIndex(): Promise<void>;
  search(query: Query, options: SearchOptions): Promise<SearchResult>;
  saveCollection(collection: Omit<Collection, 'hidden'>): Promise<void>;
  removeCollection(id: string): Promise<void>;
  hideFromCollection(id: string, itemId: string): Promise<void>;
};

const StoreContext = createContext<Store | null>(null);

export function PufferProvider({ children }: { children: ReactNode }) {
  // items/counts/collections are read from the engine and refreshed on `onChange`; no `revision` counter.
  // `onOpenItem` and `takePendingOpen()` on mount route to `/item/[id]`.
  throw new Error('not implemented');
}

export function usePuffer(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('usePuffer must be used inside <PufferProvider>');
  return store;
}

export function useSearch(query: Query | null, options: SearchOptions) {
  throw new Error('not implemented');
}
