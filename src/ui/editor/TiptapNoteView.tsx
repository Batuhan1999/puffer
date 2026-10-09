import { type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Alert, AppState, Keyboard, type KeyboardEvent, LayoutAnimation, Linking, type StyleProp, StyleSheet, useColorScheme, View, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type AttachmentSource, type Note, type NoteEditorHandle, noteEditor, onChange, type PaperStyle, type ShareFormat,
} from '../../../modules/puffer-native/src';
import { ACCESSORY_HEIGHT, FormatPanel, KeyboardAccessory } from './EditorToolbars';
import { NoteSaver } from './session';
import TiptapEditor, { type TiptapEditorRef } from './TiptapEditor';
import type { AttachmentRef, EditorCommand, EditorLoad, FormatState, Highlight } from './types';

type Props = {
  noteId: string;
  ref?: Ref<NoteEditorHandle>;
  style?: StyleProp<ViewStyle>;
  onEditingChange?: (event: { nativeEvent: { editing: boolean } }) => void;
  onOpenNote?: (event: { nativeEvent: { noteId: string } }) => void;
};

const NO_FORMAT: FormatState = { block: 'body', list: null, quoted: false, marks: [], highlight: null, inTable: false };
const DEFAULT_PANEL_HEIGHT = 290;

/**
 * The Tiptap note editor, with the same props and handle as the native NoteEditorView. The document lives in the DOM
 * component (TiptapEditor); this side saves it (NoteSaver), runs the keyboard bar and the Aa panel, and reaches native
 * for files, note links and export.
 */
