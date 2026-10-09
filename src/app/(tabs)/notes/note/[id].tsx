import { useLocalSearchParams } from 'expo-router';

import { EnrichedNoteEditor } from '@/ui/editor-enriched/EnrichedNoteEditor';
import { NoteEditor } from '@/ui/editor/NoteEditor';

/** EXPO_PUBLIC_PUFFER_EDITOR=enriched opens notes in the react-native-enriched-html spike, which has its own screen and
 * saves as a copy; native and tiptap share NoteEditor's screen. */
const enriched = process.env.EXPO_PUBLIC_PUFFER_EDITOR === 'enriched';

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return enriched ? <EnrichedNoteEditor key={id} id={id} /> : <NoteEditor id={id} />;
}
