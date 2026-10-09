'use dom';

import './editor.css';

import { Placeholder, Selection } from '@tiptap/extensions';
import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorContent, useEditor } from '@tiptap/react';
import { type DOMImperativeFactory, useDOMImperativeHandle } from 'expo/dom';
import { type Ref, useEffect, useMemo, useRef } from 'react';

import { focusEditor, formatState, markdownOf, runCommand } from './commands';
import { refreshAttachments } from './extensions/attachment';
import { FoldableHeading } from './extensions/foldableHeading';
import { Hashtag } from './extensions/hashtag';
import { NoteLink } from './extensions/noteLink';
import { schemaExtensions } from './extensions/schema';
import { markdownToDoc, parse, toDoc } from './markdown';
import type { AttachmentPreview, AttachmentRef, EditorCommand, EditorHeader, EditorLoad, FormatState, PaperStyle } from './types';

/** Commands arrive as JSON from the host, which types them as EditorCommand (TiptapNoteView `run`). `run` returns true
 * because the host calls it through WKWebView's evaluateJavaScript, which warns about an undefined result. */
export interface TiptapEditorRef extends DOMImperativeFactory {
  run: (command: unknown) => boolean;
}

type Props = {
  ref: Ref<TiptapEditorRef>;
  dom?: import('expo/dom').DOMProps;
  load: EditorLoad;
  editable: boolean;
  paper: PaperStyle;
  header: EditorHeader;
  scheme: 'light' | 'dark';
  /** Bumped when an attachment's file changed (an edited drawing). */
  attachmentsVersion: number;
  /** The editor's Markdown right after `load` with this `seq` was applied: the base for the next save. */
  onLoaded: (seq: number, markdown: string) => Promise<void>;
  onChange: (markdown: string) => Promise<void>;
  onFocusChange: (focused: boolean) => Promise<void>;
  onFormat: (state: FormatState) => Promise<void>;
  onOpenNote: (id: string) => Promise<void>;
  onOpenURL: (url: string) => Promise<void>;
  onOpenAttachment: (ref: AttachmentRef) => Promise<void>;
  onPickNoteLink: () => Promise<{ id: string; title: string } | null>;
  /** A pasted image, saved by native; resolves to its reference. */
  onPasteImage: (base64: string, ext: string) => Promise<AttachmentRef>;
  attachmentPreview: (ref: AttachmentRef, width: number) => Promise<AttachmentPreview>;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

function readImage(file: File): Promise<{ base64: string; ext: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: String(reader.result).split(',')[1] ?? '', ext: file.type === 'image/png' ? 'png' : 'jpg' });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** The note editor: Tiptap in the WebView, Markdown in and out through ./markdown. Native owns saving, files and the
 * toolbars (TiptapNoteView); this side owns the document. */
export default function TiptapEditor(props: Props) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const lastFormat = useRef('');

  const extensions = useMemo(
    () => [
      ...schemaExtensions({
        preview: (ref) => callbacks.current.attachmentPreview(ref, Math.min(window.innerWidth - 40, 720)),
        open: (ref) => void callbacks.current.onOpenAttachment(ref),
      }),
      NoteLink.configure({
        openNote: (id) => void callbacks.current.onOpenNote(id),
        openURL: (url) => void callbacks.current.onOpenURL(url),
        pickNote: () => callbacks.current.onPickNoteLink(),
      }),
      Hashtag,
      FoldableHeading,
      Selection,
      Placeholder.configure({
        placeholder: ({ editor, node, pos }) => (pos === 0 && node.type.name === 'heading' && editor.state.doc.childCount === 1 ? 'Title' : ''),
        showOnlyCurrent: false,
      }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: markdownToDoc(props.load.markdown),
    editable: props.editable,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { autocapitalize: 'sentences', autocorrect: 'on', spellcheck: 'true' },
      scrollMargin: { top: 24, bottom: 48, left: 0, right: 0 },
      scrollThreshold: { top: 24, bottom: 48, left: 0, right: 0 },
      clipboardTextParser: (text, _context, _plain, view) => {
        const json = toDoc(parse(text, false));
        const fragment = Fragment.fromJSON(view.state.schema, json.content);
        return Slice.maxOpen(fragment);
      },
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n', (leaf) => (leaf.type.name === 'attachment' ? `[${leaf.attrs.name}]` : '')),
      handlePaste: (_view, event) => {
        const images = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!images.length) return false;
        void Promise.all(images.map(readImage)).then(async (read) => {
          const refs = await Promise.all(read.map((r) => callbacks.current.onPasteImage(r.base64, r.ext)));
          const current = editorRef.current;
          if (current && !current.isDestroyed) runCommand(current, { kind: 'insertAttachments', refs });
        });
        return true;
      },
    },
    onUpdate: ({ editor }) => void callbacks.current.onChange(markdownOf(editor)),
    onFocus: () => void callbacks.current.onFocusChange(true),
    onBlur: () => void callbacks.current.onFocusChange(false),
    onSelectionUpdate: ({ editor }) => {
      const state = formatState(editor);
      const key = JSON.stringify(state);
      if (key === lastFormat.current) return;
      lastFormat.current = key;
      void callbacks.current.onFormat(state);
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useDOMImperativeHandle(props.ref, () => ({
    run: (command) => {
      runCommand(editor, command as EditorCommand);
      return true;
    },
  }), [editor]);

  // A new load replaces the document: on open, after an agent wrote, after a merge.
  const loadedSeq = useRef(-1);
  useEffect(() => {
    const { seq, markdown, keepSelection } = props.load;
    if (seq === loadedSeq.current) return;
    if (loadedSeq.current !== -1) {
      const { from, to } = editor.state.selection;
      editor.commands.setContent(markdownToDoc(markdown), { emitUpdate: false });
      if (keepSelection) {
        const size = editor.state.doc.content.size;
        editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
      }
    }
    loadedSeq.current = seq;
    void callbacks.current.onLoaded(seq, markdownOf(editor));
  }, [editor, props.load]);

  useEffect(() => editor.setEditable(props.editable), [editor, props.editable]);

  useEffect(() => {
    if (props.attachmentsVersion > 0) refreshAttachments(editor.storage.attachment);
  }, [editor, props.attachmentsVersion]);

  useEffect(() => {
    document.documentElement.dataset.scheme = props.scheme;
    document.documentElement.dataset.paper = props.paper;
  }, [props.scheme, props.paper]);

  const { modifiedAt, editedBy } = props.header;
  return (
    <div className="page" onClick={(e) => { if (e.target === e.currentTarget && props.editable) focusEditor(editor, 'end'); }}>
      <p className="date">
        {dateFormat.format(new Date(modifiedAt))}
        {editedBy ? <><br />Edited by {editedBy}</> : null}
      </p>
      <EditorContent editor={editor} />
    </div>
  );
}

