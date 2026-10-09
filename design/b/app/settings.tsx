import { Button, ConfirmationDialog, Form, Host, LabeledContent, Picker, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { Stack, router } from 'expo-router';

import { Dim, DIMS, Mode } from '@/domain';
import { usePuffer } from '@/store';
import { formatBytes, formatMs } from '@/ui/b/format';
import { MODES, usePrefs } from '@/ui/b/prefs';

const MODEL_LABEL = {
  checking: 'Checking',
  absent: 'Not downloaded',
  downloading: 'Downloading',
  loading: 'Loading',
  ready: 'Ready',
  error: 'Failed to load',
} as const;

export default function Settings() {
  const { model, counts, folders, job, clearIndex, retryModel } = usePuffer();
  const { options, setMode, setDim, setRerank, lastTimings } = usePrefs();
  const busy = job.kind !== 'idle';
  const modeDetail = MODES.find((m) => m.value === options.mode)?.detail ?? '';

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => router.back()} variant="done">
          <Stack.Toolbar.Label>Done</Stack.Toolbar.Label>
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <Form>
          <Section title="Search engine" footer={<Text>{`${modeDetail} Hybrid at 256 with re-ranking is the recommended default.`}</Text>}>
            <Picker<string>
              label="Mode"
              selection={options.mode}
              onSelectionChange={(v) => setMode((MODES.find((m) => m.value === v)?.value ?? 'hybrid') as Mode)}
              modifiers={[pickerStyle('menu')]}>
              {MODES.map((m) => (
                <Text key={m.value} modifiers={[tag(m.value)]}>
                  {m.label}
                </Text>
              ))}
            </Picker>
            <Picker<number>
              label="Vector detail"
              selection={options.dim}
              onSelectionChange={(v) => setDim((DIMS.find((d) => d === v) ?? 256) as Dim)}
              modifiers={[pickerStyle('segmented'), disabled(options.mode === 'keyword')]}>
              {DIMS.map((d) => (
                <Text key={d} modifiers={[tag(d)]}>
                  {String(d)}
                </Text>
              ))}
            </Picker>
            <Toggle
              label="Re-rank at full detail"
              isOn={options.rerank}
              onIsOnChange={setRerank}
              modifiers={[disabled(options.mode === 'keyword')]}
            />
          </Section>

          <Section title="Last search">
            {lastTimings ? (
              <>
                <LabeledContent label="Embedding">
                  <Text>{formatMs(lastTimings.embedMs)}</Text>
                </LabeledContent>
                <LabeledContent label="Scan">
                  <Text>{`${formatMs(lastTimings.scanMs)} over ${lastTimings.n.toLocaleString()} items at ${lastTimings.dim}d`}</Text>
                </LabeledContent>
                <LabeledContent label="Keyword">
                  <Text>{formatMs(lastTimings.keywordMs)}</Text>
                </LabeledContent>
                <LabeledContent label="Re-rank">
                  <Text>{formatMs(lastTimings.rerankMs)}</Text>
                </LabeledContent>
                <LabeledContent label="Index size">
                  <Text>{formatBytes(lastTimings.indexBytes)}</Text>
                </LabeledContent>
              </>
            ) : (
              <Text>Run a search to see timings.</Text>
            )}
          </Section>

          <Section title="Model">
            <LabeledContent label="EmbeddingGemma 2">
              <Text>{MODEL_LABEL[model.phase]}</Text>
            </LabeledContent>
            {model.phase === 'ready' && (
              <>
                <LabeledContent label="Backend">
                  <Text>{model.backend.toUpperCase()}</Text>
                </LabeledContent>
                <LabeledContent label="Load time">
                  <Text>{formatMs(model.loadMs)}</Text>
                </LabeledContent>
              </>
            )}
            {model.phase === 'error' && (
              <>
                <Text>{model.message}</Text>
                <Button label="Try again" systemImage="arrow.clockwise" onPress={retryModel} />
              </>
            )}
          </Section>

          <Section title="Memory" footer={<Text>Clearing removes every embedding from this phone. Photos and files themselves are untouched.</Text>}>
            <LabeledContent label="Photos">
              <Text>{counts.photo.toLocaleString()}</Text>
            </LabeledContent>
            <LabeledContent label="Document passages">
              <Text>{counts.passage.toLocaleString()}</Text>
            </LabeledContent>
            <LabeledContent label="Folders">
              <Text>{String(folders.length)}</Text>
            </LabeledContent>
            <ConfirmationDialog title="Clear memory?" titleVisibility="visible">
              <ConfirmationDialog.Trigger>
                <Button label="Clear memory" systemImage="trash" role="destructive" modifiers={[disabled(busy)]} />
              </ConfirmationDialog.Trigger>
              <ConfirmationDialog.Message>
                <Text>Every photo and passage embedding on this phone is deleted. You can index again at any time.</Text>
              </ConfirmationDialog.Message>
              <ConfirmationDialog.Actions>
                <Button label="Clear everything" role="destructive" onPress={clearIndex} />
                <Button label="Keep" role="cancel" />
              </ConfirmationDialog.Actions>
            </ConfirmationDialog>
          </Section>

          <Section title="Privacy">
            <LabeledContent label="Processing">
              <Text>On this phone</Text>
            </LabeledContent>
            <LabeledContent label="Agent bridge">
              <Text>Preview</Text>
            </LabeledContent>
            <LabeledContent label="Network">
              <Text>Model download only</Text>
            </LabeledContent>
          </Section>
        </Form>
      </Host>
    </>
  );
}
