import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { font, frame, lineLimit } from '@expo/ui/swift-ui/modifiers';

import type { HistoryEntry } from '@/bridge';

import { secondary } from './colors';
import { ago, readOutcome, requestOutcome } from './format';
import type { SymbolName } from './rows';

/** One read or write an agent did. */
export function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const at = entry.at;
  const [name, symbol, title, detail] =
    entry.kind === 'request'
      ? [
          entry.request.agentName,
          entry.request.writes ? 'square.and.pencil' : 'magnifyingglass',
          entry.request.question,
          entry.request.queuedAt === null ? requestOutcome(entry.request) : `Written while offline · ${requestOutcome(entry.request)}`,
        ]
      : [entry.read.agentName, 'clock.arrow.circlepath', 'Checked for changes', readOutcome(entry.read)];
  return (
    <HStack spacing={12} alignment="top">
      <Image systemName={symbol as SymbolName} modifiers={[frame({ width: 28 }), font({ size: 18 }), secondary]} />
      <VStack alignment="leading" spacing={3}>
        <HStack>
          <Text modifiers={[font({ size: 15, weight: 'semibold' })]}>{name}</Text>
          <Spacer />
          <Text modifiers={[font({ size: 13 }), secondary]}>{ago(at)}</Text>
        </HStack>
        <Text modifiers={[lineLimit(2)]}>{title}</Text>
        <Text modifiers={[font({ size: 13 }), secondary, lineLimit(2)]}>{detail}</Text>
      </VStack>
    </HStack>
  );
}
