import { Host, HStack, Image, Label, List, ProgressView, Section, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import { font } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

import type { Item } from '@/domain';
import { usePuffer, useSearch } from '@/store';
import { blue, secondary } from '@/ui/colors';
import { ago, plural } from '@/ui/format';
import { usePreview } from '@/ui/preview';
import { ItemLabel } from '@/ui/rows';
import { Unavailable } from '@/ui/states';

const CANDIDATES = 6;

// Text passages near the top are offered by default; photos never are, because an image is the riskiest thing to share.
const offeredByDefault = (item: Item, rank: number) => item.kind === 'passage' && rank < 3;

function approveLabel(chosen: readonly Item[]) {
  const snippets = chosen.filter((item) => item.kind === 'passage').length;
  const photos = chosen.length - snippets;
  const parts = [snippets ? plural(snippets, 'Snippet') : '', photos ? plural(photos, 'Photo') : ''].filter(Boolean);
  return parts.length ? `Approve and Share ${parts.join(', ')}` : 'Approve and Share';
}

export default function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const preview = usePreview();
  const { items } = usePuffer();
  const router = useRouter();
  const request = preview.requests.find((r) => r.id === id);
  const agent = request ? preview.agents.find((a) => a.id === request.agentId) : undefined;
  const pending = request?.status.kind === 'pending';
  const { result } = useSearch(request && pending ? { kind: 'text', text: request.question } : null, preview.prefs);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  if (!request || !agent) {
    return (
      <>
        <Stack.Screen options={{ title: 'Request' }} />
        <Unavailable title="Request Not Found" systemImage="questionmark.circle" description="This request is gone." />
      </>
    );
  }

  const candidates = result?.hits.slice(0, CANDIDATES).map((h) => h.item) ?? [];
  const included = (item: Item, rank: number) => picked[item.id] ?? offeredByDefault(item, rank);
  const chosen = candidates.filter(included);
  const allowed = preview.collections.filter((c) => agent.allowed.includes(c.id)).map((c) => c.name);

  const resolve = (shared: boolean) => {
    preview.resolveRequest(
      request.id,
      shared ? { kind: 'shared', itemIds: chosen.map((i) => i.id), at: Date.now() } : { kind: 'denied', at: Date.now() },
    );
    router.back();
  };

  return (
    <>
      {/* A large title keeps the header row free for the long approval button. */}
      <Stack.Screen options={{ title: pending ? 'Review Request' : 'Request', headerLargeTitleEnabled: true }} />
      {pending ? (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button onPress={() => resolve(false)}>Deny</Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button variant="prominent" disabled={!chosen.length} onPress={() => resolve(true)}>
              {approveLabel(chosen)}
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      ) : (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button variant="done" onPress={() => router.back()}>
            Done
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <Host style={{ flex: 1 }}>
        <List>
          <Section
            footer={
              <Text>
                {`Simulated request. In the finished app it would reach this iPhone through a small relay from ${agent.name}.`}
              </Text>
            }
          >
            <HStack spacing={12}>
              <Image systemName={agent.symbol} size={26} modifiers={[blue]} />
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ size: 15, weight: 'semibold' })]}>{`${agent.name} asks`}</Text>
                <Text modifiers={[font({ size: 13 }), secondary]}>{`${agent.role} · ${ago(request.receivedAt)}`}</Text>
              </VStack>
            </HStack>
            <Text modifiers={[font({ size: 22, weight: 'semibold' })]}>{`“${request.question}”`}</Text>
          </Section>

          {request.status.kind === 'pending' ? (
            <Section
              title="What Would Be Shared"
              footer={
                <Text>
                  Text passages go as short snippets. A photo leaves only if you turn it on. Turn off anything you want to
                  keep.
                </Text>
              }
            >
              {!result ? (
                <ProgressView />
              ) : candidates.length ? (
                candidates.map((item, rank) => (
                  <Toggle
                    key={item.id}
                    isOn={included(item, rank)}
                    onIsOnChange={(on) => setPicked((p) => ({ ...p, [item.id]: on }))}
                  >
                    <ItemLabel item={item} />
                  </Toggle>
                ))
              ) : (
                <Text modifiers={[secondary]}>Nothing in your library matches, so there is nothing to share.</Text>
              )}
            </Section>
          ) : (
            <Section
              title={request.status.kind === 'shared' ? 'You Shared' : 'You Denied This Request'}
              footer={<Text>{`Preview: nothing was actually sent to ${agent.name}.`}</Text>}
            >
              {request.status.kind === 'shared' && request.status.itemIds.length ? (
                request.status.itemIds.map((itemId) => {
                  const item = items.find((i) => i.id === itemId);
                  return item ? <ItemLabel key={itemId} item={item} /> : null;
                })
              ) : (
                <Text modifiers={[secondary]}>
                  {request.status.kind === 'shared' ? 'Nothing.' : 'No items left this iPhone.'}
                </Text>
              )}
            </Section>
          )}

          {allowed.length ? (
            <Section title="Open Without Asking">
              <Text>{`${allowed.join(', ')} ${allowed.length === 1 ? 'is' : 'are'} open to ${agent.name}. Requests answered entirely from ${allowed.length === 1 ? 'it' : 'them'} would skip this screen.`}</Text>
            </Section>
          ) : null}

          <Section title="Never Leaves This iPhone">
            <Label title="Your search index" systemImage="lock.fill" />
            <Label title="Vectors and embeddings" systemImage="lock.fill" />
            <Label title="Anything you did not turn on" systemImage="lock.fill" />
          </Section>
        </List>
      </Host>
    </>
  );
}
