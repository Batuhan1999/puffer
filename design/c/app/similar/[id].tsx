import { ContentUnavailableView, Host, List, ProgressView, Section, Text } from '@expo/ui/swift-ui';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';

import type { Item, Query } from '@/domain';
import { ItemRow } from '@/ui/c/ItemRow';
import { usePrefs } from '@/ui/c/prefs';
import { usePuffer, useSearch } from '@/store';

export default function SimilarScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { items } = usePuffer();
  const prefs = usePrefs();
  const source = items.find((i) => i.id === id);
  const query = useMemo<Query | null>(() => (source ? { kind: 'like', item: source } : null), [source]);
  const { result, searching } = useSearch(query, prefs);

  if (!source) {
    return (
      <Host style={{ flex: 1 }}>
        <ContentUnavailableView title="Not in your memory anymore" systemImage="questionmark.folder" />
      </Host>
    );
  }

  const open = (item: Item) => router.push({ pathname: '/item/[id]', params: { id: item.id } });
  const hits = (result?.hits ?? []).filter((h) => h.item.id !== source.id).slice(0, 60);

  return (
    <Host style={{ flex: 1 }}>
      <List>
        <Section title="Looking for things like">
          <ItemRow item={source} onPress={() => open(source)} />
        </Section>
        {searching && !result && (
          <Section>
            <ProgressView>
              <Text>Searching</Text>
            </ProgressView>
          </Section>
        )}
        {hits.length > 0 && (
          <Section title="Similar in your memory">
            {hits.map((h) => (
              <ItemRow key={h.item.id} item={h.item} onPress={() => open(h.item)} />
            ))}
          </Section>
        )}
      </List>
    </Host>
  );
}
