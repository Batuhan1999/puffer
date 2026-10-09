import { Stack } from 'expo-router';

import { AgentPreviewProvider } from '@/ui/c/agents';
import { PrefsProvider } from '@/ui/c/prefs';
import { PufferProvider } from '@/store';

export default function RootLayout() {
  return (
    <PufferProvider>
      <PrefsProvider>
        <AgentPreviewProvider>
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="item/[id]" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, title: '' }} />
            <Stack.Screen name="similar/[id]" options={{ title: 'More like this', headerLargeTitleEnabled: false }} />
            <Stack.Screen name="setup" options={{ presentation: 'modal', title: 'Set up Puffer' }} />
          </Stack>
        </AgentPreviewProvider>
      </PrefsProvider>
    </PufferProvider>
  );
}
