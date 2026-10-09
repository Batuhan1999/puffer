// React view of the native NoteBook. NoteBook owns the notes; this provider re-reads its snapshot on a `notes` change.
import Storage from 'expo-sqlite/kv-store';
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

import { type NoteFolder, notes, type NoteSummary, type NotesSnapshot, onChange } from '../modules/puffer-native/src';
import { errorText } from './store';

export type { Note, NoteEditor, NoteFolder, NoteSummary } from '../modules/puffer-native/src';
export { notes } from '../modules/puffer-native/src';

/** Built in: the default folder, and the virtual Recently Deleted. */
export const NOTES_FOLDER = 'notes';
export const RECENTLY_DELETED = 'deleted';
export const UNTITLED = 'New Note';

type NotesView = NotesSnapshot & { loaded: boolean };

const EMPTY: NotesSnapshot = { folders: [], notes: [], indexing: null };
const NotesContext = createContext<NotesView | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<NotesSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    let fetching = false;
    let again = false;
    // A burst of writes (an import, typing) refetches once at a time.
    const refresh = async () => {
      if (fetching) return void (again = true);
      fetching = true;
      try {
        do {
          again = false;
          const next = await notes.snapshot();
          if (alive) setSnapshot(next);
        } while (again && alive);
      } catch (e) {
        console.warn('notes snapshot failed', errorText(e));
      } finally {
        fetching = false;
      }
    };
    const unsubscribe = onChange(({ topic }) => topic === 'notes' && refresh());
    refresh();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return <NotesContext value={{ ...(snapshot ?? EMPTY), loaded: snapshot !== null }}>{children}</NotesContext>;
}

export function useNotes(): NotesView {
  const view = useContext(NotesContext);
  if (!view) throw new Error('useNotes must be used inside <NotesProvider>');
  return view;
}

/** The notes a folder screen lists: a folder's live notes, or every note in Recently Deleted. Unordered. */
export function notesIn(all: readonly NoteSummary[], folderId: string): NoteSummary[] {
  return folderId === RECENTLY_DELETED
    ? all.filter((n) => n.deletedAt !== null)
    : all.filter((n) => n.deletedAt === null && n.folderId === folderId);
}

export function folderName(folders: readonly NoteFolder[], folderId: string) {
  if (folderId === RECENTLY_DELETED) return 'Recently Deleted';
  return folders.find((f) => f.id === folderId)?.name ?? 'Notes';
}

export type SortKey = 'edited' | 'created' | 'title';
/** How a notes list is ordered and grouped, as Apple Notes' View Options. */
export type ListStyle = { sort: SortKey; groupByDate: boolean };
export const DEFAULT_LIST_STYLE: ListStyle = { sort: 'edited', groupByDate: true };
export const SORT_KEYS: readonly { key: SortKey; label: string }[] = [
  { key: 'edited', label: 'Date Edited' },
  { key: 'created', label: 'Date Created' },
  { key: 'title', label: 'Title' },
];

/** A folder's own choices. A missing key follows DEFAULT_LIST_STYLE, which the Sort By menu calls Default. */
export type ListStyleChoice = Partial<ListStyle>;

/** The date a row shows and date groups use: the one the list sorts by (Date Edited for a title sort). */
export function dateOf(note: NoteSummary, sort: SortKey) {
  return sort === 'created' ? note.createdAt : note.modifiedAt;
}

export function sortNotes(list: readonly NoteSummary[], sort: SortKey): NoteSummary[] {
  if (sort === 'title') {
    const title = (n: NoteSummary) => n.title || UNTITLED;
    return [...list].sort((a, b) => title(a).localeCompare(title(b), undefined, { sensitivity: 'base', numeric: true }));
  }
  return [...list].sort((a, b) => dateOf(b, sort) - dateOf(a, sort));
}

