import { Button, Section } from '@expo/ui/swift-ui';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { notes, NOTES_FOLDER, useNotes } from '@/notes';
import { notesTint } from '@/ui/colors';
import { promptNewFolder } from '@/ui/folderPrompts';
import { FolderRow } from '@/ui/noteRows';
import { ScreenList } from '@/ui/screen';
import { alertError } from '@/ui/states';

/** The Move sheet: pick the folder a note goes to. */
export default function MoveScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { folders, notes: all } = useNotes();
  const router = useRouter();
  const current = all.find((n) => n.id === id)?.folderId;
  const ordered = [...folders.filter((f) => f.id === NOTES_FOLDER), ...folders.filter((f) => f.id !== NOTES_FOLDER)];

  const moveTo = (folderId: string) => notes.move(id, folderId).then(() => router.back(), alertError('Could Not Move'));

  return (
    <>
      <Stack.Screen options={{ title: 'Select a Folder' }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button tintColor={notesTint} onPress={() => router.back()}>
          Cancel
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScreenList>
        <Section title="On My iPhone">
          {ordered.map((folder) => (
            <FolderRow
              key={folder.id}
              name={folder.name}
              count={folder.count}
              accessory={folder.id === current ? 'current' : 'none'}
              onPress={() => moveTo(folder.id)}
            />
          ))}
        </Section>
        <Section>
          <Button label="New Folder" systemImage="folder.badge.plus" onPress={() => promptNewFolder((folder) => moveTo(folder.id))} />
        </Section>
      </ScreenList>
    </>
  );
}
