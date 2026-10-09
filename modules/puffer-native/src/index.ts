// The only JS file that touches the native module. No function here returns or accepts a vector.
import { NativeModule, requireNativeView, requireOptionalNativeModule } from 'expo';
import type { Ref } from 'react';
import type { ViewProps } from 'react-native';

export type Topic = 'items' | 'policy' | 'requests' | 'relay' | 'shared' | 'notes';
export type TopicEvent = { topic: Topic };

export type EngineStatus = {
  model:
    | { phase: 'absent' }
    | { phase: 'loading' }
    | { phase: 'ready'; backend: string; loadMs: number }
    | { phase: 'error'; message: string };
  counts: { passage: number; note: number };
  revision: number;
};

/** Where file indexing stands, from Sources.swift. Arrives through `onIndexProgress` a few times a second while reading. */
export type IndexPhase =
  | { kind: 'idle' }
  | { kind: 'waitingForModel' }
  | { kind: 'readingFiles' }
  /** Left the foreground mid-run. Opening Puffer resumes it; so does charging, in the background. */
  | { kind: 'paused'; until: 'foreground' | 'charging' };

/** `failed` files are retried on the next run. */
export type Tally = { done: number; total: number; failed: number };

export type IndexProgress = { phase: IndexPhase; files: Tally };

export type SourcesSummary = { files: number; updated: number; removed: number; failed: number };

export type Folder = { id: string; name: string };

// Notes, mirrored from Notes.swift.

export type NoteEditor = { kind: 'user' } | { kind: 'agent'; agentId: string; name: string };

export type NoteSummary = {
  id: string;
  folderId: string;
  /** The first line without Markdown marks; '' for an empty note. */
  title: string;
  /** The text after the title, flattened. */
  preview: string;
  pinned: boolean;
  createdAt: number;
  modifiedAt: number;
  version: number;
  lastEditor: NoteEditor;
  /** Set while the note is in Recently Deleted. */
  deletedAt: number | null;
};

export type Note = NoteSummary & { body: string };

export type NoteFolder = { id: string; name: string; count: number };

export type NotesSnapshot = {
  folders: NoteFolder[];
  notes: NoteSummary[];
  /** Notes being made searchable, while it runs. */
  indexing: { done: number; total: number } | null;
};

export type NoteMatch = { noteId: string; snippet: string };

// Agents and History, mirrored from Bridge.swift.

export type Agent = { id: string; name: string; connectedAt: number };

export type RequestPhase =
  | { kind: 'received' }
  | { kind: 'shared'; at: number; titles: string[] }
  | {
      kind: 'note';
      at: number;
      result:
        | { kind: 'notes'; titles: string[] }
        | { kind: 'folders'; count: number }
        | { kind: 'note'; noteId: string; title: string }
        | { kind: 'conflict'; currentVersion: number };
    }
  | { kind: 'nothingFound'; at: number }
  | { kind: 'denied'; reason: 'user' | 'expired' | 'agentRevoked'; at: number }
  /** The phone could not run the request; the agent was told `reason`. */
  | { kind: 'failed'; reason: string; at: number };

export type AgentRequest = {
  id: string;
  agentId: string;
  agentName: string;
  /** The question, or what a listing or note request did. */
  question: string;
  receivedAt: number;
  phase: RequestPhase;
  /** A note request that writes. */
  writes: boolean;
  /** The relay acknowledged the current phase. */
  delivered: boolean;
  /** A note write an agent made while the phone was offline: when the relay queued it (ms). Null for every other request. */
  queuedAt: number | null;
};

export type RelayStatus =
  | { kind: 'unpaired' }
  /** No relay yet and no account session: Puffer registers with the relay once the user signs in. */
  | { kind: 'signedOut' }
  | { kind: 'paired'; url: string; lastContact: number | null; lastError: string | null };

/**
 * Where a connection request came from. `oauth`: the app's own browser page shows the approve link as a QR code.
 * `link`: an agent sent the user the approve link.
 */
