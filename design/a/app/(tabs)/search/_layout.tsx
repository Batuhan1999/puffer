import { Stack } from 'expo-router';

import { TabBaseProvider } from '@/ui/nav';

export default function SearchLayout() {
  return (
    <TabBaseProvider value="/search">
      <Stack screenOptions={{ headerLargeTitleEnabled: true }} />
    </TabBaseProvider>
  );
}
