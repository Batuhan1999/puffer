import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { PlatformColor, StyleSheet, View } from 'react-native';

import { type NoteEditorHandle, type NoteEditorProps, NoteEditorView, type PaperStyle } from '../../../modules/puffer-native/src';
import { notes, useNotes } from '@/notes';
import { notesTint } from '@/ui/colors';
import { TiptapNoteView } from '@/ui/editor/TiptapNoteView';
import { Loading, Unavailable } from '@/ui/states';

const PAPERS: readonly { paper: PaperStyle; title: string; icon: 'square' | 'line.3.horizontal' | 'squareshape.split.3x3' }[] = [
  { paper: 'none', title: 'No Lines', icon: 'square' },
  { paper: 'linesSmall', title: 'Small Lines', icon: 'line.3.horizontal' },
  { paper: 'linesLarge', title: 'Large Lines', icon: 'line.3.horizontal' },
  { paper: 'gridSmall', title: 'Small Grid', icon: 'squareshape.split.3x3' },
  { paper: 'gridLarge', title: 'Large Grid', icon: 'squareshape.split.3x3' },
];

/** The native editor (modules/puffer-native/ios/Editor): its NoteSession loads and saves; leaving closes the note. */
function NativeNoteView(props: NoteEditorProps) {
  useEffect(() => () => void notes.close(props.noteId), [props.noteId]);
  return <NoteEditorView {...props} />;
}

/** Editors by EXPO_PUBLIC_PUFFER_EDITOR=native|tiptap (enriched: the note route); native unless another is named, until
 * Tiptap (src/ui/editor/TiptapNoteView.tsx) is validated on the device. Each loads, saves and closes its note itself and
 * takes the same props and handle. */
const EDITORS = { tiptap: TiptapNoteView, native: NativeNoteView } as const;
const chosen = process.env.EXPO_PUBLIC_PUFFER_EDITOR;
const EditorView = chosen && chosen in EDITORS ? EDITORS[chosen as keyof typeof EDITORS] : EDITORS.native;

/** One note, in the editor EXPO_PUBLIC_PUFFER_EDITOR picks. */
export function NoteEditor({ id }: { id: string }) {
  const { notes: summaries, loaded } = useNotes();
  const summary = summaries.find((n) => n.id === id);
  const editor = useRef<NoteEditorHandle>(null);
  const [editing, setEditing] = useState(false);

  if (!summary) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerLargeTitleEnabled: false }} />
        {loaded ? <Unavailable title="Note Not Found" systemImage="note.text" description="This note was deleted." /> : <Loading />}
      </>
    );
  }

  const deleted = summary.deletedAt !== null;
  const compose = async () => {
    const note = await notes.create('', summary.folderId);
    router.replace({ pathname: '/notes/note/[id]', params: { id: note.id, folder: summary.folderId } });
  };

  return (
    <>
      <Stack.Screen options={{ title: '', headerLargeTitleEnabled: false, contentStyle: styles.page }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="square.and.arrow.up" accessibilityLabel="Share" tintColor={notesTint}>
          <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={() => editor.current?.share('text')}>
            Send a Copy
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="doc.text" onPress={() => editor.current?.share('markdown')}>
            Export as Markdown
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="doc.richtext" onPress={() => editor.current?.share('pdf')}>
            Export as PDF
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="printer" onPress={() => editor.current?.share('print')}>
            Print
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="doc.on.doc" onPress={() => editor.current?.copyNote()}>
            Copy
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More" tintColor={notesTint}>
          <Stack.Toolbar.MenuAction icon="magnifyingglass" onPress={() => editor.current?.find()}>
            Find in Note
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="checklist.checked" disabled={deleted} onPress={() => editor.current?.moveCheckedToBottom()}>
            Move Checked to Bottom
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="checklist.unchecked" disabled={deleted} onPress={() => editor.current?.uncheckAll()}>
            Uncheck All
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu title="Lines & Grids" icon="squareshape.split.3x3">
            {PAPERS.map(({ paper, title, icon }) => (
              <Stack.Toolbar.MenuAction key={paper} icon={icon} onPress={() => editor.current?.setPaper(paper)}>
                {title}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.MenuAction icon={summary.pinned ? 'pin.slash' : 'pin'} disabled={deleted} onPress={() => notes.setPinned(id, !summary.pinned)}>
            {summary.pinned ? 'Unpin Note' : 'Pin Note'}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="folder" disabled={deleted} onPress={() => router.push({ pathname: '/notes/move', params: { id } })}>
            Move Note
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="trash" destructive disabled={deleted} onPress={() => notes.remove(id).then(() => router.back())}>
            Delete Note
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon="checkmark" variant="done" hidden={!editing} accessibilityLabel="Done" tintColor={notesTint} onPress={() => editor.current?.finishEditing()} />
      </Stack.Toolbar>
      {editing ? null : deleted ? (
        <Stack.Toolbar>
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.Button tintColor={notesTint} onPress={() => notes.restore(id)}>
            Recover
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : (
        <Stack.Toolbar>
          <Stack.Toolbar.Button icon="checklist" accessibilityLabel="Checklist" tintColor={notesTint} onPress={() => editor.current?.toggleChecklist()} />
          <Stack.Toolbar.Button icon="tablecells" accessibilityLabel="Table" tintColor={notesTint} onPress={() => editor.current?.insertTable()} />
          <Stack.Toolbar.Menu icon="paperclip" accessibilityLabel="Attach" tintColor={notesTint}>
            <Stack.Toolbar.MenuAction icon="photo.on.rectangle" onPress={() => editor.current?.attach('photos')}>
              Choose Photo
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="camera" onPress={() => editor.current?.attach('camera')}>
              Take Photo
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="doc.viewfinder" onPress={() => editor.current?.attach('scan')}>
              Scan Documents
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="doc" onPress={() => editor.current?.attach('files')}>
              Attach File
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Button icon="pencil.tip.crop.circle" accessibilityLabel="Drawing" tintColor={notesTint} onPress={() => editor.current?.attach('drawing')} />
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New Note" tintColor={notesTint} onPress={() => void compose()} />
        </Stack.Toolbar>
      )}
      <View style={styles.page}>
        <EditorView
          key={id}
          ref={editor}
          noteId={id}
          style={styles.editor}
          onEditingChange={(e) => setEditing(e.nativeEvent.editing)}
          onOpenNote={(e) => router.push({ pathname: '/notes/note/[id]', params: { id: e.nativeEvent.noteId } })}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: PlatformColor('systemBackground') },
  editor: { flex: 1 },
});
