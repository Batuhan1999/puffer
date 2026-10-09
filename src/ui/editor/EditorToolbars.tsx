import { type SFSymbol, SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ActionSheetIOS, PlatformColor, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AttachmentSource } from '../../../modules/puffer-native/src';
import type { EditorCommand, FormatState, Highlight, TableAction } from './types';

export const ACCESSORY_HEIGHT = 44;

const HIGHLIGHT_COLORS: readonly { color: Highlight; name: string; value: string }[] = [
  { color: 'purple', name: 'Purple', value: '#AF52DE' },
  { color: 'pink', name: 'Pink', value: '#FF2D55' },
  { color: 'orange', name: 'Orange', value: '#FF9500' },
  { color: 'mint', name: 'Mint', value: '#00C7BE' },
  { color: 'blue', name: 'Blue', value: '#007AFF' },
];

const ATTACH: readonly { source: AttachmentSource; title: string }[] = [
  { source: 'photos', title: 'Choose Photo' },
  { source: 'camera', title: 'Take Photo' },
  { source: 'scan', title: 'Scan Documents' },
  { source: 'files', title: 'Attach File' },
  { source: 'drawing', title: 'Drawing' },
];

const TABLE: readonly { action: TableAction; title: string }[] = [
  { action: 'addRowBefore', title: 'Add Row Above' },
  { action: 'addRowAfter', title: 'Add Row Below' },
  { action: 'addColumnBefore', title: 'Add Column Before' },
  { action: 'addColumnAfter', title: 'Add Column After' },
  { action: 'deleteRow', title: 'Delete Row' },
  { action: 'deleteColumn', title: 'Delete Column' },
  { action: 'deleteTable', title: 'Delete Table' },
];

function sheet<T>(options: readonly { title: string; value: T }[], pick: (value: T) => void, destructiveTitle?: string) {
  const titles = [...options.map((o) => o.title), 'Cancel'];
  ActionSheetIOS.showActionSheetWithOptions(
    { options: titles, cancelButtonIndex: titles.length - 1, destructiveButtonIndex: destructiveTitle ? titles.indexOf(destructiveTitle) : undefined },
    (index) => { if (index < options.length) pick(options[index].value); },
  );
}

function Icon({ name, label, onPress, onLongPress, on = false, tint }: { name: SFSymbol; label: string; onPress: () => void; onLongPress?: () => void; on?: boolean; tint?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={6}
      style={({ pressed }) => [styles.icon, on && styles.on, pressed && styles.pressed]}>
      <SymbolView name={name} size={20} tintColor={tint ?? PlatformColor('label')} />
    </Pressable>
  );
}

