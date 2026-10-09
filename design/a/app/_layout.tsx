import { Stack } from 'expo-router';

import { PufferProvider } from '@/store';
import { PreviewProvider } from '@/ui/preview';
import { Gate } from '@/ui/welcome';

export default function RootLayout() {
  return (
    <PufferProvider>
      <PreviewProvider>
        <Gate>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
            <Stack.Screen name="collection-editor" options={{ presentation: 'modal', headerShown: true }} />
            <Stack.Screen name="request/[id]" options={{ presentation: 'modal', headerShown: true }} />
          </Stack>
        </Gate>
      </PreviewProvider>
    </PufferProvider>
  );
}
