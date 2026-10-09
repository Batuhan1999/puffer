import { Alert } from 'react-native';

import { type NoteFolder, notes } from '@/notes';

import { alertError } from './states';

export function promptNewFolder(then?: (folder: NoteFolder) => void) {
  Alert.prompt('New Folder', 'Enter a name for this folder.', (name) => {
    if (name.trim()) notes.createFolder(name.trim()).then(then, alertError('Could Not Create Folder'));
  });
}

export function promptRenameFolder(folder: NoteFolder) {
  Alert.prompt(
    'Rename Folder',
    undefined,
    (name) => {
      if (name.trim()) notes.renameFolder(folder.id, name.trim()).catch(alertError('Could Not Rename'));
    },
    'plain-text',
    folder.name,
  );
}

export function confirmDeleteFolder(folder: NoteFolder, then?: () => void) {
  Alert.alert(`Delete “${folder.name}”?`, folder.count ? 'Its notes move to Recently Deleted.' : undefined, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: () => void notes.removeFolder(folder.id).then(then, alertError('Could Not Delete')),
    },
  ]);
}
