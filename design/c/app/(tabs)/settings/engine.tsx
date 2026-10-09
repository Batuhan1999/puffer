import { Form, Host, LabeledContent, Picker, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';

import { DIMS } from '@/domain';
import { megabytes } from '@/ui/c/format';
import { usePrefs } from '@/ui/c/prefs';
import { usePuffer } from '@/store';

const ms = (v: number | null) => (v === null ? 'Not used' : `${v.toFixed(0)} ms`);

export default function EngineScreen() {
  const { mode, dim, rerank, setMode, setDim, setRerank, lastTimings: t } = usePrefs();
  const { model } = usePuffer();

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Matching" footer={<Text>Hybrid combines meaning with exact words. Smaller sizes search faster and use less memory but are slightly less precise.</Text>}>
          <Picker label="Search mode" selection={mode} onSelectionChange={setMode} modifiers={[pickerStyle('menu')]}>
            <Text modifiers={[tag('hybrid')]}>Hybrid</Text>
            <Text modifiers={[tag('vector')]}>Meaning only</Text>
            <Text modifiers={[tag('keyword')]}>Keywords only</Text>
          </Picker>
          <Picker label="Vector size" selection={dim} onSelectionChange={setDim} modifiers={[pickerStyle('menu')]}>
            {DIMS.map((d) => (
              <Text key={d} modifiers={[tag(d)]}>{String(d)}</Text>
            ))}
          </Picker>
          <Toggle label="Re-rank with full precision" isOn={rerank} onIsOnChange={setRerank} />
        </Section>
        <Section title="Last search">
          {t ? (
            <>
              <LabeledContent label="Embed query">
                <Text>{ms(t.embedMs)}</Text>
              </LabeledContent>
              <LabeledContent label="Scan index">
                <Text>{ms(t.scanMs)}</Text>
              </LabeledContent>
              <LabeledContent label="Keyword search">
                <Text>{ms(t.keywordMs)}</Text>
              </LabeledContent>
              <LabeledContent label="Re-rank">
                <Text>{ms(t.rerankMs)}</Text>
              </LabeledContent>
              <LabeledContent label="Items scanned">
                <Text>{String(t.n)}</Text>
              </LabeledContent>
              <LabeledContent label="Index size at this vector size">
                <Text>{megabytes(t.indexBytes)}</Text>
              </LabeledContent>
            </>
          ) : (
            <Text>Run a search to see timings.</Text>
          )}
        </Section>
        {model.phase === 'ready' && (
          <Section title="Model">
            <LabeledContent label="Backend">
              <Text>{model.backend}</Text>
            </LabeledContent>
            <LabeledContent label="Load time">
              <Text>{ms(model.loadMs)}</Text>
            </LabeledContent>
          </Section>
        )}
      </Form>
    </Host>
  );
}
