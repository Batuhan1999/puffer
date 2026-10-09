import {
  ContentUnavailableView,
  Host,
  Label,
  LabeledContent,
  List,
  Picker,
  ProgressView,
  Section,
  Text,
} from '@expo/ui/swift-ui';
import { onTapGesture, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchBarCommands } from 'react-native-screens/lib/typescript/types';

import type { Item, Query } from '@/domain';
import { ItemRow } from '@/ui/c/ItemRow';
import { usePrefs } from '@/ui/c/prefs';
import { SetupPrompt } from '@/ui/c/SetupPrompt';
import { usePuffer, useSearch } from '@/store';

const SUGGESTIONS = [
  'receipt from the bakery',
  'deposit amount in my lease',
  'passport photo page',
  'boarding pass',
  'warranty and product photo',
];

type Scope = 'all' | 'photo' | 'passage';

export default function SearchScreen() {
  const router = useRouter();
  const { ready, model, counts, items } = usePuffer();
  const prefs = usePrefs();
  const { setLastTimings } = prefs;
  const [text, setText] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const bar = useRef<SearchBarCommands>(null);

  const trimmed = text.trim();
  const query = useMemo<Query | null>(() => (trimmed ? { kind: 'text', text: trimmed } : null), [trimmed]);
  const { result, searching, error } = useSearch(query, prefs);

  useEffect(() => {
    if (result) setLastTimings(result.timings);
  }, [result, setLastTimings]);

  const open = (item: Item) => router.push({ pathname: '/item/[id]', params: { id: item.id } });
  const pick = (suggestion: string) => {
    setText(suggestion);
    bar.current?.setText(suggestion);
  };

  const hits = (result?.hits ?? []).filter((h) => scope === 'all' || h.item.kind === scope).slice(0, 60);
  const searchBar = (
    <Stack.SearchBar
      ref={bar}
      placement="automatic"
      placeholder="Describe a photo or document"
      autoCapitalize="none"
      onChangeText={(e) => setText(e.nativeEvent.text)}
    />
  );

  if (!ready && model.phase !== 'checking' && model.phase !== 'loading') {
    return (
      <>
        {searchBar}
        <SetupPrompt
          title="Set up your memory"
          description="Download the on-device model, then choose photos and documents to remember. Nothing leaves this iPhone."
          systemImage="brain.head.profile"
        />
      </>
    );
  }

  if (ready && items.length === 0) {
    return (
      <>
        {searchBar}
        <SetupPrompt
          title="Nothing to search yet"
          description="Add your photos or a folder of documents, and ask for things in your own words."
          systemImage="photo.on.rectangle.angled"
          action="Choose what to remember"
        />
      </>
    );
  }

  if (query && !searching && result && hits.length === 0 && !error) {
    return (
      <>
        {searchBar}
        <Host style={{ flex: 1 }}>
          <ContentUnavailableView
            title={`No matches for “${trimmed}”`}
            description="Try describing what is in the photo, or a phrase from the document."
            systemImage="magnifyingglass"
          />
        </Host>
      </>
    );
  }

  return (
    <>
      {searchBar}
      <Host style={{ flex: 1 }}>
        <List>
          {!query && (
            <>
              <Section title="Try asking">
                {SUGGESTIONS.map((s) => (
                  <Label key={s} title={s} systemImage="magnifyingglass" modifiers={[onTapGesture(() => pick(s))]} />
                ))}
              </Section>
              <Section title="In your memory" footer={<Text>Search works in any language, across photos and documents together.</Text>}>
                <LabeledContent label="Photos">
                  <Text>{String(counts.photo)}</Text>
                </LabeledContent>
                <LabeledContent label="Document passages">
                  <Text>{String(counts.passage)}</Text>
                </LabeledContent>
              </Section>
            </>
          )}
          {query && (
            <>
              <Section>
                <Picker selection={scope} onSelectionChange={setScope} modifiers={[pickerStyle('segmented')]}>
                  <Text modifiers={[tag('all')]}>All</Text>
                  <Text modifiers={[tag('photo')]}>Photos</Text>
                  <Text modifiers={[tag('passage')]}>Documents</Text>
                </Picker>
              </Section>
              {searching && !result && (
                <Section>
                  <ProgressView>
                    <Text>Searching</Text>
                  </ProgressView>
                </Section>
              )}
              {error && (
                <Section>
                  <Label title={error} systemImage="exclamationmark.triangle" />
                </Section>
              )}
              {hits.length > 0 && (
                <Section title={`${hits.length} best matches`}>
                  {hits.map((h) => (
                    <ItemRow key={h.item.id} item={h.item} onPress={() => open(h.item)} />
                  ))}
                </Section>
              )}
            </>
          )}
        </List>
      </Host>
    </>
  );
}