export type ConnectOrigin =
  | { kind: 'oauth'; clientHost: string | null; redirectHost: string }
  | { kind: 'link' };

/** A client waiting to connect through the relay. Listed only once Puffer was opened through its approve link. */
export type PendingConnect = {
  id: string;
  clientName: string;
  origin: ConnectOrigin;
  /** Fingerprint of the key the relay holds. Approval is bound to the one shown. */
  keyDigest: string;
  requestedAt: number;
  expiresAt: number;
};

/** One get_puffer_changes read, for History. */
export type ChangeRead = {
  id: string;
  agentId: string;
  agentName: string;
  at: number;
  outcome:
    | { kind: 'answered'; shown: number }
    /** Served by the relay from a page Puffer sent ahead, while Puffer was not running. */
    | { kind: 'servedFromPage'; shown: number }
    | { kind: 'rateLimited' };
};

export type BridgeSnapshot = {
  relay: RelayStatus;
  agents: readonly Agent[];
  /** Newest first. */
  requests: readonly AgentRequest[];
  /** Oldest first. */
  connects: readonly PendingConnect[];
  /** Newest first. */
  reads: readonly ChangeRead[];
};

declare class PufferNativeModule extends NativeModule<{
  onChange(event: TopicEvent): void;
  onIndexProgress(progress: IndexProgress): void;
}> {
  readonly modelPath: string;
  start(): Promise<EngineStatus>;
  status(): Promise<EngineStatus>;
  syncSources(): Promise<SourcesSummary>;
  indexProgress(): Promise<IndexProgress>;
  takeShareReceipts(): Promise<string[]>;
  notesSnapshot(): Promise<NotesSnapshot>;
  note(id: string): Promise<Note | null>;
  createNote(body: string, folderId: string | null): Promise<Note>;
  setNotePinned(id: string, pinned: boolean): Promise<void>;
  moveNote(id: string, folderId: string): Promise<void>;
  deleteNote(id: string): Promise<void>;
  restoreNote(id: string): Promise<void>;
  purgeNotes(ids: string[]): Promise<void>;
  createNoteFolder(name: string): Promise<NoteFolder>;
  renameNoteFolder(id: string, name: string): Promise<void>;
  deleteNoteFolder(id: string): Promise<void>;
  searchNotes(text: string): Promise<NoteMatch[]>;
  snapshot(): Promise<BridgeSnapshot>;
  disconnectAgent(agentId: string): Promise<void>;
  approveConnect(connectId: string, keyDigest: string): Promise<string>;
  openConnectLink(connectId: string, secret: string): Promise<void>;
  declineConnect(connectId: string): Promise<void>;
  pair(link: string): Promise<void>;
  unpair(): Promise<void>;
  /** A new device key from the relay; the old one stops working at once. Agents stay connected. */
  rotateDeviceKey(): Promise<void>;
  /** Deletes this iPhone's data on the relay, then forgets the relay and removes every agent here. */
  deleteRelayData(): Promise<void>;
  setRelaySession(token: string | null): Promise<void>;
  pickFolder(): Promise<Folder | null>;
  listFolders(): Promise<Folder[]>;
  removeFolder(id: string): Promise<void>;
}

const native = requireOptionalNativeModule<PufferNativeModule>('Puffer');

function module(): PufferNativeModule {
  if (!native) throw new Error('Puffer is iOS only. Build with `npx expo run:ios`.');
  return native;
}

export const engine = {
  modelPath: () => module().modelPath,
  /** Opens the store and loads the model if its file exists. Idempotent; shared with intents and background wakes. */
  start: () => module().start(),
  status: () => module().status(),
  /** New, changed and removed folder files, then notes. Native also runs this on launch, foreground and refresh. */
  syncSources: () => module().syncSources(),
  indexProgress: () => module().indexProgress(),
  /** Confirmations for shared files not shown yet. Draining; a `shared` change says there are more. */
  takeShareReceipts: () => module().takeShareReceipts(),
};

