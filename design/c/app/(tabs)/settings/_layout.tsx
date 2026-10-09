import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerLargeTitleEnabled: true }}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="engine" options={{ title: 'Search settings', headerLargeTitleEnabled: false }} />
    </Stack>
  );
}