/** Apple Notes' date groups: Today, Yesterday, Previous 7 Days, Previous 30 Days, months of this year, then years. */
export function dateGroup(at: number, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const date = new Date(at);
  if (at >= today) return 'Today';
  if (at >= today - day) return 'Yesterday';
  if (at >= today - 7 * day) return 'Previous 7 Days';
  if (at >= today - 30 * day) return 'Previous 30 Days';
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: 'long' });
  return String(date.getFullYear());
}

/** `title` is '' for the one untitled section of an ungrouped list without pinned notes. */
export type NoteSection = { title: string; notes: NoteSummary[] };

/** Pinned first, then date groups, or one Notes section when grouping is off or the list sorts by title. */
export function sectionsOf(list: readonly NoteSummary[], style: ListStyle, now = new Date()): NoteSection[] {
  const sorted = sortNotes(list, style.sort);
  const pinned = sorted.filter((n) => n.pinned);
  const rest = sorted.filter((n) => !n.pinned);
  const sections: NoteSection[] = pinned.length ? [{ title: 'Pinned', notes: pinned }] : [];
  if (!style.groupByDate || style.sort === 'title') {
    if (rest.length) sections.push({ title: pinned.length ? 'Notes' : '', notes: rest });
    return sections;
  }
  for (const note of rest) {
    const title = dateGroup(dateOf(note, style.sort), now);
    const last = sections[sections.length - 1];
    if (last?.title === title) last.notes.push(note);
    else sections.push({ title, notes: [note] });
  }
  return sections;
}

const listStyleKey = (folderId: string) => `puffer.listStyle.${folderId}`;

function parseChoice(raw: string | null): ListStyleChoice {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return {};
    const { sort, groupByDate } = value as Record<string, unknown>;
    const choice: ListStyleChoice = {};
    if (SORT_KEYS.some((s) => s.key === sort)) choice.sort = sort as SortKey;
    if (typeof groupByDate === 'boolean') choice.groupByDate = groupByDate;
    return choice;
  } catch {
    return {};
  }
}

/** A folder's list style, kept per folder on this iPhone. */
export function useListStyle(folderId: string) {
  const [choice, setChoice] = useState(() => parseChoice(Storage.getItemSync(listStyleKey(folderId))));
  const choose = (next: ListStyleChoice) => {
    Storage.setItemSync(listStyleKey(folderId), JSON.stringify(next));
    setChoice(next);
  };
  const style = useMemo<ListStyle>(() => ({ ...DEFAULT_LIST_STYLE, ...choice }), [choice]);
  return { choice, style, choose };
}

/** As a note row shows its date: the time today, Yesterday, the weekday this week, else the short date. */
export function rowDate(at: number, now = new Date()) {
  const date = new Date(at);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (at >= today) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at >= today - day) return 'Yesterday';
  if (at >= today - 6 * day) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' });
}

/**
 * Notes matching `query`, best first: Puffer's meaning search when the model is ready, else title and text containing
 * it. `scope` keeps one folder's notes. null while nothing is asked.
 */
export function useNoteSearch(query: string, ready: boolean, all: readonly NoteSummary[], scope?: string) {
  const [matches, setMatches] = useState<{ noteId: string; snippet: string }[] | null>(null);
  const text = query.trim();

  useEffect(() => {
    if (!text || !ready) {
      setMatches(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      notes.search(text).then(
        (found) => alive && setMatches(found),
        () => alive && setMatches(null),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text, ready]);

  return useMemo(() => {
    if (!text) return null;
    const live = all.filter((n) => n.deletedAt === null && (scope === undefined || n.folderId === scope));
    const byId = new Map(live.map((n) => [n.id, n]));
    const lower = text.toLowerCase();
    const literal = live.filter((n) => n.title.toLowerCase().includes(lower) || n.preview.toLowerCase().includes(lower));
    const meaning = (matches ?? []).flatMap((m) => {
      const note = byId.get(m.noteId);
      return note ? [{ note, snippet: m.snippet }] : [];
    });
    const seen = new Set(meaning.map((m) => m.note.id));
    return [...meaning, ...literal.filter((n) => !seen.has(n.id)).map((note) => ({ note, snippet: note.preview }))];
  }, [text, matches, all, scope]);
}
