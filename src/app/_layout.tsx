import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';

import { BridgeProvider } from '@/bridge';
import { NotesProvider } from '@/notes';
import { PufferProvider } from '@/store';
import { screenBackground } from '@/ui/colors';
import { Gate } from '@/ui/welcome';

export default function RootLayout() {
  // Native stack headers take their light or dark style from the navigation theme, which is light unless set here.
  const theme = useColorScheme() === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider value={theme}>
      <PufferProvider>
        <BridgeProvider>
          <NotesProvider>
            <Gate>
              <Stack screenOptions={{ headerShown: false, contentStyle: screenBackground }}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="connect/[id]" options={{ presentation: 'modal', headerShown: true }} />
                <Stack.Screen name="sign-in" options={{ presentation: 'modal', headerShown: true }} />
              </Stack>
            </Gate>
          </NotesProvider>
        </BridgeProvider>
      </PufferProvider>
    </ThemeProvider>
  );
}
