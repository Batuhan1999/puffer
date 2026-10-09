import { ContentUnavailableView, Host, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, padding } from '@expo/ui/swift-ui/modifiers';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { PlatformColor, StyleSheet, Text as RNText, View } from 'react-native';

import { useSearch } from '@/store';
import { useAgents } from '@/ui/b/agents';
import { ItemGrid } from '@/ui/b/ItemGrid';
import { usePrefs } from '@/ui/b/prefs';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bridge = useAgents();
  const collection = bridge.collections.find((c) => c.id === id);
  const { options } = usePrefs();
  const query = useMemo(() => (collection ? { kind: 'text' as const, text: collection.query } : null), [collection]);
  const { result, searching } = useSearch(query, options);
  const items = useMemo(() => (result?.hits ?? []).slice(0, 30).map((h) => h.item), [result]);

  if (!collection) {
    return (
      <Host style={styles.fill}>
        <ContentUnavailableView title="Collection not found" systemImage="questionmark.circle" />
      </Host>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: collection.name, headerLargeTitleEnabled: false }} />
      <ItemGrid
        items={items}
        onPress={(item) => router.push(`/agents/item/${encodeURIComponent(item.id)}`)}
        header={
          <View>
            <Host matchContents>
              <VStack alignment="leading" spacing={14} modifiers={[padding({ horizontal: 16, vertical: 12 })]}>
                <Text modifiers={[secondary, font({ size: 14 })]}>
                  {`Preview. Pre-approving lets an agent get answers from "${collection.name}" without a prompt on this phone. Everything else still asks.`}
                </Text>
                {bridge.agents.map((a) => (
                  <Toggle
                    key={a.id}
                    label={a.name}
                    systemImage={a.symbol}
                    isOn={collection.preapproved.includes(a.id)}
                    onIsOnChange={() => bridge.togglePreapproval(collection.id, a.id)}
                  />
                ))}
              </VStack>
            </Host>
            <RNText style={styles.section}>{searching ? 'Finding contents' : `Contents · ${items.length}`}</RNText>
            <RNText style={styles.hint}>Found by meaning for “{collection.query}”. This is what an agent could receive.</RNText>
          </View>
        }
        empty={searching ? null : <RNText style={styles.hint}>Nothing in memory matches this collection yet.</RNText>}
      />
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  section: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 4, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', color: PlatformColor('secondaryLabel') },
  hint: { paddingHorizontal: 16, paddingBottom: 10, fontSize: 13, color: PlatformColor('tertiaryLabel') },
});
