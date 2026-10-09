import { Stack } from 'expo-router';

import { PufferProvider } from '@/store';
import { AgentsProvider } from '@/ui/b/agents';
import { PrefsProvider } from '@/ui/b/prefs';
import { Toast } from '@/ui/b/Toast';

export default function RootLayout() {
  return (
    <PufferProvider>
      <PrefsProvider>
        <AgentsProvider>
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: 'Settings', presentation: 'modal', headerLargeTitleEnabled: true }} />
          </Stack>
          <Toast />
        </AgentsProvider>
      </PrefsProvider>
    </PufferProvider>
  );
}