export const notes = {
  snapshot: () => module().notesSnapshot(),
  get: (id: string) => module().note(id),
  create: (body: string, folderId: string | null) => module().createNote(body, folderId),
  /** Leaving a note: waits for the editor's last save, then deletes the note for good if it is empty. */
  close: (id: string) => editor?.closeNote(id) ?? Promise.resolve(),
  setPinned: (id: string, pinned: boolean) => module().setNotePinned(id, pinned),
  move: (id: string, folderId: string) => module().moveNote(id, folderId),
  /** To Recently Deleted. */
  remove: (id: string) => module().deleteNote(id),
  restore: (id: string) => module().restoreNote(id),
  /** Deletes for good; only notes in Recently Deleted. */
  purge: (ids: string[]) => module().purgeNotes(ids),
  createFolder: (name: string) => module().createNoteFolder(name),
  renameFolder: (id: string, name: string) => module().renameNoteFolder(id, name),
  removeFolder: (id: string) => module().deleteNoteFolder(id),
  /** Meaning search over notes, best first. Needs the model. */
  search: (text: string) => module().searchNotes(text),
};

export const bridge = {
  snapshot: () => module().snapshot(),
  disconnect: (agentId: string) => module().disconnectAgent(agentId),
  /**
   * Sends the secret of the approve link Puffer was opened with to the relay and, when it matches, adds the connecting
   * app as an agent; resolves to its agent id.
   */
  approveConnect: (connect: PendingConnect) => module().approveConnect(connect.id, connect.keyDigest),
  /** Puffer was opened through an approve link: fetches that connection and keeps the secret approval presents. */
  openConnectLink: (connectId: string, secret: string) => module().openConnectLink(connectId, secret),
  declineConnect: (connectId: string) => module().declineConnect(connectId),
  pair: (link: string) => module().pair(link),
  unpair: () => module().unpair(),
  rotateDeviceKey: () => module().rotateDeviceKey(),
  deleteRelayData: () => module().deleteRelayData(),
  /**
   * The signed-in account's session token (src/auth.ts), or null on sign-out. Native keeps it in the Keychain and sends it
   * as `Authorization: Bearer` to register this iPhone; without it Puffer does not register. Same token again: no-op.
   */
  setRelaySession: (token: string | null) => module().setRelaySession(token),
};

export const folders = {
  pick: () => module().pickFolder(),
  /** Granted locations to show. A folder inside another granted folder is not listed again. */
  list: () => module().listFolders(),
  /** Forgets the grant and every item Puffer indexed from it. The files stay where they are. */
  remove: (id: string) => module().removeFolder(id),
};

// The note editors: the native view (modules/puffer-native/ios/Editor), which loads and saves the note itself, and
// `noteEditor`, the native half of the Tiptap editor (src/ui/editor).

export type AttachmentSource = 'photos' | 'camera' | 'scan' | 'files' | 'drawing';
export type ShareFormat = 'text' | 'markdown' | 'pdf' | 'print';
export type PaperStyle = 'none' | 'linesSmall' | 'linesLarge' | 'gridSmall' | 'gridLarge';

/** Commands on a mounted editor, through its ref. */
export type NoteEditorHandle = {
  finishEditing(): Promise<void>;
  find(): Promise<void>;
  share(format: ShareFormat): Promise<void>;
  copyNote(): Promise<void>;
  moveCheckedToBottom(): Promise<void>;
  uncheckAll(): Promise<void>;
  /** A checklist line, at the end of the note when not editing. */
  toggleChecklist(): Promise<void>;
  insertTable(): Promise<void>;
  attach(source: AttachmentSource): Promise<void>;
  setPaper(paper: PaperStyle): Promise<void>;
};

export type NoteEditorProps = ViewProps & {
  noteId: string;
  ref?: Ref<NoteEditorHandle>;
  onEditingChange?: (event: { nativeEvent: { editing: boolean } }) => void;
  /** A tap on a link to another note. */
  onOpenNote?: (event: { nativeEvent: { noteId: string } }) => void;
};

export const NoteEditorView = requireNativeView<NoteEditorProps>('PufferEditor');

