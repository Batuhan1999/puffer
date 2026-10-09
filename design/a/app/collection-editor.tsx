import { Button, Form, Host, Image, Picker, Section, Text, TextField } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import { type SymbolName, usePreview } from '@/ui/preview';

const SYMBOLS: readonly SymbolName[] = [
  'square.stack',
  'receipt',
  'signature',
  'airplane',
  'house',
  'cross.case',
  'person.text.rectangle',
  'wineglass',
  'shippingbox',
  'car',
];

const IDEAS: readonly { name: string; query: string; symbol: SymbolName }[] = [
  { name: 'Warranties', query: 'warranty cards, product receipts and serial number labels', symbol: 'shippingbox' },
  { name: 'Wine', query: 'wine bottles and wine labels', symbol: 'wineglass' },
  { name: 'Parking', query: 'a parking spot, level sign or parking ticket', symbol: 'car' },
];

export default function CollectionEditor() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { collections, saveCollection } = usePreview();
  const router = useRouter();
  const existing = collections.find((c) => c.id === id);
  const [name, setName] = useState(existing?.name ?? '');
  const [query, setQuery] = useState(existing?.query ?? '');
  const [symbol, setSymbol] = useState<SymbolName>(existing?.symbol ?? 'square.stack');
  const [revision, setRevision] = useState(0);
  const valid = name.trim().length > 0 && query.trim().length > 0;

  const save = () => {
    saveCollection({ id: existing?.id ?? `c${Date.now()}`, name: name.trim(), query: query.trim(), symbol });
    router.back();
  };

  const applyIdea = (idea: (typeof IDEAS)[number]) => {
    setName(idea.name);
    setQuery(idea.query);
    setSymbol(idea.symbol);
    setRevision((r) => r + 1);
  };

  return (
    <>
      <Stack.Screen options={{ title: existing ? 'Edit Collection' : 'New Collection' }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" disabled={!valid} onPress={save}>
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Host style={{ flex: 1 }} useViewportSizeMeasurement>
        <Form>
          <Section title="Name">
            {/* TextField is uncontrolled; bumping the key is how an idea refills it. */}
            <TextField key={`name-${revision}`} defaultValue={name} placeholder="Warranties" onValueChange={setName} autoFocus={!existing} />
          </Section>
          <Section
            title="What Belongs Here"
            footer={
              <Text>
                Describe it the way you would to a friend. Puffer gathers the photos and passages that match the
                meaning, in any language.
              </Text>
            }
          >
            <TextField
              key={`query-${revision}`}
              defaultValue={query}
              placeholder="warranty cards and product receipts"
              onValueChange={setQuery}
              axis="vertical"
            />
          </Section>
          <Section title="Symbol">
            <Picker<SymbolName> selection={symbol} onSelectionChange={setSymbol} modifiers={[pickerStyle('palette')]}>
              {SYMBOLS.map((s) => (
                <Image key={s} systemName={s} modifiers={[tag(s)]} />
              ))}
            </Picker>
          </Section>
          {existing ? null : (
            <Section title="Ideas">
              {IDEAS.map((idea) => (
                <Button key={idea.name} label={idea.name} systemImage={idea.symbol} onPress={() => applyIdea(idea)} />
              ))}
            </Section>
          )}
        </Form>
      </Host>
    </>
  );
}
