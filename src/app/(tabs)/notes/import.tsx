import { Button, HStack, Label, Section, Text } from '@expo/ui/swift-ui';
import { font, frame } from '@expo/ui/swift-ui/modifiers';
import { Stack } from 'expo-router';
import { Linking } from 'react-native';

import { yellow } from '@/ui/colors';
import type { SymbolName } from '@/ui/rows';
import { ScreenList } from '@/ui/screen';
import { alertError } from '@/ui/states';

const SHORTCUT_STEPS = [
  'Open Shortcuts and tap + to make a new shortcut.',
  'Add the action Find Notes. Leave it on All Notes, add no filter and leave Limit off, so it finds every note.',
  'Add the action Sync Notes to Puffer. It takes the notes from Find Notes on its own.',
  'Optional: tap Show More and type a Folder name. Without one, the notes go to Imported.',
  'Run the shortcut. Puffer can stay closed. When it is done, it shows what came over, like “Puffer: 1,234 added, 5 updated, 2 skipped”.',
  'Run it again any time. New notes are added, notes you have not changed in Puffer are updated, and notes you edited or deleted here stay as they are.',
];

const MARKDOWN_STEPS = [
  'In Notes, open the note.',
  'Tap the share button, or More, then Export as Markdown.',
  'Choose Puffer in the share sheet. The note lands in Imported.',
  'A note with images exports as a folder. Share the folder and Puffer takes its text.',
];

const LEFT_BEHIND: readonly { title: string; symbol: SymbolName }[] = [
  { title: 'Images and attachments', symbol: 'photo' },
  { title: 'Scanned documents', symbol: 'doc.viewfinder' },
  { title: 'Drawings and handwriting', symbol: 'pencil.tip' },
  { title: 'Checklist ticks: items come over unticked', symbol: 'checklist' },
  { title: 'Tables: their text comes over without the grid', symbol: 'tablecells' },
  { title: 'Locked notes', symbol: 'lock' },
  { title: 'Links between notes', symbol: 'link' },
  { title: 'Folders: a Shortcut run puts every note in one folder', symbol: 'folder' },
];

function Step({ n, text }: { n: number; text: string }) {
  return (
    <HStack spacing={12} alignment="top">
      <Text modifiers={[font({ size: 17, weight: 'bold' }), yellow, frame({ width: 22 })]}>{String(n)}</Text>
      <Text>{text}</Text>
    </HStack>
  );
}

export default function ImportScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Import from Apple Notes', headerLargeTitleEnabled: false }} />
      <ScreenList>
        <Section
          title="All Notes with a Shortcut"
          footer={
            <Text>
              Headings, bold, italic, lists, checklists and links keep their formatting. A note that cannot be read is skipped
              and counted, and the rest still come over.
            </Text>
          }
        >
          {SHORTCUT_STEPS.map((text, i) => (
            <Step key={i} n={i + 1} text={text} />
          ))}
          <Button
            label="Open Shortcuts"
            systemImage="arrow.up.forward.app"
            onPress={() => Linking.openURL('shortcuts://create-shortcut').catch(alertError('Could Not Open Shortcuts'))}
          />
        </Section>

        <Section
          title="If the Shortcut Finds No Notes"
          footer={
            <Text>
              First check that Find Notes is on All Notes, with no filter and Limit off. If it still finds none, bring notes
              over one at a time this way.
            </Text>
          }
        >
          {MARKDOWN_STEPS.map((text, i) => (
            <Step key={i} n={i + 1} text={text} />
          ))}
        </Section>

        <Section
          title="What Does Not Come Over"
          footer={<Text>In a note exported as Markdown, each image becomes the line Image not imported. Keep the originals in Notes.</Text>}
        >
          {LEFT_BEHIND.map((item) => (
            <Label key={item.title} title={item.title} systemImage={item.symbol} />
          ))}
        </Section>
      </ScreenList>
    </>
  );
}
