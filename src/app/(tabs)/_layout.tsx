import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

import { useNoticeHandling } from '@/ui/activity';
import { notesTintHex, screenBackground } from '@/ui/colors';

/** Deep links (a note, Agents) land with Folders underneath, so Back always leads somewhere. */
export const unstable_settings = { initialRouteName: 'notes/index' };

// Header colors take strings only, so they follow the scheme here: label, systemGroupedBackground (plain and in a
// sheet, where dark mode lifts it), systemBackground.
const HEADER = {
  light: { text: '#000000', list: '#F2F2F7', sheet: '#F2F2F7', note: '#FFFFFF' },
  dark: { text: '#FFFFFF', list: '#000000', sheet: '#1C1C1E', note: '#000000' },
};

/** One stack like Apple Notes: Folders, a folder's notes, a note; Documents and Agents push from Folders. */
export default function AppStack() {
  useNoticeHandling();
  const colors = HEADER[useColorScheme() === 'dark' ? 'dark' : 'light'];
  // An opaque bar in the list's own color: a transparent one leaves the large title over the SwiftUI list, which
  // the bar does not track while scrolling.
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.list },
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerLargeTitleEnabled: true,
        headerTintColor: notesTintHex,
        headerTitleStyle: { color: colors.text },
        headerLargeTitleStyle: { color: colors.text },
        contentStyle: screenBackground,
      }}
    >
      <Stack.Screen name="notes/note/[id]" options={{ headerStyle: { backgroundColor: colors.note } }} />
      <Stack.Screen
        name="notes/move"
        options={{ presentation: 'modal', headerLargeTitleEnabled: false, headerStyle: { backgroundColor: colors.sheet } }}
      />
    </Stack>
  );
}
