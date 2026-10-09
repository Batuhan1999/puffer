import { Button, ContentUnavailableView, Host, Label, LabeledContent, List, Section, Text } from '@expo/ui/swift-ui';
import { disabled, font, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { Stack, router } from 'expo-router';

import { usePuffer } from '@/store';
import { formatCount } from '@/ui/b/format';
import { JobSection, Onboarding } from '@/ui/b/ModelStatus';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export default function Memory() {
  const { model, counts, folders, job, indexPhotos, addDocuments, addFolder, rescanFolders } = usePuffer();
  const total = counts.photo + counts.passage;
  const busy = job.kind !== 'idle';

  return (
    <>
      <Stack.Screen options={{ title: 'Puffer' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="gearshape" accessibilityLabel="Settings" onPress={() => router.push('/settings')} />
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        {model.phase !== 'ready' ? (
          <Onboarding />
        ) : (
          <List>
            <JobSection />
            {total === 0 && !busy && (
              <Section>
                <ContentUnavailableView
                  title="Nothing remembered yet"
                  systemImage="tray"
                  description="Add your photo library, a few documents, or a whole folder. Puffer reads them once, here on the phone."
                />
              </Section>
            )}
            {total > 0 && (
              <Section title="Memory">
                <LabeledContent label="Photos">
                  <Text>{counts.photo.toLocaleString()}</Text>
                </LabeledContent>
                <LabeledContent label="Document passages">
                  <Text>{counts.passage.toLocaleString()}</Text>
                </LabeledContent>
                <Button label="Browse everything" systemImage="square.grid.2x2" onPress={() => router.push('/memory/library')} />
              </Section>
            )}
            <Section
              title="Add to memory"
              footer={<Text>Text, Markdown and PDF files. Folders can live in iCloud Drive or On My iPhone.</Text>}>
              <Button label="Index photo library" systemImage="photo.on.rectangle.angled" onPress={indexPhotos} modifiers={[disabled(busy)]} />
              <Button label="Add documents" systemImage="doc.badge.plus" onPress={addDocuments} modifiers={[disabled(busy)]} />
              <Button label="Add a folder" systemImage="folder.badge.plus" onPress={addFolder} modifiers={[disabled(busy)]} />
            </Section>
            {folders.length > 0 && (
              <Section title={formatCount(folders.length, 'folder')}>
                {folders.map((f) => (
                  <Label key={f.id} title={f.name} systemImage="folder" />
                ))}
                <Button label="Rescan folders" systemImage="arrow.clockwise" onPress={rescanFolders} modifiers={[disabled(busy)]} />
              </Section>
            )}
            <Section title="Privacy">
              <Label title="Everything stays on this phone" systemImage="lock.shield" />
              <Text modifiers={[secondary, font({ size: 14 })]}>
                Photos and documents are turned into numbers by a model running on this device. Those numbers never leave it, and
                nothing is uploaded unless you approve a specific request on the Agents tab.
              </Text>
            </Section>
          </List>
        )}
      </Host>
    </>
  );
}
