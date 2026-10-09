import { type Note, notes, noteEditor } from '../../../modules/puffer-native/src';
import { normalize } from './markdown';
import type { EditorLoad } from './types';

const SAVE_DELAY = 600;

/**
 * One open note in the Tiptap editor: NoteSession.swift's save loop with the editor's Markdown pushed in. Saves run one
 * at a time with the version the editor last loaded or wrote as base. When an agent wrote in between, its body is merged
 * with the user's edits (native NoteMerge; common base: what this editor last loaded or wrote), the merge is shown and
 * saved, so neither side's change is lost.
 */
export class NoteSaver {
  readonly id: string;
  /** The editor's Markdown, as of its last change. */
  latest = '';
  private base = '';
  private baseVersion = 0;
  private seq = 0;
  /** Loads that set the base on arrival (opening, an agent's write), with the version they show. */
  private baseLoads = new Map<number, number>();
  private acked = -1;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private show: (load: EditorLoad) => void;
  private onNote: (note: Note) => void;

  constructor(id: string, show: (load: EditorLoad) => void, onNote: (note: Note) => void) {
    this.id = id;
    this.show = show;
    this.onNote = onNote;
  }

  /** Loads the note into the editor. */
  async open() {
    const note = await notes.get(this.id);
    if (!note) return;
    this.onNote(note);
    this.load(note.body, false, note.version);
  }

  private load(markdown: string, keepSelection: boolean, version: number | null) {
    this.seq += 1;
    if (version !== null) this.baseLoads.set(this.seq, version);
    this.show({ markdown, seq: this.seq, keepSelection });
  }

  /** The editor applied load `seq`; `markdown` is what it holds now. */
  loaded(seq: number, markdown: string) {
    if (seq < this.seq) return;
    if (seq === this.acked) {
      // The WebView reloaded and showed this load again: put the newer edits back.
      if (markdown !== this.latest) this.load(this.latest, false, null);
      return;
    }
    this.acked = seq;
    this.latest = markdown;
    const version = this.baseLoads.get(seq);
    this.baseLoads.delete(seq);
    if (version === undefined) return;
    this.base = markdown;
    this.baseVersion = version;
  }

  changed(markdown: string) {
    this.latest = markdown;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), SAVE_DELAY);
  }

  /** Queues a save behind the running one; resolves when this one has finished. */
  save(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = this.queue.then(() => this.write()).catch((error) => console.warn('note save failed', error));
    return this.queue;
  }

  private async write() {
    if (this.acked === -1) return;
    let body = this.latest;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (body === this.base) return;
      const result = await noteEditor.save(this.id, body, this.baseVersion);
      if (result.kind === 'missing') return;
      if (result.kind === 'written') {
        this.base = body;
        this.baseVersion = result.note.version;
        this.onNote(result.note);
        return;
      }
      // Read again: keystrokes that arrived while the write was in flight belong to the user's side.
      const ours = this.latest;
      const theirs = normalize(result.note.body);
      const merged = noteEditor.merge(this.base, ours, theirs);
      this.base = theirs;
      this.baseVersion = result.note.version;
      this.onNote(result.note);
      if (merged !== ours) {
        this.latest = merged;
        this.load(merged, true, null);
      }
      body = this.latest;
    }
  }

  /** Someone else changed the note: show their version when nothing is unsaved here, else merge through a save. */
  async refresh() {
    await this.queue;
    if (this.acked === -1) return;
    const note = await notes.get(this.id);
    if (!note) return;
    this.onNote(note);
    if (note.version <= this.baseVersion) return;
    if (this.latest === this.base) this.load(note.body, true, note.version);
    else await this.save();
  }

  /** Leaving the note: its last save, then the native close, which deletes a note left empty. */
  async close() {
    await this.save();
    await notes.close(this.id);
  }
}
