import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import {
  engine,
  type EngineStatus,
  type Folder,
  folders as folderStore,
  type IndexProgress,
  onChange,
  onIndexProgress,
  type SourcesSummary,
} from '../modules/puffer-native/src';
import { downloadModel, isModelDownloaded, MODEL_BYTES, ModelState } from './model';

export type { IndexProgress, Tally } from '../modules/puffer-native/src';

export type Notice = { id: number; text: string; tone: 'info' | 'error' };

/** The search model, the granted folders and the notices shown in the tab accessory. */
export type Store = {
  model: ModelState;
  ready: boolean;
  folders: Folder[];
  /** A folder check the user started is running. */
  checking: boolean;
  notice: Notice | null;
  dismissNotice(): void;
  downloadModel(): Promise<void>;
  retryModel(): Promise<void>;
  addFolder(): Promise<Folder | null>;
  removeFolder(folder: Folder): void;
  rescanFolders(): Promise<void>;
};

const StoreContext = createContext<Store | null>(null);
/** Separate from the store so progress, which arrives several times a second, re-renders only its readers. */
const IndexingContext = createContext<IndexProgress | null>(null);
const PROGRESS_EVERY_MS = 1_000;

function modelState({ model }: EngineStatus): ModelState {
  return model.phase === 'ready' ? { phase: 'ready', backend: model.backend, loadMs: model.loadMs } : model;
}

export function PufferProvider({ children }: { children: ReactNode }) {
  const [model, setModel] = useState<ModelState>({ phase: 'checking' });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const ready = model.phase === 'ready';
  const phase = useRef(model.phase);
  phase.current = model.phase;

  const say = useCallback(
    (text: string, tone: Notice['tone'] = 'info') => setNotice({ id: Date.now(), text, tone }),
    [],
  );

  const load = useCallback(async () => {
    setModel({ phase: 'loading' });
    try {
      setModel(modelState(await engine.start()));
    } catch (e) {
      setModel({ phase: 'error', message: errorText(e) });
    }
  }, []);

  const download = useCallback(async () => {
    setModel({ phase: 'downloading', written: 0, total: MODEL_BYTES });
    try {
      await downloadModel((written, total) => setModel({ phase: 'downloading', written, total }));
    } catch (e) {
      setModel({ phase: 'error', message: errorText(e) });
      return;
    }
    await load();
    engine.syncSources().catch((e) => say(errorText(e), 'error'));
  }, [load, say]);

  const refreshFolders = useCallback(() => folderStore.list().then(setFolders, () => setFolders([])), []);

  useEffect(() => {
    // Files opened in Puffer from other apps can arrive before this mounts, so receipts wait natively until read.
    const showReceipts = () =>
      engine.takeShareReceipts().then((receipts) => {
        if (receipts.length) say(receipts.length === 1 ? receipts[0] : `${receipts[0]}, and ${receipts.length - 1} more`);
      });
    const unsubscribe = onChange(({ topic }) => {
      if (topic === 'shared') showReceipts();
    });
    showReceipts();
    // A Shortcut launches Puffer in the background, where the model must not load; the next foreground loads it.
    if (isModelDownloaded()) {
      if (AppState.currentState !== 'background') load();
    } else setModel({ phase: 'absent' });
    refreshFolders();
    return unsubscribe;
  }, [load, refreshFolders, say]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const busy = phase.current === 'ready' || phase.current === 'loading' || phase.current === 'downloading';
      if (state === 'active' && !busy && isModelDownloaded()) load();
    });
    return () => subscription.remove();
  }, [load]);

  const rescanFolders = async () => {
    if (checking) return;
    if (!ready) return say('The search model is not ready yet', 'error');
    setChecking(true);
    try {
      say(sourcesSummary(await engine.syncSources()));
    } catch (e) {
      say(errorText(e), 'error');
    } finally {
      setChecking(false);
    }
  };

  const store: Store = {
    model,
    ready,
    folders,
    checking,
    notice,
    dismissNotice: () => setNotice(null),
    downloadModel: download,
    retryModel: () => (isModelDownloaded() ? load() : download()),
    addFolder: async () => {
      const folder = await folderStore.pick();
      if (!folder) return null;
      await refreshFolders();
      if (ready) await rescanFolders();
      return folder;
    },
    removeFolder: (folder: Folder) =>
      Alert.alert(`Remove ${folder.name}?`, 'Puffer forgets its documents. The files themselves stay where they are.', [
        { text: 'Cancel', style: 'cancel', onPress: () => void refreshFolders() },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void folderStore.remove(folder.id).then(refreshFolders, (e) => say(errorText(e), 'error')),
        },
      ]),
    rescanFolders,
  };

  return (
    <StoreContext.Provider value={store}>
      <IndexingProvider>{children}</IndexingProvider>
    </StoreContext.Provider>
  );
}

/** Holds indexing progress at most once a second. Its children are the same elements on every update, so only
 * `useIndexing` readers re-render. */
function IndexingProvider({ children }: { children: ReactNode }) {
  const [indexing, setIndexing] = useState<IndexProgress | null>(null);
  useEffect(() => {
    let latest: IndexProgress | null = null;
    let shown = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const take = (p: IndexProgress) => {
      latest = p;
      if (pending) return;
      pending = setTimeout(
        () => {
          pending = null;
          shown = Date.now();
          setIndexing(latest);
        },
        Math.max(0, shown + PROGRESS_EVERY_MS - Date.now()),
      );
    };
    const unsubscribe = onIndexProgress(take);
    engine.indexProgress().then(take, () => {});
    return () => {
      unsubscribe();
      if (pending) clearTimeout(pending);
    };
  }, []);
  return <IndexingContext.Provider value={indexing}>{children}</IndexingContext.Provider>;
}

/** null until native answers once. */
export function useIndexing(): IndexProgress | null {
  return useContext(IndexingContext);
}

export function usePuffer(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('usePuffer must be used inside <PufferProvider>');
  return store;
}

function sourcesSummary({ files, updated, removed, failed }: SourcesSummary) {
  const parts = [
    files ? `${files} new file${files === 1 ? '' : 's'}` : '',
    updated ? `${updated} changed` : '',
    removed ? `${removed} removed` : '',
  ].filter(Boolean);
  return `${parts.length ? parts.join(', ') : 'Everything is up to date'}${failed ? `, ${failed} skipped` : ''}`;
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
