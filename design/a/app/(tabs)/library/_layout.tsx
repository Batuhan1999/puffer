import { Stack } from 'expo-router';

import { TabBaseProvider } from '@/ui/nav';

export default function LibraryLayout() {
  return (
    <TabBaseProvider value="/library">
      <Stack screenOptions={{ headerLargeTitleEnabled: true }} />
    </TabBaseProvider>
  );
}
