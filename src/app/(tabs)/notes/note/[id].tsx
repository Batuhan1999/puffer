import { useLocalSearchParams } from 'expo-router';

import { NoteEditor } from '@/ui/editor/NoteEditor';

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <NoteEditor id={id} />;
}
