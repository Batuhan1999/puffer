import { Button, ContentUnavailableView, ContextMenu, List, Section, Text } from '@expo/ui/swift-ui';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Text as NativeText, PlatformColor, StyleSheet, View } from 'react-native';

import {
  dateOf,
  folderName,
  type NoteSummary,
  notes,
  notesIn,
  NOTES_FOLDER,
  RECENTLY_DELETED,
  sectionsOf,
  SORT_KEYS,
  useListStyle,
  useNoteSearch,
  useNotes,
} from '@/notes';
import { usePuffer } from '@/store';
import { notesTint, secondary } from '@/ui/colors';
import { confirmDeleteFolder, promptRenameFolder } from '@/ui/folderPrompts';
import { plural } from '@/ui/format';
import { NoteRow } from '@/ui/noteRows';
import { ScreenList } from '@/ui/screen';
import { alertError } from '@/ui/states';
import { type SwipeButton, swipeActions } from '@/ui/swipe';

type NoteAction = 'pin' | 'move' | 'delete' | 'recover';

/** One table for both ways into a row's actions: its swipe edges and its long-press menu. */
function rowActions(note: NoteSummary, trash: boolean) {
  // In Recently Deleted a delete is for good and asks first, so the row must not animate away before the answer.
  const del: SwipeButton<NoteAction> = { id: 'delete', label: 'Delete', systemImage: 'trash', tint: 'red', destructive: !trash };
  if (trash) {
    const recover: SwipeButton<NoteAction> = { id: 'recover', label: 'Recover', systemImage: 'arrow.uturn.backward', tint: 'blue' };
    return { leading: [recover], trailing: [del], menu: [recover, del] };
  }
  const pin: SwipeButton<NoteAction> = note.pinned
    ? { id: 'pin', label: 'Unpin', systemImage: 'pin.slash.fill', tint: 'orange' }
    : { id: 'pin', label: 'Pin', systemImage: 'pin.fill', tint: 'orange' };
  const move: SwipeButton<NoteAction> = { id: 'move', label: 'Move', systemImage: 'folder', tint: 'indigo' };
  return {
    leading: [pin],
    trailing: [del, move],
    menu: [{ ...pin, label: note.pinned ? 'Unpin Note' : 'Pin Note' }, { ...move, label: 'Move…' }, del],
  };
}

