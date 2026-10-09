import { Button, ContentUnavailableView, Host, List, Section, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { Stack, router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PlatformColor, StyleSheet, Text as RNText, View } from 'react-native';
import type { SearchBarCommands } from 'react-native-screens';

import { usePuffer, useSearch } from '@/store';
import { FilterBar } from '@/ui/b/FilterBar';
import { Filter, ItemGrid } from '@/ui/b/ItemGrid';
import { usePrefs } from '@/ui/b/prefs';
import { SUGGESTIONS } from '@/ui/b/suggestions';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function Search() {
  const { ready, counts } = usePuffer();
  const { options, recent, remember, forgetRecent, reportTimings } = usePrefs();
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const bar = useRef<SearchBarCommands>(null);

  const trimmed = text.trim();
  const query = useMemo(() => (trimmed ? { kind: 'text' as const, text: trimmed } : null), [trimmed]);
  const { result, searching, error } = useSearch(query, options);
  const hits = useMemo(() => (result?.hits ?? []).map((h) => h.item), [result]);

  useEffect(() => {
    if (result) reportTimings(result.timings);
  }, [result, reportTimings]);

  const pick = (q: string) => {
    bar.current?.setText(q);
    setText(q);
    remember(q);
  };

  const needsModel = options.mode !== 'keyword' && !ready;
  const nothingIndexed = counts.photo + counts.passage === 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Search' }} />
      <Stack.SearchBar
        ref={bar}
        placeholder="Describe what you are looking for"
        placement="integrated"
        hideWhenScrolling={false}
        autoCapitalize="none"
        onChangeText={(e) => setText(e.nativeEvent.text)}
        onSearchButtonPress={(e) => remember(e.nativeEvent.text)}
        onCancelButtonPress={() => setText('')}
      />
      {needsModel || nothingIndexed ? (
        <Host style={styles.fill}>
          <VStack spacing={12}>
            <ContentUnavailableView
              title={needsModel ? 'Puffer is not set up yet' : 'Nothing to search yet'}
              systemImage={needsModel ? 'arrow.down.circle' : 'tray'}
              description={
                needsModel
                  ? 'The on-device model has to be downloaded once before search works.'
                  : 'Add photos, documents or a folder on the Memory tab. Then describe what you need here.'
              }
            />
            <Button label="Open Memory" systemImage="photo.on.rectangle.angled" onPress={() => router.push('/memory')} modifiers={[buttonStyle('bordered')]} />
          </VStack>
        </Host>
      ) : query ? (
        <ItemGrid
          items={hits}
          filter={filter}
          onPress={(item) => {
            remember(trimmed);
            router.push(`/search/item/${encodeURIComponent(item.id)}`);
          }}
          header={
            <View>
              <FilterBar filter={filter} onChange={setFilter} />
              <View style={styles.countRow}>
                {searching ? <ActivityIndicator size="small" /> : null}
                <RNText style={styles.count}>
                  {searching && !result ? 'Searching' : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
                </RNText>
              </View>
            </View>
          }
          empty={
            searching ? null : (
              <Host style={styles.emptyHost}>
                <ContentUnavailableView
                  title={error ? 'Search failed' : 'No matches'}
                  systemImage={error ? 'exclamationmark.triangle' : 'magnifyingglass'}
                  description={error ?? 'Try describing it differently, or in another language. Puffer matches meaning, not file names.'}
                />
              </Host>
            )
          }
        />
      ) : (
        <Host style={styles.fill}>
          <List>
            {recent.length > 0 && (
              <Section title="Recent">
                {recent.map((q) => (
                  <Button key={q} label={q} systemImage="clock.arrow.circlepath" onPress={() => pick(q)} modifiers={[buttonStyle('plain')]} />
                ))}
                <Button label="Clear recent" role="destructive" onPress={forgetRecent} />
              </Section>
            )}
            {SUGGESTIONS.map((group) => (
              <Section key={group.title} title={group.title}>
                {group.items.map((s) => (
                  <Button key={s.text} label={s.text} systemImage={s.symbol} onPress={() => pick(s.text)} modifiers={[buttonStyle('plain')]} />
                ))}
              </Section>
            ))}
            <Section>
              <Text modifiers={[secondary]}>
                Ask in any language. A photo is found from its pixels, a document from its words, and a query in one language finds text written in another.
              </Text>
            </Section>
          </List>
        </Host>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  emptyHost: { height: 360 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  count: { fontSize: 13, color: PlatformColor('secondaryLabel') },
});
