import { ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, PlatformColor, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Hit } from '@/domain';
import { errorText, usePuffer } from '@/store';
import { useAgents } from '@/ui/b/agents';
import { PassageRow, Thumb } from '@/ui/b/ItemGrid';
import { usePrefs } from '@/ui/b/prefs';

const SHARE_LIMIT = 6;

export default function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bridge = useAgents();
  const request = bridge.requests.find((r) => r.id === id);
  const { search } = usePuffer();
  const { options } = usePrefs();
  const { width } = useWindowDimensions();
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const question = request?.question;
  useEffect(() => {
    if (!question) return;
    let live = true;
    search({ kind: 'text', text: question }, options).then(
      (r) => live && setHits(r.hits.slice(0, SHARE_LIMIT)),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [question, search, options]);

  const photos = useMemo(() => (hits ?? []).filter((h) => h.item.kind === 'photo'), [hits]);
  const snippets = useMemo(() => (hits ?? []).filter((h) => h.item.kind === 'passage'), [hits]);

  if (!request) {
    return (
      <Host style={styles.fill}>
        <ContentUnavailableView title="Request not found" systemImage="questionmark.circle" />
      </Host>
    );
  }
  const agent = bridge.agent(request.agentId);
  const preapproved = bridge.collections.filter((c) => c.preapproved.includes(agent.id));
  const pending = request.status === 'pending';
  const decide = (status: 'approved' | 'denied') => {
    bridge.decide(request.id, status, status === 'approved' ? { photos: photos.length, snippets: snippets.length } : undefined);
    router.back();
  };
  const thumb = (width - 16 * 2 - 6 * 2) / 3;

  return (
    <>
      <Stack.Screen options={{ title: agent.name, headerLargeTitleEnabled: false }} />
      {pending && (
        <Stack.Toolbar placement="bottom">
          <Stack.Toolbar.Button onPress={() => decide('denied')} icon="hand.raised">
            <Stack.Toolbar.Label>Deny</Stack.Toolbar.Label>
          </Stack.Toolbar.Button>
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.Button onPress={() => decide('approved')} variant="prominent" icon="checkmark" disabled={!hits}>
            <Stack.Toolbar.Label>Approve and send</Stack.Toolbar.Label>
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.preview}>
          <SymbolView name="eye" size={14} tintColor={PlatformColor('systemOrange')} />
          <Text style={styles.previewText}>Preview. This request was generated on this phone.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.caption}>{agent.name} asks</Text>
          <Text style={styles.question}>{request.question}</Text>
        </View>

        {!pending && (
          <View style={[styles.card, styles.decided]}>
            <SymbolView
              name={request.status === 'approved' ? 'checkmark.circle.fill' : 'xmark.circle.fill'}
              size={20}
              tintColor={PlatformColor(request.status === 'approved' ? 'systemGreen' : 'systemRed')}
            />
            <Text style={styles.body}>
              {request.status === 'approved'
                ? `Approved. ${request.shared?.photos ?? 0} photos and ${request.shared?.snippets ?? 0} snippets were shared.`
                : 'Denied. Nothing was shared.'}
            </Text>
          </View>
        )}

        <Text style={styles.section}>{pending ? 'What would be shared' : 'What matched'}</Text>
        {!hits && !error && <ActivityIndicator style={styles.spinner} />}
        {error && <Text style={styles.error}>{error}</Text>}
        {hits && hits.length === 0 && <Text style={styles.body}>Nothing in memory matches this question. Approving would send an empty answer.</Text>}
        {photos.length > 0 && (
          <View style={styles.photos}>
            {photos.map((h) => (
              <Thumb key={h.item.id} item={h.item} size={thumb} onPress={() => router.push(`/agents/item/${encodeURIComponent(h.item.id)}`)} />
            ))}
          </View>
        )}
        {snippets.map((h) => (
          <PassageRow key={h.item.id} item={h.item} onPress={() => router.push(`/agents/item/${encodeURIComponent(h.item.id)}`)} />
        ))}

        <Text style={styles.section}>What stays here</Text>
        <Text style={styles.body}>
          The index, the vectors and every photo or passage not listed above. The agent receives only the captions, snippets and images shown here.
        </Text>
        {preapproved.length > 0 && (
          <>
            <Text style={styles.section}>Pre-approved for this agent</Text>
            <Text style={styles.body}>
              {preapproved.map((c) => c.name).join(', ')}. Questions that match these collections would be answered without asking.
            </Text>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: 48 },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 12 },
  previewText: { fontSize: 13, color: PlatformColor('systemOrange') },
  card: { margin: 16, marginBottom: 0, padding: 16, borderRadius: 14, backgroundColor: PlatformColor('secondarySystemBackground'), gap: 4 },
  decided: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  caption: { fontSize: 13, color: PlatformColor('secondaryLabel') },
  question: { fontSize: 20, fontWeight: '600', color: PlatformColor('label') },
  section: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', color: PlatformColor('secondaryLabel') },
  body: { paddingHorizontal: 16, fontSize: 15, lineHeight: 21, color: PlatformColor('label'), flexShrink: 1 },
  error: { paddingHorizontal: 16, color: PlatformColor('systemRed') },
  spinner: { marginVertical: 16 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingBottom: 8 },
});
