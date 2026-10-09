import { Host, LabeledContent, List, Picker, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { monospacedDigit, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { Stack } from 'expo-router';

import { DIMS, type Dim, type Mode } from '@/domain';
import { usePuffer } from '@/store';
import { megabytes, modelSummary } from '@/ui/format';
import { usePreview } from '@/ui/preview';
import { ModelStatus } from '@/ui/welcome';

const MODE_NOTES: Record<Mode, string> = {
  hybrid: 'Blends meaning with exact words. Best for names, amounts and dates.',
  vector: 'Matches meaning only. Finds photos and other languages, but can miss exact numbers.',
  keyword: 'Matches exact words in document text and file names. Works without the model, but finds no photos by content.',
};

function ms(value: number | null) {
  return value === null ? 'Skipped' : `${value.toFixed(1)} ms`;
}

export default function EngineScreen() {
  const { model } = usePuffer();
  const { prefs, setPrefs, lastTimings } = usePreview();

  return (
    <>
      <Stack.Screen options={{ title: 'Search Engine' }} />
      <Host style={{ flex: 1 }}>
        <List>
          <Section title="Model">
            {model.phase === 'ready' ? (
              <>
                <LabeledContent label="EmbeddingGemma 2">
                  <Text>{modelSummary(model)}</Text>
                </LabeledContent>
                <LabeledContent label="Load time">
                  <Text modifiers={[monospacedDigit()]}>{`${Math.round(model.loadMs)} ms`}</Text>
                </LabeledContent>
              </>
            ) : (
              <ModelStatus />
            )}
          </Section>

          <Section title="Matching" footer={<Text>{MODE_NOTES[prefs.mode]}</Text>}>
            <Picker<Mode>
              selection={prefs.mode}
              onSelectionChange={(mode) => setPrefs({ mode })}
              modifiers={[pickerStyle('segmented')]}
            >
              <Text modifiers={[tag('hybrid')]}>Hybrid</Text>
              <Text modifiers={[tag('vector')]}>Meaning</Text>
              <Text modifiers={[tag('keyword')]}>Words</Text>
            </Picker>
          </Section>

          <Section
            title="Precision"
            footer={
              <Text>
                Fewer dimensions scan faster and use less memory. With re-ranking on, the best candidates are checked
                again at full 768-dimension precision.
              </Text>
            }
          >
            <Picker<Dim>
              label="Dimensions"
              selection={prefs.dim}
              onSelectionChange={(dim) => setPrefs({ dim })}
              modifiers={[pickerStyle('menu')]}
            >
              {DIMS.map((dim) => (
                <Text key={dim} modifiers={[tag(dim)]}>
                  {String(dim)}
                </Text>
              ))}
            </Picker>
            <Toggle
              label="Re-rank at full precision"
              isOn={prefs.rerank}
              onIsOnChange={(rerank) => setPrefs({ rerank })}
            />
          </Section>

          <Section
            title="Last Search"
            footer={<Text>{lastTimings ? 'Measured on this iPhone.' : 'Run a search to see where the time goes.'}</Text>}
          >
            {lastTimings ? (
              <>
                <LabeledContent label="Understand the question">
                  <Text modifiers={[monospacedDigit()]}>{ms(lastTimings.embedMs)}</Text>
                </LabeledContent>
                <LabeledContent label="Scan the index">
                  <Text modifiers={[monospacedDigit()]}>{ms(lastTimings.scanMs)}</Text>
                </LabeledContent>
                <LabeledContent label="Re-rank">
                  <Text modifiers={[monospacedDigit()]}>{ms(lastTimings.rerankMs)}</Text>
                </LabeledContent>
                <LabeledContent label="Word match">
                  <Text modifiers={[monospacedDigit()]}>{ms(lastTimings.keywordMs)}</Text>
                </LabeledContent>
                <LabeledContent label="Items searched">
                  <Text modifiers={[monospacedDigit()]}>{lastTimings.n.toLocaleString()}</Text>
                </LabeledContent>
                <LabeledContent label={`Index size at ${lastTimings.dim}d`}>
                  <Text modifiers={[monospacedDigit()]}>{megabytes(lastTimings.indexBytes)}</Text>
                </LabeledContent>
              </>
            ) : null}
          </Section>
        </List>
      </Host>
    </>
  );
}
