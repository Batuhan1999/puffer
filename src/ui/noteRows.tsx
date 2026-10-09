import { Button, HStack, Image, Label, ProgressView, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { disabled, font, foregroundStyle, frame, lineLimit, type ModifierConfig, padding } from '@expo/ui/swift-ui/modifiers';

import { type NoteSummary, rowDate, UNTITLED, useNotes } from '@/notes';

import { secondary, tertiary, yellow } from './colors';
import { plural } from './format';
import type { SymbolName } from './rows';

/** Apple Notes' row: the title, then the date (`at`, the list's sort date) and the first line after the title. */
export function NoteRow({
  note,
  snippet,
  at = note.modifiedAt,
  modifiers,
  onPress,
}: {
  note: NoteSummary;
  snippet?: string;
  at?: number;
  modifiers?: ModifierConfig[];
  onPress: () => void;
}) {
  const preview = snippet ?? note.preview;
  return (
    <Button onPress={onPress} modifiers={modifiers}>
      <VStack alignment="leading" spacing={3}>
        <HStack spacing={6}>
          {note.lastEditor.kind === 'agent' ? <Image systemName="sparkles" modifiers={[font({ size: 13 }), yellow]} /> : null}
          <Text modifiers={[font({ size: 17, weight: 'semibold' }), foregroundStyle('primary'), lineLimit(1)]}>
            {note.title || UNTITLED}
          </Text>
          <Spacer />
        </HStack>
        <HStack spacing={8}>
          <Text modifiers={[font({ size: 15 }), foregroundStyle('primary')]}>{rowDate(at)}</Text>
          <Text modifiers={[font({ size: 15 }), secondary, lineLimit(1)]}>{preview || 'No additional text'}</Text>
          <Spacer />
        </HStack>
      </VStack>
    </Button>
  );
}

/** A folder in the Folders list: a yellow folder, its name and its note count. A picker marks its current one. */
export function FolderRow({
  name,
  count,
  symbol = 'folder',
  accessory = 'chevron',
  onPress,
}: {
  name: string;
  count: number;
  symbol?: SymbolName;
  accessory?: 'chevron' | 'current' | 'none';
  onPress: () => void;
}) {
  return (
    <Button onPress={onPress} modifiers={accessory === 'current' ? [disabled(true)] : undefined}>
      <HStack spacing={12}>
        <Image systemName={symbol} modifiers={[frame({ width: 28 }), font({ size: 20 }), yellow]} />
        <Text modifiers={[foregroundStyle('primary')]}>{name}</Text>
        <Spacer />
        <Text modifiers={[secondary]}>{count.toLocaleString()}</Text>
        {accessory === 'chevron' ? <Image systemName="chevron.right" modifiers={[font({ size: 13, weight: 'semibold' }), tertiary]} /> : null}
        {accessory === 'current' ? <Image systemName="checkmark" modifiers={[font({ size: 15, weight: 'semibold' }), yellow]} /> : null}
      </HStack>
    </Button>
  );
}

/** While imported or edited notes are being made searchable. */
export function NotesIndexingSection() {
  const { indexing } = useNotes();
  if (!indexing || indexing.total === 0) return null;
  return (
    <Section footer={<Text>The notes are already here. Search finds them as they are read.</Text>}>
      <VStack alignment="leading" spacing={8} modifiers={[padding({ vertical: 4 })]}>
        <Label title={`Making ${plural(indexing.total, 'note')} searchable`} systemImage="sparkle.magnifyingglass" />
        <ProgressView value={indexing.done / indexing.total} />
        <Text modifiers={[font({ size: 13 }), secondary]}>{`${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()}`}</Text>
      </VStack>
    </Section>
  );
}
