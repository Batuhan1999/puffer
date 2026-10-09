// Spike route for the react-native-enriched-html editor: puffer:///notes/enriched/<note id>, or .../roundtrip to
// measure every note's Markdown round trip through the native editor.
import { useLocalSearchParams } from 'expo-router';

import { EnrichedNoteEditor } from '@/ui/editor-enriched/EnrichedNoteEditor';
import { RoundTrip } from '@/ui/editor-enriched/RoundTrip';

export default function EnrichedNoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return id === 'roundtrip' ? <RoundTrip /> : <EnrichedNoteEditor key={id} id={id} />;
}
