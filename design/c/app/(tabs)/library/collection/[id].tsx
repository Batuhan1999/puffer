import { ContentUnavailableView, Host, List, ProgressView, Section, Text } from '@expo/ui/swift-ui';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';

import type { Item, Query } from '@/domain';
import { COLLECTIONS } from '@/ui/c/agents';
import { ItemRow } from '@/ui/c/ItemRow';
import { usePrefs } from '@/ui/c/prefs';
import { useSearch } from '@/store';

export default function CollectionScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const prefs = usePrefs();
  const collection = COLLECTIONS.find((c) => c.id === id);
  const query = useMemo<Query | null>(() => (collection ? { kind: 'text', text: collection.query } : null), [collection]);
  const { result, searching } = useSearch(query, prefs);

  if (!collection) {
    return (
      <Host style={{ flex: 1 }}>
        <ContentUnavailableView title="Unknown collection" systemImage="questionmark.folder" />
      </Host>
    );
  }

  const open = (item: Item) => router.push({ pathname: '/item/[id]', params: { id: item.id } });
  const hits = (result?.hits ?? []).slice(0, 30);

  return (
    <>
      <Stack.Screen options={{ title: collection.name }} />
      <Host style={{ flex: 1 }}>
        <List>
          <Section footer={<Text>{`Saved search: “${collection.query}”`}</Text>}>
            {searching && !result && (
              <ProgressView>
                <Text>Searching</Text>
              </ProgressView>
            )}
            {hits.map((h) => (
              <ItemRow key={h.item.id} item={h.item} onPress={() => open(h.item)} />
            ))}
          </Section>
        </List>
      </Host>
    </>
  );
}
