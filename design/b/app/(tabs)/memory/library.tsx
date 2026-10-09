import { ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import { Stack, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';

import { usePuffer } from '@/store';
import { FilterBar } from '@/ui/b/FilterBar';
import { Filter, ItemGrid } from '@/ui/b/ItemGrid';

export default function Library() {
  const { items } = usePuffer();
  const [filter, setFilter] = useState<Filter>('all');
  const newestFirst = useMemo(() => [...items].sort((a, b) => b.addedAt - a.addedAt), [items]);

  return (
    <>
      <Stack.Screen options={{ title: 'Everything', headerLargeTitleEnabled: false }} />
      <ItemGrid
        items={newestFirst}
        filter={filter}
        onPress={(item) => router.push(`/memory/item/${encodeURIComponent(item.id)}`)}
        header={<FilterBar filter={filter} onChange={setFilter} />}
        empty={
          <Host style={styles.empty}>
            <ContentUnavailableView title="Nothing here" systemImage="square.grid.2x2" description="Add photos or documents from the Memory tab." />
          </Host>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({ empty: { height: 320 } });
