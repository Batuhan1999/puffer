// Spike: one note in react-native-enriched-html's EnrichedTextInput, with an Apple-Notes-like format bar.
// Saves as a copy (there is no JS API to replace a note's body yet), so a lossy round trip never touches the original.
import { Directory, File, Paths } from 'expo-file-system';
import { router, Stack } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, PlatformColor, Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { EnrichedTextInput, type EnrichedTextInputInstance, type HtmlStyle, type OnChangeStateEvent } from 'react-native-enriched-html';

import { notes, useNotes } from '@/notes';
import { notesTint, notesTintHex } from '@/ui/colors';
import { Loading } from '@/ui/states';

import { HIGHLIGHTS, type Highlight, hasImplicitTitle, htmlToMarkdown, markdownToHtml, NOTE_INDICATOR, TAG_INDICATOR } from './markdown';

const IMAGE = /\.(png|jpe?g|gif|heic|webp)$/i;
const MAX_IMAGE_WIDTH = 280;

const attachmentsDir = (noteId: string) => new Directory(Paths.document, 'NoteAttachments', noteId);

function imageSize(uri: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    Image.getSize(uri, (w, h) => {
      const width = Math.min(w, MAX_IMAGE_WIDTH);
      resolve({ width, height: (h * width) / w });
    }, reject);
  });
}

export type Loaded = { html: string; markdown: string; implicitTitle: boolean; folderId: string };

export async function load(id: string): Promise<Loaded | null> {
  const note = await notes.get(id);
  if (!note) return null;
  const dir = attachmentsDir(id);
  const sizes = new Map<string, { width: number; height: number }>();
  if (dir.exists) {
    for (const f of dir.list()) {
      if (f instanceof File && IMAGE.test(f.name)) sizes.set(f.name, await imageSize(f.uri).catch(() => ({ width: 120, height: 120 })));
    }
  }
  const html = markdownToHtml(note.body, { attachmentsDir: dir.uri.endsWith('/') ? dir.uri : dir.uri + '/', imageSize: (file) => sizes.get(file) });
  return { html, markdown: note.body, implicitTitle: hasImplicitTitle(note.body), folderId: note.folderId };
}

// Apple Notes' highlight colors; text keeps its color, the tint goes behind it. Mirrors the patched HighlightStyle.mm.
export const HIGHLIGHT_SWATCH: Record<Highlight, string> = {
  purple: '#AF52DE',
  pink: '#FF2D55',
  orange: '#FF9500',
  mint: '#00C7BE',
  blue: '#007AFF',
};

type Mention = { indicator: string; text: string };
type Panel = 'none' | 'format' | 'images';

