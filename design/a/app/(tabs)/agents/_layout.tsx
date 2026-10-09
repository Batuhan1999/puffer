import { Stack } from 'expo-router';

import { TabBaseProvider } from '@/ui/nav';

export default function AgentsLayout() {
  return (
    <TabBaseProvider value="/agents">
      <Stack screenOptions={{ headerLargeTitleEnabled: true }} />
    </TabBaseProvider>
  );
}