export function TiptapNoteView({ noteId, ref, style, onEditingChange, onOpenNote }: Props) {
  const editor = useRef<TiptapEditorRef>(null);
  const container = useRef<View>(null);
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const safeBottom = useSafeAreaInsets().bottom;
  const [load, setLoad] = useState<EditorLoad | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [paper, setPaper] = useState<PaperStyle>(() => noteEditor.paper(noteId));
  const [attachmentsVersion, setAttachmentsVersion] = useState(0);
  const [focused, setFocused] = useState(false);
  const [panel, setPanel] = useState(false);
  const [format, setFormat] = useState(NO_FORMAT);
  const [highlight, setHighlight] = useState<Highlight>('purple');
  const [keyboard, setKeyboard] = useState(0);
  // The last keyboard's height, so the Aa panel takes its place; a guess until a keyboard showed.
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT + safeBottom);
  const saver = useMemo(() => new NoteSaver(noteId, setLoad, setNote), [noteId]);

  const run = useCallback((command: EditorCommand) => {
    editor.current?.run(command);
  }, []);
  const editing = focused || panel;

  useEffect(() => {
    void saver.open();
    const subscriptions = [
      onChange((event) => { if (event.topic === 'notes') void saver.refresh(); }),
      noteEditor.onAttachmentsAdded((event) => {
        if (event.noteId === noteId) run({ kind: 'insertAttachments', refs: event.attachments });
      }),
      noteEditor.onAttachmentChanged((event) => { if (event.noteId === noteId) setAttachmentsVersion((v) => v + 1); }),
    ];
    const state = AppState.addEventListener('change', (next) => { if (next !== 'active') void saver.save(); });
    return () => {
      subscriptions.forEach((remove) => remove());
      state.remove();
      // Leaving saves; an empty note goes away, as in Apple Notes.
      void saver.close();
    };
  }, [noteId, run, saver]);

  useEffect(() => onEditingChange?.({ nativeEvent: { editing } }), [editing, onEditingChange]);

  // The keyboard's overlap with this view: the editor ends above it and the accessory bar sits on it.
  useEffect(() => {
    const moved = (event: KeyboardEvent) => {
      container.current?.measureInWindow((_x, y, _w, height) => {
        const overlap = Math.max(0, y + height - event.endCoordinates.screenY);
        LayoutAnimation.configureNext({ duration: event.duration || 250, update: { type: LayoutAnimation.Types.keyboard } });
        setKeyboard(overlap);
        if (overlap > 0) setPanelHeight(overlap);
      });
    };
    const subscription = Keyboard.addListener('keyboardWillChangeFrame', moved);
    return () => subscription.remove();
  }, []);

  useImperativeHandle(ref, () => ({
    finishEditing: async () => {
      setPanel(false);
      run({ kind: 'blur' });
    },
    find: async () => {
      Alert.prompt('Find in Note', undefined, (text) => { if (text) run({ kind: 'find', text }); });
    },
    share: async (format: ShareFormat) => {
      await saver.save();
      await noteEditor.share(noteId, format, saver.latest);
    },
    copyNote: () => noteEditor.copy(saver.latest),
    moveCheckedToBottom: async () => run({ kind: 'moveCheckedToBottom' }),
    uncheckAll: async () => run({ kind: 'uncheckAll' }),
    toggleChecklist: async () => run({ kind: 'checklist' }),
    insertTable: async () => run({ kind: 'insertTable' }),
    attach: (source: AttachmentSource) => noteEditor.attach(noteId, source),
    setPaper: async (next: PaperStyle) => {
      noteEditor.setPaper(noteId, next);
      setPaper(next);
    },
  }), [noteId, run, saver]);

  const onOpenNoteRef = useRef(onOpenNote);
  onOpenNoteRef.current = onOpenNote;

  // Stable callbacks, so the WebView only hears about real prop changes.
  const callbacks = useMemo(() => ({
    onLoaded: async (seq: number, markdown: string) => {
      saver.loaded(seq, markdown);
      if (seq === 1 && markdown.trim() === '') run({ kind: 'focus' });
    },
    onChange: async (markdown: string) => saver.changed(markdown),
    onFocusChange: async (isFocused: boolean) => {
      setFocused(isFocused);
      if (isFocused) setPanel(false);
      else void saver.save();
    },
    onFormat: async (state: FormatState) => setFormat(state),
    onOpenNote: async (id: string) => {
      void saver.save();
      onOpenNoteRef.current?.({ nativeEvent: { noteId: id } });
    },
    onOpenURL: async (url: string) => void Linking.openURL(url),
    onOpenAttachment: async (attachment: AttachmentRef) => {
      void saver.save();
      await noteEditor.openAttachment(noteId, attachment);
    },
    onPickNoteLink: () => noteEditor.pickNoteLink(noteId),
    onPasteImage: (base64: string, ext: string) => noteEditor.saveAttachment(noteId, base64, ext, 'Image'),
    attachmentPreview: (attachment: AttachmentRef, width: number) => noteEditor.attachmentPreview(noteId, attachment, width),
  }), [noteId, run, saver]);

  const editable = note !== null && note.deletedAt === null;
  const header = useMemo(
    () => ({ modifiedAt: note?.modifiedAt ?? Date.now(), editedBy: note?.lastEditor.kind === 'agent' ? note.lastEditor.name : null }),
    [note?.modifiedAt, note?.lastEditor],
  );
  const dom = useMemo(() => ({
    hideKeyboardAccessoryView: true,
    keyboardDisplayRequiresUserAction: false,
    style: styles.webview,
    containerStyle: styles.webview,
  }), []);

  const surface = useMemo(
    () => load && (
      <TiptapEditor
        ref={editor}
        dom={dom}
        load={load}
        editable={editable}
        paper={paper}
        header={header}
        scheme={scheme}
        attachmentsVersion={attachmentsVersion}
        {...callbacks}
      />
    ),
    [attachmentsVersion, callbacks, dom, editable, header, load, paper, scheme],
  );

  // With a hardware keyboard there is no keyboard to sit on: the bar docks above the home indicator.
  const accessoryBottom = keyboard > 0 ? keyboard : safeBottom;
  const occupied = panel ? panelHeight : focused ? accessoryBottom + ACCESSORY_HEIGHT : 0;
  return (
    <View ref={container} style={[styles.root, style]} collapsable={false}>
      <View style={[styles.root, { marginBottom: occupied }]}>{surface}</View>
      {focused && !panel ? (
        <View style={[styles.docked, { bottom: accessoryBottom }]}>
          <KeyboardAccessory
            format={format}
            run={run}
            onFormat={() => {
              setPanel(true);
              run({ kind: 'blur' });
            }}
            onAttach={(source) => void noteEditor.attach(noteId, source)}
            onHide={() => run({ kind: 'blur' })}
          />
        </View>
      ) : null}
      {panel ? (
        <View style={[styles.docked, { bottom: 0 }]}>
          <FormatPanel
            format={format}
            height={panelHeight}
            bottomInset={safeBottom}
            highlight={highlight}
            run={run}
            onHighlightColor={setHighlight}
            onClose={() => {
              setPanel(false);
              run({ kind: 'focus' });
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  webview: { flex: 1, backgroundColor: 'transparent' },
  docked: { position: 'absolute', left: 0, right: 0 },
});
