// Handles puffer://pair?relay=...&key=..., the link the relay prints on first start. Any app or page can open such a
// link, and pairing hands the relay this iPhone's agents, so nothing pairs until the user taps Pair.
import { Button, Host, HStack, Image, Label, List, Section, Text, VStack } from '@expo/ui/swift-ui';
import { disabled, font } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import { useBridge } from '@/bridge';
import { blue, orange, secondary } from '@/ui/colors';
import { alertError, Loading, Unavailable } from '@/ui/states';

/** host[:port] of an http(s) URL, or null. Native validates the link again when pairing. */
function hostOf(url: string): string | null {
  return /^https?:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(url)?.[1] ?? null;
}

export default function Pair() {
  const { relay: target, key } = useLocalSearchParams<{ relay?: string; key?: string }>();
  const bridge = useBridge();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const host = target ? hostOf(target) : null;
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/agents'));

  if (!target || !key || !host) {
    return (
      <>
        <Stack.Screen options={{ title: 'Pair Relay', headerShown: true, headerBackButtonDisplayMode: 'minimal' }} />
        <Unavailable
          title="Pairing Link Incomplete"
          systemImage="exclamationmark.triangle"
          description="Open the link the relay printed."
        />
      </>
    );
  }
  if (!bridge.loaded) return <Loading />;

  const current = bridge.relay.kind === 'paired' ? bridge.relay.url : null;
  const currentHost = current ? (hostOf(current) ?? current) : null;
  const pair = () => {
    setBusy(true);
    bridge.pair(`puffer://pair?relay=${encodeURIComponent(target)}&key=${encodeURIComponent(key)}`).then(
      () => router.replace('/agents'),
      (e) => {
        setBusy(false);
        alertError('Pairing Failed')(e);
      },
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Pair Relay', headerShown: true, headerBackButtonDisplayMode: 'minimal' }} />
      <Host style={{ flex: 1 }}>
        <List>
          <Section
            footer={
              <Text>
                {`Agents then reach Puffer through ${host}. It learns your agents' names and passes on what you share ` +
                  'with them. Pair only with a relay you started yourself.'}
              </Text>
            }
          >
            <HStack spacing={12}>
              <Image systemName="antenna.radiowaves.left.and.right" size={26} modifiers={[blue]} />
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{`Pair with ${host}?`}</Text>
                <Text modifiers={[font({ size: 13 }), secondary]}>{target}</Text>
              </VStack>
            </HStack>
          </Section>

          {current && current !== target ? (
            <Section
              title="Replaces"
              footer={
                <Text>
                  {`Puffer stops using ${currentHost}, and requests waiting there are dropped. Your agents keep their ` +
                    `access but have to reach Puffer through ${host} from now on.`}
                </Text>
              }
            >
              <Label title={currentHost ?? ''} systemImage="arrow.triangle.swap" modifiers={[orange]} />
            </Section>
          ) : current ? (
            <Section footer={<Text>Puffer is already paired with this relay. Pair again only if it printed a new link.</Text>}>
              <Label title={`Paired with ${currentHost}`} systemImage="checkmark.circle" />
            </Section>
          ) : null}

          <Section>
            <Button label={`Pair with ${host}`} systemImage="link" onPress={pair} modifiers={[disabled(busy)]} />
            <Button label="Don't Pair" role="cancel" onPress={leave} />
          </Section>
        </List>
      </Host>
    </>
  );
}