export default function NotesListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { folders, notes: all } = useNotes();
  const { ready } = usePuffer();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const { choice, style, choose } = useListStyle(id);
  const trash = id === RECENTLY_DELETED;
  const ownFolder = id === NOTES_FOLDER ? undefined : folders.find((f) => f.id === id);
  const list = useMemo(() => notesIn(all, id), [all, id]);
  const sections = useMemo(() => sectionsOf(list, style), [list, style]);
  const results = useNoteSearch(trash ? '' : query, ready, all, id);

  const open = (noteId: string) =>
    router.push({ pathname: '/notes/note/[id]', params: trash ? { id: noteId } : { id: noteId, folder: id } });
  const compose = () => notes.create('', id).then((note) => open(note.id), alertError('Could Not Create Note'));

  const remove = (note: NoteSummary) => {
    if (!trash) return void notes.remove(note.id).catch(alertError('Could Not Delete'));
    Alert.alert('Delete Note?', 'This note will be deleted. This action cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void notes.purge([note.id]).catch(alertError('Could Not Delete')) },
    ]);
  };

  const run = (note: NoteSummary, action: NoteAction) => {
    switch (action) {
      case 'pin':
        return void notes.setPinned(note.id, !note.pinned).catch(alertError('Could Not Pin'));
      case 'move':
        return router.push({ pathname: '/notes/move', params: { id: note.id } });
      case 'delete':
        return remove(note);
      case 'recover':
        return void notes.restore(note.id).catch(alertError('Could Not Recover'));
    }
  };

  const deleteAll = () =>
    Alert.alert('Delete All?', 'These notes will be deleted. This action cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete All',
        style: 'destructive',
        onPress: () => void notes.purge(list.map((n) => n.id)).catch(alertError('Could Not Delete')),
      },
    ]);

  const row = (note: NoteSummary, snippet?: string) => {
    const actions = rowActions(note, trash);
    return (
      <ContextMenu key={note.id}>
        <ContextMenu.Items>
          {actions.menu.map((action) => (
            <Button
              key={action.id}
              label={action.label}
              systemImage={action.systemImage}
              role={action.id === 'delete' ? 'destructive' : undefined}
              onPress={() => run(note, action.id)}
            />
          ))}
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <NoteRow
            note={note}
            snippet={snippet}
            at={dateOf(note, style.sort)}
            modifiers={[swipeActions(actions, (action) => run(note, action))]}
            onPress={() => open(note.id)}
          />
        </ContextMenu.Trigger>
      </ContextMenu>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: folderName(folders, id) }} />
      {trash ? null : (
        <Stack.SearchBar
          allowToolbarIntegration={false}
          placeholder="Search"
          onChangeText={(e) => setQuery(e.nativeEvent.text)}
          onCancelButtonPress={() => setQuery('')}
        />
      )}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More">
          <Stack.Toolbar.Menu title="Sort By" icon="arrow.up.arrow.down">
            <Stack.Toolbar.Menu inline>
              <Stack.Toolbar.MenuAction isOn={choice.sort === undefined} onPress={() => choose({ ...choice, sort: undefined })}>
                Default (Date Edited)
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu inline>
              {SORT_KEYS.map(({ key, label }) => (
                <Stack.Toolbar.MenuAction key={key} isOn={choice.sort === key} onPress={() => choose({ ...choice, sort: key })}>
                  {label}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.MenuAction
            icon="calendar"
            isOn={style.groupByDate}
            disabled={style.sort === 'title'}
            onPress={() => choose({ ...choice, groupByDate: !style.groupByDate })}
          >
            Group By Date
          </Stack.Toolbar.MenuAction>
          {ownFolder ? (
            <Stack.Toolbar.Menu inline>
              <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptRenameFolder(ownFolder)}>
                Rename Folder
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="trash" destructive onPress={() => confirmDeleteFolder(ownFolder, () => router.back())}>
                Delete Folder
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          ) : null}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar>
        {trash ? (
          <Stack.Toolbar.Button tintColor={notesTint} disabled={!list.length} onPress={deleteAll}>
            Delete All
          </Stack.Toolbar.Button>
        ) : null}
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.View hidesSharedBackground>
          <View style={styles.countBox}>
            <NativeText style={styles.count}>{list.length ? plural(list.length, 'Note') : 'No Notes'}</NativeText>
          </View>
        </Stack.Toolbar.View>
        <Stack.Toolbar.Spacer />
        {trash ? null : (
          <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New Note" tintColor={notesTint} onPress={compose} />
        )}
      </Stack.Toolbar>
      <ScreenList>
        {trash && list.length ? (
          <Section>
            <Text modifiers={[secondary]}>Notes are available here for 30 days. After that, they will be permanently deleted.</Text>
          </Section>
        ) : null}
        {results ? (
          <Section>
            {results.length ? results.map(({ note, snippet }) => row(note, snippet)) : <Text>{`No Results for “${query.trim()}”`}</Text>}
          </Section>
        ) : list.length ? (
          sections.map((section) => (
            <Section key={section.title || 'notes'} title={section.title || undefined}>
              <List.ForEach onDelete={(indices) => indices.forEach((i) => remove(section.notes[i]))}>
                {section.notes.map((note) => row(note))}
              </List.ForEach>
            </Section>
          ))
        ) : (
          <Section>
            <ContentUnavailableView
              title="No Notes"
              systemImage={trash ? 'trash' : 'note.text'}
              description={trash ? 'Deleted notes stay here for 30 days.' : 'Tap the compose button to write one.'}
            />
          </Section>
        )}
      </ScreenList>
    </>
  );
}

const styles = StyleSheet.create({
  // A toolbar item takes its custom view's frame as is, so the box needs a fixed size.
  countBox: { width: 140, height: 44, justifyContent: 'center' },
  count: { fontSize: 11, textAlign: 'center', color: PlatformColor('label') },
});
