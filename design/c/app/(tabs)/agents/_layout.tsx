import { Stack } from 'expo-router';

export default function AgentsLayout() {
  return (
    <Stack screenOptions={{ headerLargeTitleEnabled: true }}>
      <Stack.Screen name="index" options={{ title: 'Agents' }} />
      <Stack.Screen name="request/[id]" options={{ title: 'Request', headerLargeTitleEnabled: false }} />
    </Stack>
  );
}
