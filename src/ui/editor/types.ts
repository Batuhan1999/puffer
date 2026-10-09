// What crosses between the React Native host (TiptapNoteView) and the DOM editor (TiptapEditor). Types only, so the
// native bundle does not pull in Tiptap.
import type { AttachmentRef, Highlight } from './markdown';

export type { AttachmentRef, Highlight };

export type BlockStyle = 'title' | 'heading' | 'subheading' | 'body' | 'mono';
export type ListStyle = 'bullet' | 'dash' | 'number' | 'checklist';
export type MarkName = 'bold' | 'italic' | 'underline' | 'strike';
export type TableAction = 'addRowBefore' | 'addRowAfter' | 'addColumnBefore' | 'addColumnAfter' | 'deleteRow' | 'deleteColumn' | 'deleteTable';
export type PaperStyle = 'none' | 'linesSmall' | 'linesLarge' | 'gridSmall' | 'gridLarge';

/** Everything the host asks the editor to do, through the one `run` method on its ref. */
export type EditorCommand =
  | { kind: 'block'; style: BlockStyle }
  | { kind: 'mark'; mark: MarkName }
  | { kind: 'highlight'; color: Highlight | null }
  | { kind: 'list'; list: ListStyle }
  | { kind: 'quote' }
  | { kind: 'indent'; delta: 1 | -1 }
  /** From the bottom toolbar: a checklist line, at the end of the note when not editing. */
  | { kind: 'checklist' }
  | { kind: 'insertTable' }
  | { kind: 'table'; action: TableAction }
  | { kind: 'moveCheckedToBottom' }
  | { kind: 'uncheckAll' }
  | { kind: 'insertAttachments'; refs: AttachmentRef[] }
  /** Selects the next match after the selection, wrapping around. */
  | { kind: 'find'; text: string }
  | { kind: 'focus' }
  | { kind: 'blur' };

/** The selection's formatting, for the Aa panel and the table button. */
export type FormatState = {
  block: BlockStyle;
  list: ListStyle | null;
  quoted: boolean;
  marks: MarkName[];
  highlight: Highlight | null;
  inTable: boolean;
};

/** How an attachment shows in the note. Native reads the file; a WebView cannot. */
export type AttachmentPreview =
  | { kind: 'image'; src: string }
  | { kind: 'card'; title: string; subtitle: string; thumbnail: string | null; symbol: 'pdf' | 'file' | 'missing' };

/** Markdown for the editor to show. A new `seq` replaces the content; `keepSelection` keeps the caret where it was. */
export type EditorLoad = { markdown: string; seq: number; keepSelection: boolean };

/** The note's date line above the text. */
export type EditorHeader = { modifiedAt: number; editedBy: string | null };
