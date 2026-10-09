import { Button, Form, Host, Label, LabeledContent, Section, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, disabled, font, foregroundStyle, multilineTextAlignment } from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';

import { JobSection } from '@/ui/c/JobSection';
import { ModelSection } from '@/ui/c/ModelSection';
import { NoticeSection } from '@/ui/c/NoticeSection';
import { usePuffer } from '@/store';

export default function SetupScreen() {
  const router = useRouter();
  const { ready, counts, folders, job, indexPhotos, addDocuments, addFolder } = usePuffer();
  const busy = !ready || job.kind !== 'idle';
  const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" onPress={() => router.back()}>
          Done
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <Form>
          <Section>
            <VStack spacing={6}>
              <Text modifiers={[font({ size: 28, weight: 'bold', design: 'rounded' })]}>Your private memory</Text>
              <Text modifiers={[font({ size: 15 }), secondary, multilineTextAlignment('center')]}>
                Puffer reads your photos and documents on this iPhone, so you can find them by describing them. Nothing is uploaded.
              </Text>
            </VStack>
          </Section>
          <NoticeSection />
          <ModelSection title="Step 1. Model" />
          <JobSection />
          <Section title="Step 2. What to remember" footer={<Text>You can change this any time in Library.</Text>}>
            <Button label="Index my photos" systemImage="photo.on.rectangle" onPress={indexPhotos} modifiers={[disabled(busy)]} />
            <Button label="Add a folder of documents" systemImage="folder.badge.plus" onPress={addFolder} modifiers={[disabled(busy)]} />
            <Button label="Pick individual files" systemImage="doc.badge.plus" onPress={addDocuments} modifiers={[disabled(busy)]} />
          </Section>
          {(counts.photo > 0 || counts.passage > 0) && (
            <Section title="So far">
              <LabeledContent label="Photos">
                <Text>{String(counts.photo)}</Text>
              </LabeledContent>
              <LabeledContent label="Document passages">
                <Text>{String(counts.passage)}</Text>
              </LabeledContent>
              {folders.map((f) => (
                <Label key={f.id} title={f.name} systemImage="folder" />
              ))}
              <Button label="Start searching" onPress={() => router.back()} modifiers={[buttonStyle('borderedProminent')]} />
            </Section>
          )}
        </Form>
      </Host>
    </>
  );
}
