import { Button, Label, List, Section } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { Stack } from 'expo-router';

import { usePuffer } from '@/store';
import { FoldersFooter, IndexingSection } from '@/ui/indexing';
import { ScreenList } from '@/ui/screen';

/** The places Puffer reads documents from, for search and for agents. */
export default function FoldersScreen() {
  const puffer = usePuffer();
  const { folders, ready, checking } = puffer;

  return (
    <>
      <Stack.Screen options={{ title: 'Documents' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="folder.badge.plus" accessibilityLabel="Add Folder" onPress={puffer.addFolder} />
      </Stack.Toolbar>
      <ScreenList>
        <IndexingSection />
        <Section title="Folders" footer={<FoldersFooter />}>
          <List.ForEach onDelete={(indices) => indices.forEach((i) => puffer.removeFolder(folders[i]))}>
            {folders.map((folder) => (
              <Label key={folder.id} title={folder.name} systemImage="folder" />
            ))}
          </List.ForEach>
          <Button label="Add Folder" systemImage="folder.badge.plus" onPress={puffer.addFolder} />
          {folders.length ? (
            <Button
              label={checking ? 'Checking…' : 'Check for Changes'}
              systemImage="arrow.triangle.2.circlepath"
              onPress={puffer.rescanFolders}
              modifiers={[disabled(!ready || checking)]}
            />
          ) : null}
        </Section>
        {folders.length ? null : (
          <Section>
            <Label
              title="Choose the top of On My iPhone or iCloud Drive, and every document inside is included."
              systemImage="info.circle"
            />
          </Section>
        )}
      </ScreenList>
    </>
  );
}
