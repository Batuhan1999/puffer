import { Stack } from 'expo-router';

export default function SearchLayout() {
  return (
    <Stack screenOptions={{ headerLargeTitleEnabled: true }}>
      <Stack.Screen name="index" options={{ title: 'Search' }} />
    </Stack>
  );
}
