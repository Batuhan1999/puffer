import { Button, Host, HStack, Image, List, Section, Spacer, Text } from '@expo/ui/swift-ui';
import { font, foregroundStyle, frame } from '@expo/ui/swift-ui/modifiers';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import type { SearchBarCommands } from 'react-native-screens';

import { usePuffer, useSearch } from '@/store';
import { secondary } from '@/ui/colors';
import { type SymbolName, usePreview } from '@/ui/preview';
import { Results, type Scope } from '@/ui/results';
import { Loading, Unavailable } from '@/ui/states';

type Example = { text: string; symbol: SymbolName };

const EXAMPLES: readonly { title: string; examples: readonly Example[] }[] = [
  {
    title: 'Money and Paperwork',
    examples: [
      { text: 'receipt from the bakery', symbol: 'receipt' },
      { text: 'the deposit amount in my lease', symbol: 'signature' },
      { text: 'notice period in the rental contract', symbol: 'calendar' },
      { text: 'warranty for the washing machine', symbol: 'wrench.and.screwdriver' },
    ],
  },
  {
    title: 'Travel and IDs',
    examples: [
      { text: 'boarding pass for the next flight', symbol: 'airplane' },
      { text: 'hotel booking confirmation', symbol: 'bed.double' },
      { text: 'passport photo page', symbol: 'person.text.rectangle' },
      { text: 'vaccination card', symbol: 'cross.case' },
    ],
  },
  {
    title: 'Things You Photographed',
    examples: [
      { text: 'the photo of the parking spot', symbol: 'car' },
      { text: 'the wine label from that trip', symbol: 'wineglass' },
      { text: 'whiteboard with the plan', symbol: 'rectangle.and.pencil.and.ellipsis' },
      { text: 'serial number sticker', symbol: 'barcode' },
    ],
  },
];

export default function SearchScreen() {
  const puffer = usePuffer();
  const preview = usePreview();
  const { recordTimings, remember } = preview;
  const bar = useRef<SearchBarCommands>(null);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const query = text.trim();
  const { result, error } = useSearch(query ? { kind: 'text', text: query } : null, preview.prefs);

  useEffect(() => {
    if (result) recordTimings(result.timings);
  }, [result, recordTimings]);

  const pick = (q: string) => {
    bar.current?.setText(q);
    setText(q);
    remember(q);
  };

  const empty = puffer.counts.photo + puffer.counts.passage === 0;
  const waiting = preview.prefs.mode !== 'keyword' && !puffer.ready;

  let body;
  if (!query) {
    body = empty ? (
      <Unavailable
        title="Nothing to Search Yet"
        systemImage="tray"
        description="Add your photo library or a folder of documents in Library. Puffer reads them on this iPhone."
      />
    ) : (
      <Suggestions onPick={pick} />
    );
  } else if (waiting) {
    body = (
      <Unavailable
        title="Search Is Getting Ready"
        systemImage="hourglass"
        description="Puffer is still preparing its model. Your search will run as soon as it is ready."
      />
    );
  } else if (error) {
    body = <Unavailable title="Search Failed" systemImage="exclamationmark.triangle" description={error} />;
  } else if (!result) {
    body = <Loading />;
  } else if (!result.hits.length) {
    body = (
      <Unavailable
        title={`No Results for “${query}”`}
        systemImage="magnifyingglass"
        description="Try describing it another way, or add the folder it lives in from Library."
      />
    );
  } else {
    body = <Results hits={result.hits} scope={scope} onScope={setScope} />;
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Search' }} />
      <Stack.SearchBar
        ref={bar}
        placeholder="Describe what you are looking for"
        onChangeText={(e) => setText(e.nativeEvent.text)}
        onCancelButtonPress={() => setText('')}
        onSearchButtonPress={(e) => remember(e.nativeEvent.text)}
      />
      {body}
    </>
  );
}

function Suggestion({ text, symbol, onPick }: Example & { onPick: (q: string) => void }) {
  return (
    <Button onPress={() => onPick(text)}>
      <HStack spacing={12}>
        <Image systemName={symbol} modifiers={[frame({ width: 26 }), font({ size: 17 })]} />
        <Text modifiers={[foregroundStyle('primary')]}>{text}</Text>
        <Spacer />
      </HStack>
    </Button>
  );
}

function Suggestions({ onPick }: { onPick: (q: string) => void }) {
  const { recents, clearRecents } = usePreview();
  return (
    <Host style={{ flex: 1 }}>
      <List>
        {recents.length ? (
          <Section
            header={
              <HStack>
                <Text>Recent</Text>
                <Spacer />
                <Button label="Clear" onPress={clearRecents} />
              </HStack>
            }
          >
            {recents.map((q) => (
              <Button key={q} onPress={() => onPick(q)}>
                <HStack spacing={12}>
                  <Image systemName="clock" modifiers={[frame({ width: 26 }), secondary]} />
                  <Text modifiers={[foregroundStyle('primary')]}>{q}</Text>
                  <Spacer />
                </HStack>
              </Button>
            ))}
          </Section>
        ) : null}
        {EXAMPLES.map((group, i) => (
          <Section
            key={group.title}
            title={group.title}
            footer={
              i === EXAMPLES.length - 1 ? (
                <Text>
                  Puffer matches meaning, not exact words. Ask in any language and it also finds documents written in
                  another.
                </Text>
              ) : undefined
            }
          >
            {group.examples.map((example) => (
              <Suggestion key={example.text} text={example.text} symbol={example.symbol} onPick={onPick} />
            ))}
          </Section>
        ))}
      </List>
    </Host>
  );
}
