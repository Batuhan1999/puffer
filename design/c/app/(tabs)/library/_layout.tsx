import { Stack } from 'expo-router';

export default function LibraryLayout() {
  return (
    <Stack screenOptions={{ headerLargeTitleEnabled: true }}>
      <Stack.Screen name="index" options={{ title: 'Library' }} />
      <Stack.Screen name="photos" options={{ title: 'Photos' }} />
      <Stack.Screen name="documents" options={{ title: 'Documents', headerLargeTitleEnabled: false }} />
      <Stack.Screen name="collection/[id]" options={{ title: 'Collection', headerLargeTitleEnabled: false }} />
    </Stack>
  );
}
