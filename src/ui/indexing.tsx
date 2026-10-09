import { Label, ProgressView, Section, Text, VStack } from '@expo/ui/swift-ui';
import { padding } from '@expo/ui/swift-ui/modifiers';

import { type IndexProgress, type Tally, useIndexing, usePuffer } from '@/store';

import { megabytes, plural } from './format';
import { Caption } from './rows';
import { ModelStatus } from './welcome';

const PAUSED: Record<Extract<IndexProgress['phase'], { kind: 'paused' }>['until'], string> = {
  foreground: 'Paused until Puffer is open again',
  charging: 'Paused until Puffer is open or the iPhone is charging',
};

/** Failed files wait for the next run, so they do not count as left. */
const left = (t: Tally) => Math.max(0, t.total - t.done - t.failed);

/** The top of Folders while the model downloads or Puffer is still reading files. Nothing once everything is read. */
export function IndexingSection() {
  const { model } = usePuffer();
  const indexing = useIndexing();
  if (model.phase === 'downloading') {
    const fraction = model.total ? model.written / model.total : 0;
    return (
      <Section footer={<Text>Puffer reads your notes and files when the model is here. Keep it open on Wi-Fi.</Text>}>
        <VStack alignment="leading" spacing={8} modifiers={[padding({ vertical: 4 })]}>
          <Label title={`Downloading the search model, ${Math.floor(fraction * 100)}%`} systemImage="arrow.down.circle" />
          <ProgressView value={fraction} />
          <Caption>{`${megabytes(model.written)} of ${megabytes(model.total)}`}</Caption>
        </VStack>
      </Section>
    );
  }
  if (model.phase !== 'ready') {
    return (
      <Section>
        <ModelStatus />
      </Section>
    );
  }
  if (!indexing || left(indexing.files) === 0) return null;
  const { phase, files } = indexing;
  return (
    <Section title="Reading Files" footer={<Text>Puffer reads while it is open, and faster while charging.</Text>}>
      <VStack alignment="leading" spacing={8} modifiers={[padding({ vertical: 4 })]}>
        {phase.kind === 'paused' ? <Label title={PAUSED[phase.until]} systemImage="pause.circle" /> : null}
        <ProgressView value={files.total ? Math.min(1, (files.done + files.failed) / files.total) : null} />
        <Text>{`${Math.min(files.done, files.total).toLocaleString()} of ${files.total.toLocaleString()} files`}</Text>
        {files.failed ? <Caption>{`${plural(files.failed, 'file')} could not be read. Puffer tries again next time.`}</Caption> : null}
      </VStack>
    </Section>
  );
}

/** The quiet line under the folder list once nothing is left. */
export function FoldersFooter() {
  const { ready } = usePuffer();
  const indexing = useIndexing();
  const files = indexing?.files;
  const indexed = ready && files && files.total && left(files) === 0 ? `${plural(files.total, 'file')} indexed. ` : '';
  return (
    <Text>
      {`${indexed}Puffer reads documents (PDF, text, Markdown) in these locations on this iPhone and keeps up as they change. ` +
        'Your agents can search them. The files stay where they are.'}
    </Text>
  );
}
