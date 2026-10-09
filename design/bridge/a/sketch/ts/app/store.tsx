// src/store.tsx after the move. The Store contract that screens use is unchanged; only its backing moves.
//
// Deleted:  src/puffer.ts, src/library.ts, the embed* functions and prompts in src/model.ts,
//           modules/gemma-embed/src/GemmaEmbedModule.ts, expo-sqlite usage for puffer.db.
// Kept:     src/ingest.ts orchestration (media library, folders, image manipulation). It calls
//           engine.addPassages / engine.addImage instead of embedding and calling library.add.
// Changed:  src/model.ts keeps download only, writing to engine.modelPath(); loadModel becomes engine.start().

import type { ReactNode } from 'react';

import type { Dim, Item, Kind, Mode, Query, SearchResult } from './domain';
import type { ModelState } from './model';

export type SearchOptions = { mode: Mode; dim: Dim; rerank: boolean };

export type Store = {
  model: ModelState;
  ready: boolean;
  /** From engine.items(), refetched on onChange('items'). */
  items: readonly Item[];
  counts: Readonly<Record<Kind, number>>;
  // folders, job, notice, downloadModel, retryModel, indexPhotos, addDocuments, addFolder,
  // rescanFolders, cancelJob, clearIndex: same signatures as today
  /** engine.search with the caller's prefs. Consent paths never call this; they use canonical options natively. */
  search(query: Query, options: SearchOptions): Promise<SearchResult>;
};

/**
 * On mount: engine.start() (idempotent, shared with any intent or background wake that got there
 * first), engine.items(), subscribe to onChange('items'). No Library.open, no in-JS index.
 */
export function PufferProvider({ children }: { children: ReactNode }): ReactNode {
  throw new Error('not implemented');
}

export function usePuffer(): Store {
  throw new Error('not implemented');
}

/** Unchanged signature and debounce. Re-runs on onChange('items') instead of items.length. */
export function useSearch(query: Query | null, options: SearchOptions) {
  throw new Error('not implemented');
}
