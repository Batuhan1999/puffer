import { Button, ContextMenu, List, Section, Text } from '@expo/ui/swift-ui';
import { badge, badgeProminence } from '@expo/ui/swift-ui/modifiers';
import { CommonActions } from '@react-navigation/native';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { useState } from 'react';

import { useBridge } from '@/bridge';
import { notes, NOTES_FOLDER, RECENTLY_DELETED, useNoteSearch, useNotes } from '@/notes';
import { usePuffer } from '@/store';
import { ActivitySection } from '@/ui/activity';
import { notesTint } from '@/ui/colors';
import { confirmDeleteFolder, promptNewFolder, promptRenameFolder } from '@/ui/folderPrompts';
import { FolderRow, NoteRow, NotesIndexingSection } from '@/ui/noteRows';
import { NavRow } from '@/ui/rows';
import { ScreenList } from '@/ui/screen';
import { alertError } from '@/ui/states';

export default function FoldersScreen() {
  const { folders, notes: all } = useNotes();
  const { ready, folders: documentFolders } = usePuffer();
  const { connects } = useBridge();
  const router = useRouter();
  const navigation = useNavigation();
  const [query, setQuery] = useState('');
  const results = useNoteSearch(query, ready, all);
  const deleted = all.filter((n) => n.deletedAt !== null).length;
  const builtIn = folders.find((f) => f.id === NOTES_FOLDER);
  const own = folders.filter((f) => f.id !== NOTES_FOLDER);

  const open = (id: string) => router.push({ pathname: '/notes/folder/[id]', params: { id } });
  const openNote = (id: string, folder: string) => router.push({ pathname: '/notes/note/[id]', params: { id, folder } });
  // Like Apple Notes, a new note from Folders opens over the folder it lands in, so Back shows it there. Both screens
  // go on in one state change.
  const compose = () =>
    notes.create('', NOTES_FOLDER).then(
      (note) =>
        navigation.dispatch((state) =>
          CommonActions.reset({
            ...state,
            routes: [
              ...state.routes,
              { name: 'notes/folder/[id]', params: { id: NOTES_FOLDER } },
              { name: 'notes/note/[id]', params: { id: note.id, folder: NOTES_FOLDER } },
            ],
            index: state.routes.length + 1,
          }),
        ),
      alertError('Could Not Create Note'),
    );

  return (
    <>
      <Stack.Screen options={{ title: 'Folders' }} />
      {/* iOS 26 may fold it into the bottom toolbar, where it does not show (here, and on a list opened underneath a note). */}
      <Stack.SearchBar
        allowToolbarIntegration={false}
        placeholder="Search"
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
        onCancelButtonPress={() => setQuery('')}
      />
      <Stack.Toolbar>
        <Stack.Toolbar.Button
          icon="folder.badge.plus"
          accessibilityLabel="New Folder"
          tintColor={notesTint}
          onPress={() => promptNewFolder()}
        />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New Note" tintColor={notesTint} onPress={compose} />
      </Stack.Toolbar>
      <ScreenList>
        {results ? (
          <Section title={results.length ? 'Top Hits' : undefined}>
            {results.length ? (
              results.map(({ note, snippet }) => (
                <NoteRow key={note.id} note={note} snippet={snippet} onPress={() => openNote(note.id, note.folderId)} />
              ))
            ) : (
              <Text>{`No Results for “${query.trim()}”`}</Text>
            )}
          </Section>
        ) : (
          <>
            <ActivitySection />
            <NotesIndexingSection />
            <Section title="On My iPhone">
              {builtIn ? <FolderRow name={builtIn.name} count={builtIn.count} onPress={() => open(builtIn.id)} /> : null}
              <List.ForEach onDelete={(indices) => indices.forEach((i) => confirmDeleteFolder(own[i]))}>
                {own.map((folder) => (
                  <ContextMenu key={folder.id}>
                    <ContextMenu.Items>
                      <Button label="Rename" systemImage="pencil" onPress={() => promptRenameFolder(folder)} />
                      <Button
                        label="Delete Folder"
                        systemImage="trash"
                        role="destructive"
                        onPress={() => confirmDeleteFolder(folder)}
                      />
                    </ContextMenu.Items>
                    <ContextMenu.Trigger>
                      <FolderRow name={folder.name} count={folder.count} onPress={() => open(folder.id)} />
                    </ContextMenu.Trigger>
                  </ContextMenu>
                ))}
              </List.ForEach>
              {deleted ? (
                <FolderRow name="Recently Deleted" count={deleted} symbol="trash" onPress={() => open(RECENTLY_DELETED)} />
              ) : null}
            </Section>
            <Section title="Puffer">
              <NavRow
                title="Documents"
                systemImage="doc.text.magnifyingglass"
                value={documentFolders.length.toLocaleString()}
                onPress={() => router.push('/folders')}
              />
              <NavRow
                title="Agents"
                systemImage="person.2.badge.key"
                modifiers={connects.length ? [badge(String(connects.length)), badgeProminence('increased')] : []}
                onPress={() => router.push('/agents')}
              />
            </Section>
            <Section footer={<Text>Bring every note over with one Shortcut, or one note at a time as Markdown.</Text>}>
              <NavRow title="Import from Apple Notes" systemImage="square.and.arrow.down" onPress={() => router.push('/notes/import')} />
            </Section>
          </>
        )}
      </ScreenList>
    </>
  );
}