export type NoteSave = { kind: 'written'; note: Note } | { kind: 'conflict'; note: Note } | { kind: 'missing' };
export type AttachmentFile = { name: string; file: string };
export type AttachmentPreviewData =
  | { kind: 'image'; src: string }
  | { kind: 'card'; title: string; subtitle: string; thumbnail: string | null; symbol: 'pdf' | 'file' | 'missing' };

declare class PufferEditorModule extends NativeModule<{
  onAttachmentsAdded(event: { noteId: string; attachments: AttachmentFile[] }): void;
  onAttachmentChanged(event: { noteId: string; file: string }): void;
}> {
  closeNote(id: string): Promise<void>;
  saveNote(id: string, body: string, baseVersion: number): Promise<NoteSave>;
  mergeNote(base: string, ours: string, theirs: string): string;
  attachmentPreview(noteId: string, file: string, name: string, width: number): Promise<AttachmentPreviewData>;
  attach(noteId: string, kind: AttachmentSource): Promise<void>;
  openAttachment(noteId: string, file: string, name: string): Promise<void>;
  saveAttachment(noteId: string, base64: string, ext: string, name: string): Promise<AttachmentFile>;
  pickNoteLink(excludingId: string): Promise<{ id: string; title: string } | null>;
  shareNote(noteId: string, kind: ShareFormat, markdown: string): Promise<void>;
  copyNote(markdown: string): Promise<void>;
  notePaper(noteId: string): PaperStyle;
  setNotePaper(noteId: string, paper: PaperStyle): void;
}

const editor = requireOptionalNativeModule<PufferEditorModule>('PufferEditor');

function editorModule(): PufferEditorModule {
  if (!editor) throw new Error('Puffer is iOS only. Build with `npx expo run:ios`.');
  return editor;
}

/** What the Tiptap editor (src/ui/editor) needs from native. The native editor view does all of this itself. */
export const noteEditor = {
  /** One save with `baseVersion` as base; `conflict` carries the newer note. */
  save: (id: string, body: string, baseVersion: number) => editorModule().saveNote(id, body, baseVersion),
  /** Three-way line merge (NoteMerge): both sides survive, the agent's lines first where they touch. */
  merge: (base: string, ours: string, theirs: string) => editorModule().mergeNote(base, ours, theirs),
  attachmentPreview: (noteId: string, ref: AttachmentFile, width: number) => editorModule().attachmentPreview(noteId, ref.file, ref.name, width),
  attach: (noteId: string, kind: AttachmentSource) => editorModule().attach(noteId, kind),
  openAttachment: (noteId: string, ref: AttachmentFile) => editorModule().openAttachment(noteId, ref.file, ref.name),
  saveAttachment: (noteId: string, base64: string, ext: string, name: string) => editorModule().saveAttachment(noteId, base64, ext, name),
  pickNoteLink: (excludingId: string) => editorModule().pickNoteLink(excludingId),
  share: (noteId: string, kind: ShareFormat, markdown: string) => editorModule().shareNote(noteId, kind, markdown),
  copy: (markdown: string) => editorModule().copyNote(markdown),
  paper: (noteId: string) => editorModule().notePaper(noteId),
  setPaper: (noteId: string, paper: PaperStyle) => editorModule().setNotePaper(noteId, paper),
  onAttachmentsAdded(listener: (event: { noteId: string; attachments: AttachmentFile[] }) => void): () => void {
    const subscription = editorModule().addListener('onAttachmentsAdded', listener);
    return () => subscription.remove();
  },
  onAttachmentChanged(listener: (event: { noteId: string; file: string }) => void): () => void {
    const subscription = editorModule().addListener('onAttachmentChanged', listener);
    return () => subscription.remove();
  },
};

export function onChange(listener: (event: TopicEvent) => void): () => void {
  const subscription = module().addListener('onChange', listener);
  return () => subscription.remove();
}

export function onIndexProgress(listener: (progress: IndexProgress) => void): () => void {
  const subscription = module().addListener('onIndexProgress', listener);
  return () => subscription.remove();
}