/** Apple Notes' bar above the keyboard: Aa, checklist, table, attachments, hide keyboard. */
export function KeyboardAccessory({ format, run, onFormat, onAttach, onHide }: {
  format: FormatState;
  run: (command: EditorCommand) => void;
  onFormat: () => void;
  onAttach: (source: AttachmentSource) => void;
  onHide: () => void;
}) {
  const table = () => {
    if (!format.inTable) return run({ kind: 'insertTable' });
    sheet(TABLE.map((t) => ({ title: t.title, value: t.action })), (action) => run({ kind: 'table', action }), 'Delete Table');
  };
  return (
    <View style={styles.accessory}>
      <Icon name="textformat" label="Format" onPress={onFormat} />
      <Icon name="checklist" label="Checklist" onPress={() => run({ kind: 'list', list: 'checklist' })} />
      <Icon name="tablecells" label="Table" onPress={table} />
      <Icon name="paperclip" label="Attach" onPress={() => sheet(ATTACH.map((a) => ({ title: a.title, value: a.source })), onAttach)} />
      <Icon name="keyboard.chevron.compact.down" label="Hide Keyboard" onPress={onHide} />
    </View>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

const STYLE_CHIPS = [
  { style: 'title', title: 'Title', text: { fontSize: 20, fontWeight: '700' } },
  { style: 'heading', title: 'Heading', text: { fontSize: 17, fontWeight: '700' } },
  { style: 'subheading', title: 'Subheading', text: { fontSize: 15, fontWeight: '600' } },
  { style: 'body', title: 'Body', text: { fontSize: 15 } },
  { style: 'mono', title: 'Monostyled', text: { fontSize: 14, fontFamily: 'Menlo' } },
] as const;

/** Apple Notes' Aa panel, shown where the keyboard was. */
export function FormatPanel({ format, height, bottomInset, highlight, run, onHighlightColor, onClose }: {
  format: FormatState;
  height: number;
  /** The home indicator's height, kept clear at the bottom. */
  bottomInset: number;
  /** The color the highlighter applies, last picked. */
  highlight: Highlight;
  run: (command: EditorCommand) => void;
  onHighlightColor: (color: Highlight) => void;
  onClose: () => void;
}) {
  const highlightValue = HIGHLIGHT_COLORS.find((h) => h.color === (format.highlight ?? highlight))?.value;
  const pickHighlight = () =>
    sheet([...HIGHLIGHT_COLORS.map((h) => ({ title: h.name, value: h.color as Highlight | null })), { title: 'Remove Highlight', value: null }], (color) => {
      if (color) onHighlightColor(color);
      run({ kind: 'highlight', color });
    });
  return (
    <View style={[styles.panel, { height, paddingBottom: bottomInset }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Format</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close Format" onPress={onClose} hitSlop={8}>
          <SymbolView name="xmark.circle.fill" size={28} tintColor={PlatformColor('tertiaryLabel')} />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="always">
        {STYLE_CHIPS.map((chip) => {
          const on = format.block === chip.style;
          return (
            <Pressable key={chip.style} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => run({ kind: 'block', style: chip.style })} style={[styles.chip, on && styles.on]}>
              <Text style={[styles.chipText, chip.text]}>{chip.title}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.row}>
        <Group>
          <Icon name="bold" label="Bold" on={format.marks.includes('bold')} onPress={() => run({ kind: 'mark', mark: 'bold' })} />
          <Icon name="italic" label="Italic" on={format.marks.includes('italic')} onPress={() => run({ kind: 'mark', mark: 'italic' })} />
          <Icon name="underline" label="Underline" on={format.marks.includes('underline')} onPress={() => run({ kind: 'mark', mark: 'underline' })} />
          <Icon name="strikethrough" label="Strikethrough" on={format.marks.includes('strike')} onPress={() => run({ kind: 'mark', mark: 'strike' })} />
        </Group>
        <Group>
          <Icon
            name="highlighter"
            label="Highlight"
            on={format.highlight !== null}
            tint={highlightValue}
            onPress={() => run({ kind: 'highlight', color: format.highlight ? null : highlight })}
            onLongPress={pickHighlight}
          />
        </Group>
      </View>
      <View style={styles.row}>
        <Group>
          <Icon name="list.bullet" label="Bulleted List" on={format.list === 'bullet'} onPress={() => run({ kind: 'list', list: 'bullet' })} />
          <Icon name="list.dash" label="Dashed List" on={format.list === 'dash'} onPress={() => run({ kind: 'list', list: 'dash' })} />
          <Icon name="list.number" label="Numbered List" on={format.list === 'number'} onPress={() => run({ kind: 'list', list: 'number' })} />
        </Group>
        <Group>
          <Icon name="text.quote" label="Block Quote" on={format.quoted} onPress={() => run({ kind: 'quote' })} />
        </Group>
        <Group>
          <Icon name="decrease.indent" label="Outdent" onPress={() => run({ kind: 'indent', delta: -1 })} />
          <Icon name="increase.indent" label="Indent" onPress={() => run({ kind: 'indent', delta: 1 })} />
        </Group>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  accessory: {
    height: ACCESSORY_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    backgroundColor: PlatformColor('secondarySystemBackground'),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PlatformColor('separator'),
  },
  icon: { minWidth: 40, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, flex: 1 },
  on: { backgroundColor: 'rgba(229, 160, 13, 0.28)' },
  pressed: { opacity: 0.5 },
  panel: { backgroundColor: PlatformColor('secondarySystemBackground'), paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 17, fontWeight: '600', color: PlatformColor('label') },
  chipRow: { flexGrow: 0, height: 44 },
  chips: { gap: 8, alignItems: 'center' },
  chip: { height: 44, paddingHorizontal: 14, borderRadius: 10, justifyContent: 'center', backgroundColor: PlatformColor('tertiarySystemBackground') },
  chipText: { color: PlatformColor('label') },
  row: { flexDirection: 'row', gap: 10 },
  group: { flexDirection: 'row', flexGrow: 1, borderRadius: 10, padding: 2, backgroundColor: PlatformColor('tertiarySystemBackground') },
});