export function EnrichedNoteEditor({ id }: { id: string }) {
  const dark = useColorScheme() === 'dark';
  const { notes: summaries } = useNotes();
  const input = useRef<EnrichedTextInputInstance>(null);
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined);
  const [state, setState] = useState<OnChangeStateEvent | null>(null);
  const [mention, setMention] = useState<Mention | null>(null);
  const [linked, setLinked] = useState<{ id: string; title: string } | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    load(id).then(setLoaded, (e) => Alert.alert('Could not open the note', String(e)));
  }, [id]);

  // Every #tag in every note, for the tag picker.
  useEffect(() => {
    Promise.all(summaries.filter((n) => n.deletedAt === null).map((n) => notes.get(n.id))).then((all) => {
      const found = new Set<string>();
      for (const n of all) for (const m of n?.body.matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu) ?? []) found.add(m[1]);
      setTags([...found].sort());
    });
  }, [summaries]);

  const htmlStyle = useMemo<HtmlStyle>(
    () => ({
      h1: { fontSize: 28, bold: true },
      h2: { fontSize: 22, bold: true },
      h3: { fontSize: 18, bold: true },
      ul: { bulletColor: dark ? '#FFFFFF' : '#000000', bulletSize: 6, marginLeft: 4, gapWidth: 12 },
      ol: { markerColor: dark ? '#FFFFFF' : '#000000', marginLeft: 4, gapWidth: 10 },
      ulCheckbox: { boxSize: 22, gapWidth: 10, marginLeft: 0, boxColor: notesTintHex },
      blockquote: { borderColor: dark ? '#48484A' : '#C7C7CC', borderWidth: 3, gapWidth: 12 },
      codeblock: { color: dark ? '#FFFFFF' : '#000000', backgroundColor: dark ? '#1C1C1E' : '#F2F2F7', borderRadius: 6 },
      code: { color: dark ? '#FFFFFF' : '#000000', backgroundColor: dark ? '#2C2C2E' : '#E5E5EA' },
      a: { color: notesTintHex, textDecorationLine: 'underline' },
      mention: {
        [TAG_INDICATOR]: { color: notesTintHex, backgroundColor: 'transparent', textDecorationLine: 'none' },
        [NOTE_INDICATOR]: { color: notesTintHex, backgroundColor: 'transparent', textDecorationLine: 'underline' },
      },
    }),
    [dark],
  );

  if (loaded === undefined) return <Loading />;
  if (loaded === null) return <Text style={styles.missing}>Note not found</Text>;

  const run = (f: (i: EnrichedTextInputInstance) => void) => () => input.current && f(input.current);
  const active = (key: keyof OnChangeStateEvent) => {
    const s = state?.[key];
    return typeof s === 'object' && s.isActive;
  };

  const body = () => {
    const i = input.current;
    if (!i) return;
    if (active('h1')) i.toggleH1();
    if (active('h2')) i.toggleH2();
    if (active('h3')) i.toggleH3();
  };

  const markdown = async () => {
    const html = (await input.current?.getHTML()) ?? '';
    return htmlToMarkdown(html, { implicitTitle: loaded.implicitTitle });
  };

  const showMarkdown = async () => {
    const md = await markdown();
    Alert.alert(md === loaded.markdown.replace(/\n+$/, '') ? 'Markdown (unchanged)' : 'Markdown (changed)', md);
  };

  const saveCopy = async () => {
    const md = await markdown();
    const copy = await notes.create(md, loaded.folderId);
    const from = attachmentsDir(id);
    if (from.exists) {
      const to = attachmentsDir(copy.id);
      to.create({ intermediates: true, idempotent: true });
      for (const f of from.list()) if (f instanceof File) f.copy(new File(to, f.name));
    }
    router.replace({ pathname: '/notes/enriched/[id]', params: { id: copy.id } });
  };

  const insertImage = async (file: File) => {
    const own = attachmentsDir(id);
    let target = file;
    if (!file.uri.startsWith(own.uri)) {
      own.create({ intermediates: true, idempotent: true });
      target = new File(own, file.name);
      if (!target.exists) file.copy(target);
    }
    const size = await imageSize(target.uri);
    input.current?.setImage(`${target.uri}#${encodeURIComponent(file.name.replace(/\.[^.]+$/, ''))}`, size.width, size.height);
    setPanel('none');
  };

  const pickMention = (choice: { text: string; attributes?: Record<string, string> }) => {
    if (!mention) return;
    input.current?.setMention(mention.indicator, choice.text, choice.attributes);
    setMention(null);
  };

  const suggestions = (): { label: string; pick: () => void }[] => {
    if (!mention) return [];
    const q = mention.text.toLowerCase();
    if (mention.indicator === TAG_INDICATOR) {
      const list = tags.filter((t) => t.toLowerCase().startsWith(q)).slice(0, 8);
      const create = q && !tags.some((t) => t.toLowerCase() === q) ? [mention.text] : [];
      return [...list, ...create].map((t) => ({ label: `#${t}`, pick: () => pickMention({ text: `#${t}` }) }));
    }
    return summaries
      .filter((n) => n.deletedAt === null && n.id !== id && (n.title || 'New Note').toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ label: n.title || 'New Note', pick: () => pickMention({ text: n.title || 'New Note', attributes: { id: n.id } }) }));
  };

  const fg = dark ? '#FFFFFF' : '#000000';
  const chip = (on: boolean) => [styles.chip, { backgroundColor: on ? notesTintHex : dark ? '#2C2C2E' : '#E5E5EA' }];
  const chipText = (on: boolean) => [styles.chipText, { color: on ? '#000000' : fg }];

  return (
    <>
      <Stack.Screen options={{ title: 'Enriched', headerLargeTitleEnabled: false, contentStyle: styles.page }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="doc.plaintext" accessibilityLabel="Show Markdown" tintColor={notesTint} onPress={() => void showMarkdown()} />
        <Stack.Toolbar.Button icon="square.and.arrow.down" accessibilityLabel="Save Copy" tintColor={notesTint} onPress={() => void saveCopy()} />
      </Stack.Toolbar>
      <KeyboardAvoidingView style={styles.page} behavior="padding" keyboardVerticalOffset={100}>
        <EnrichedTextInput
          ref={input}
          defaultValue={loaded.html}
          htmlStyle={htmlStyle}
          style={{ ...styles.input, color: fg }}
          cursorColor={notesTintHex}
          selectionColor={notesTintHex}
          placeholder="Start writing"
          mentionIndicators={[TAG_INDICATOR, NOTE_INDICATOR]}
          textShortcuts={[
            { trigger: '- ', style: 'unordered_list' },
            { trigger: '1. ', style: 'ordered_list' },
            { trigger: '[] ', style: 'checkbox_list' },
          ]}
          onChangeState={(e) => setState(e.nativeEvent)}
          onStartMention={(indicator) => setMention({ indicator, text: '' })}
          onChangeMention={(e) => setMention(e)}
          onEndMention={() => setMention(null)}
          onMentionDetected={(e) => {
            const target = e.indicator === NOTE_INDICATOR ? e.attributes.id : undefined;
            setLinked(target ? { id: target, title: e.text } : null);
          }}
        />
        {mention ? (
          <ScrollView horizontal keyboardShouldPersistTaps="always" style={styles.bar} contentContainerStyle={styles.barContent}>
            {suggestions().map((s) => (
              <Pressable key={s.label} style={chip(false)} onPress={s.pick}>
                <Text style={chipText(false)}>{s.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : linked ? (
          <View style={styles.barContent}>
            <Pressable style={chip(true)} onPress={() => router.push({ pathname: '/notes/enriched/[id]', params: { id: linked.id } })}>
              <Text style={chipText(true)}>Open “{linked.title}”</Text>
            </Pressable>
          </View>
        ) : null}
        {panel === 'format' ? (
          <View style={[styles.panel, { backgroundColor: dark ? '#1C1C1E' : '#F2F2F7' }]}>
            <View style={styles.row}>
              <Pressable style={chip(active('h1'))} onPress={run((i) => !active('h1') && i.toggleH1())}><Text style={[chipText(active('h1')), styles.bold]}>Title</Text></Pressable>
              <Pressable style={chip(active('h2'))} onPress={run((i) => !active('h2') && i.toggleH2())}><Text style={[chipText(active('h2')), styles.bold]}>Heading</Text></Pressable>
              <Pressable style={chip(active('h3'))} onPress={run((i) => !active('h3') && i.toggleH3())}><Text style={[chipText(active('h3')), styles.bold]}>Subheading</Text></Pressable>
              <Pressable style={chip(!active('h1') && !active('h2') && !active('h3'))} onPress={body}><Text style={chipText(!active('h1') && !active('h2') && !active('h3'))}>Body</Text></Pressable>
            </View>
            <View style={styles.row}>
              <Pressable style={chip(active('bold'))} onPress={run((i) => i.toggleBold())}><Text style={[chipText(active('bold')), styles.bold]}>B</Text></Pressable>
              <Pressable style={chip(active('italic'))} onPress={run((i) => i.toggleItalic())}><Text style={[chipText(active('italic')), styles.italic]}>I</Text></Pressable>
              <Pressable style={chip(active('underline'))} onPress={run((i) => i.toggleUnderline())}><Text style={[chipText(active('underline')), styles.underline]}>U</Text></Pressable>
              <Pressable style={chip(active('strikeThrough'))} onPress={run((i) => i.toggleStrikeThrough())}><Text style={[chipText(active('strikeThrough')), styles.strike]}>S</Text></Pressable>
              {HIGHLIGHTS.map((c) => (
                <Pressable key={c} accessibilityLabel={`Highlight ${c}`} style={[styles.swatch, { backgroundColor: HIGHLIGHT_SWATCH[c] }]} onPress={run((i) => i.toggleHighlight(c))} />
              ))}
            </View>
            <View style={styles.row}>
              <Pressable style={chip(active('unorderedList'))} onPress={run((i) => i.toggleUnorderedList())}><Text style={chipText(active('unorderedList'))}>• List</Text></Pressable>
              <Pressable style={chip(active('orderedList'))} onPress={run((i) => i.toggleOrderedList())}><Text style={chipText(active('orderedList'))}>1. List</Text></Pressable>
              <Pressable style={chip(active('blockQuote'))} onPress={run((i) => i.toggleBlockQuote())}><Text style={chipText(active('blockQuote'))}>Quote</Text></Pressable>
              <Pressable style={chip(active('codeBlock'))} onPress={run((i) => i.toggleCodeBlock())}><Text style={chipText(active('codeBlock'))}>Mono</Text></Pressable>
            </View>
          </View>
        ) : panel === 'images' ? (
          <AttachmentImages dark={dark} onPick={(f) => void insertImage(f)} />
        ) : null}
        <View style={[styles.toolbar, { borderTopColor: dark ? '#38383A' : '#D1D1D6' }]}>
          <Pressable accessibilityLabel="Format" onPress={() => setPanel(panel === 'format' ? 'none' : 'format')}>
            <Text style={[styles.tool, { color: notesTintHex }]}>Aa</Text>
          </Pressable>
          <Pressable accessibilityLabel="Checklist" onPress={run((i) => i.toggleCheckboxList(false))}>
            <Text style={[styles.tool, { color: active('checkboxList') ? fg : notesTintHex }]}>☑︎</Text>
          </Pressable>
          <Pressable accessibilityLabel="Insert image" onPress={() => setPanel(panel === 'images' ? 'none' : 'images')}>
            <Text style={[styles.tool, { color: notesTintHex }]}>▣</Text>
          </Pressable>
          <Pressable accessibilityLabel="Tag" onPress={run((i) => i.startMention(TAG_INDICATOR))}>
            <Text style={[styles.tool, { color: notesTintHex }]}>#</Text>
          </Pressable>
          <Pressable accessibilityLabel="Link note" onPress={run((i) => i.startMention(NOTE_INDICATOR))}>
            <Text style={[styles.tool, { color: notesTintHex }]}>@</Text>
          </Pressable>
          <Pressable accessibilityLabel="Done" onPress={run((i) => i.blur())}>
            <Text style={[styles.tool, { color: notesTintHex }]}>Done</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

/** Images already in any note's attachments folder; a pick from another note is copied into this one's. */
function AttachmentImages({ dark, onPick }: { dark: boolean; onPick: (file: File) => void }) {
  const files = useMemo(() => {
    const root = new Directory(Paths.document, 'NoteAttachments');
    if (!root.exists) return [];
    return root.list().flatMap((d) => (d instanceof Directory ? d.list().filter((f): f is File => f instanceof File && IMAGE.test(f.name)) : []));
  }, []);
  return (
    <ScrollView horizontal style={[styles.images, { backgroundColor: dark ? '#1C1C1E' : '#F2F2F7' }]} contentContainerStyle={styles.barContent}>
      {files.length === 0 ? <Text style={{ color: dark ? '#FFFFFF' : '#000000' }}>No images in NoteAttachments</Text> : null}
      {files.map((f) => (
        <Pressable key={f.uri} onPress={() => onPick(f)}>
          <Image source={{ uri: f.uri }} style={styles.thumb} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: PlatformColor('systemBackground') },
  missing: { padding: 20, color: PlatformColor('secondaryLabel') },
  input: { flex: 1, fontSize: 17, paddingHorizontal: 16, paddingTop: 8, backgroundColor: 'transparent' },
  bar: { flexGrow: 0 },
  barContent: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center' },
  panel: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  row: { flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  chipText: { fontSize: 15 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  underline: { textDecorationLine: 'underline' },
  strike: { textDecorationLine: 'line-through' },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  images: { flexGrow: 0 },
  thumb: { width: 64, height: 64, borderRadius: 6 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tool: { fontSize: 20, fontWeight: '600' },
});
