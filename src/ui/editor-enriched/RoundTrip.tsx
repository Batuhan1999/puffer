// Spike measurement: every live note through Markdown -> HTML -> the native editor -> HTML -> Markdown. Writes
// Documents/enriched-roundtrip.json so the numbers can be read off the simulator. Open puffer:///notes/enriched/roundtrip.
import { File, Paths } from 'expo-file-system';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { PlatformColor, ScrollView, StyleSheet, Text, View } from 'react-native';
import { EnrichedTextInput, type EnrichedTextInputInstance } from 'react-native-enriched-html';

import { useNotes } from '@/notes';

import { load } from './EnrichedNoteEditor';
import { hasImplicitTitle, htmlToMarkdown, markdownToHtml } from './markdown';

/** Constructs the corpus notes lack, checked through the native editor too. */
const FIXTURES: Record<string, string> = {
  'fixture:adjacent-highlights': '# Colors\nA ==purple==<mark data-color="mint">mint</mark> pair and **==bold purple==**',
  'fixture:nesting': '# Nesting\n- top\n    - child\n        - grandchild\n1. one\n    1. one.one\n> - quoted item\n> # quoted heading',
  'fixture:inline': '# Inline\nA *b_c* and `code *x*` and [link **bold**](https://example.com) and ***both*** and <u>~~us~~</u>',
  'fixture:escapes': '# Escapes\n\\# not a heading\n2\\. not a list\nstar \\* and under\\_score and 2 * 3',
};

type Result = { id: string; lines: number; changed: { before?: string; after?: string }[]; html: string; native: string };

export function RoundTrip() {
  const { notes: summaries, loaded } = useNotes();
  const input = useRef<EnrichedTextInputInstance>(null);
  const [summary, setSummary] = useState('Running…');

  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    (async () => {
      const results: Result[] = [];
      for (const n of summaries.filter((s) => s.deletedAt === null)) {
        const note = await load(n.id);
        if (!note || !note.markdown.trim() || !input.current) continue;
        input.current.setValue(note.html);
        const native = await input.current.getHTML();
        const back = htmlToMarkdown(native, { implicitTitle: note.implicitTitle });
        const a = note.markdown.replace(/\n+$/, '').split('\n');
        const b = back.replace(/\n+$/, '').split('\n');
        const changed = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push({ before: a[i], after: b[i] });
        results.push({ id: n.id, lines: a.length, changed, html: note.html, native });
      }
      for (const [id, markdown] of Object.entries(FIXTURES)) {
        const html = markdownToHtml(markdown, { attachmentsDir: 'file:///', imageSize: () => undefined });
        input.current?.setValue(html);
        const native = (await input.current?.getHTML()) ?? '';
        const back = htmlToMarkdown(native, { implicitTitle: hasImplicitTitle(markdown) });
        const a = markdown.split('\n');
        const b = back.split('\n');
        const changed = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push({ before: a[i], after: b[i] });
        results.push({ id, lines: a.length, changed, html, native });
      }
      const same = results.filter((r) => r.changed.length === 0).length;
      const lines = results.reduce((t, r) => t + r.lines, 0);
      const changed = results.reduce((t, r) => t + r.changed.length, 0);
      new File(Paths.document, 'enriched-roundtrip.json').write(JSON.stringify({ same, notes: results.length, lines, changed, results }, null, 1));
      if (alive) setSummary(`${same}/${results.length} notes identical, ${changed}/${lines} lines changed. Report in Documents/enriched-roundtrip.json.`);
    })().catch((e) => alive && setSummary(String(e)));
    return () => {
      alive = false;
    };
  }, [loaded, summaries]);

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Round Trip', headerLargeTitleEnabled: false }} />
      <Text style={styles.text}>{summary}</Text>
      <View style={styles.hidden}>
        <EnrichedTextInput ref={input} style={styles.input} mentionIndicators={['#', '@']} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: PlatformColor('systemBackground') },
  content: { padding: 16 },
  text: { fontSize: 15, color: PlatformColor('label') },
  hidden: { height: 200, opacity: 0.05 },
  input: { flex: 1 },
});
