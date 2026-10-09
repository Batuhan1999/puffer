import { Button, ContentUnavailableView, Form, Host, Label, LabeledContent, ProgressView, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { buttonStyle, font, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';

import type { Query } from '@/domain';
import { useAgentPreview } from '@/ui/c/agents';
import { documentName, snippet, sourceLabel } from '@/ui/c/format';
import { usePrefs } from '@/ui/c/prefs';
import { useSearch } from '@/store';

export default function RequestScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { requests, decide } = useAgentPreview();
  const prefs = usePrefs();
  const request = requests.find((r) => r.id === id);
  const query = useMemo<Query | null>(() => (request ? { kind: 'text', text: request.question } : null), [request]);
  const { result, searching } = useSearch(query, prefs);
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [images, setImages] = useState<Record<string, boolean>>({});

  if (!request) {
    return (
      <Host style={{ flex: 1 }}>
        <ContentUnavailableView title="Request not found" systemImage="questionmark.circle" />
      </Host>
    );
  }

  const hits = (result?.hits ?? []).slice(0, 5);
  const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
  const shared = hits.filter((h) => !excluded[h.item.id]).length;
  const settled = request.decision !== 'pending';
  const finish = (d: 'approved' | 'denied') => {
    decide(request.id, d);
    router.back();
  };

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section footer={<Text>Preview only. This request is simulated, and no real agent received anything.</Text>}>
          <LabeledContent label="From">
            <Text>{request.agent}</Text>
          </LabeledContent>
          <Text modifiers={[font({ size: 17, weight: 'medium' })]}>{`“${request.question}”`}</Text>
        </Section>
        <Section
          title="What would be shared"
          footer={<Text>Only the selected snippets and photos would leave this iPhone. Photos are shared as an image only if you allow it. The index and vectors are never shared.</Text>}>
          {searching && !result && (
            <ProgressView>
              <Text>Finding matches</Text>
            </ProgressView>
          )}
          {result && hits.length === 0 && <Text modifiers={[secondary]}>Nothing in your memory matches this question.</Text>}
          {hits.map((h) =>
            h.item.kind === 'passage' ? (
              <Toggle
                key={h.item.id}
                isOn={!excluded[h.item.id]}
                onIsOnChange={(on) => setExcluded((e) => ({ ...e, [h.item.id]: !on }))}
                systemImage="doc.text">
                <Text>{documentName(h.item)}</Text>
                <Text modifiers={[font({ size: 13 }), secondary]}>{`${sourceLabel(h.item)} · ${snippet(h.item, 90)}`}</Text>
              </Toggle>
            ) : (
              <Toggle
                key={h.item.id}
                isOn={!!images[h.item.id]}
                onIsOnChange={(on) => setImages((m) => ({ ...m, [h.item.id]: on }))}
                systemImage="photo">
                <Text>{h.item.title}</Text>
                <Text modifiers={[font({ size: 13 }), secondary]}>Share this photo</Text>
              </Toggle>
            ),
          )}
        </Section>
        <Section>
          {settled ? (
            <Label
              title={request.decision === 'approved' ? 'You approved this in the preview' : 'You denied this in the preview'}
              systemImage={request.decision === 'approved' ? 'checkmark.circle' : 'xmark.circle'}
            />
          ) : (
            <>
              <Button label={`Approve and share ${shared} snippet${shared === 1 ? '' : 's'}`} systemImage="checkmark" onPress={() => finish('approved')} modifiers={[buttonStyle('borderedProminent')]} />
              <Button label="Deny" role="destructive" systemImage="xmark" onPress={() => finish('denied')} />
            </>
          )}
        </Section>
      </Form>
    </Host>
  );
}
