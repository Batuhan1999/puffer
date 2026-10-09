import { HStack, Image, ProgressView, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { font, lineLimit, monospacedDigit, padding, progressViewStyle } from '@expo/ui/swift-ui/modifiers';
import { useEffect } from 'react';
import { Alert } from 'react-native';

import { usePuffer, type Store } from '@/store';

import { blue, green, secondary } from './colors';
import { megabytes } from './format';
import type { SymbolName } from './rows';

export type Activity =
  | { kind: 'progress'; symbol: SymbolName; title: string; detail: string; fraction: number | null }
  | { kind: 'notice'; symbol: SymbolName; title: string };

export function activityOf({ model, notice }: Pick<Store, 'model' | 'notice'>): Activity | null {
  if (model.phase === 'downloading') {
    return {
      kind: 'progress',
      symbol: 'arrow.down.circle',
      title: 'Downloading the search model',
      detail: `${megabytes(model.written)} of ${megabytes(model.total)}`,
      fraction: model.total ? model.written / model.total : null,
    };
  }
  if (model.phase === 'loading') {
    return { kind: 'progress', symbol: 'cpu', title: 'Preparing search', detail: 'A few seconds', fraction: null };
  }
  if (notice?.tone === 'info') return { kind: 'notice', symbol: 'checkmark.circle.fill', title: notice.text };
  return null;
}

/** The top of Folders while the search model downloads or loads, or for a short notice. */
export function ActivitySection() {
  const activity = activityOf(usePuffer());
  if (!activity) return null;
  return (
    <Section>
      <VStack alignment="leading" spacing={8} modifiers={[padding({ vertical: 2 })]}>
        <HStack spacing={12}>
          <Image systemName={activity.symbol} modifiers={[font({ size: 17 }), activity.kind === 'notice' ? green : blue]} />
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), lineLimit(1)]}>{activity.title}</Text>
          <Spacer />
          {activity.kind === 'progress' ? (
            <Text modifiers={[font({ size: 13 }), monospacedDigit(), secondary, lineLimit(1)]}>{activity.detail}</Text>
          ) : null}
        </HStack>
        {activity.kind === 'progress' && activity.fraction !== null ? (
          <ProgressView value={activity.fraction} modifiers={[progressViewStyle('linear')]} />
        ) : null}
      </VStack>
    </Section>
  );
}

export function useNoticeHandling() {
  const { notice, dismissNotice } = usePuffer();
  useEffect(() => {
    if (!notice) return;
    if (notice.tone === 'error') {
      Alert.alert('Something went wrong', notice.text, [{ text: 'OK', onPress: dismissNotice }]);
      return;
    }
    const timer = setTimeout(dismissNotice, 5000);
    return () => clearTimeout(timer);
    // dismissNotice is a fresh closure on every store render; keying on the notice keeps the timer from resetting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);
}
