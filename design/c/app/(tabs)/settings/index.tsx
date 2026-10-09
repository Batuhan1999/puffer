import { Button, ConfirmationDialog, Host, HStack, Image, Label, LabeledContent, List, Section, Spacer, Text } from '@expo/ui/swift-ui';
import { disabled, foregroundStyle, onTapGesture } from '@expo/ui/swift-ui/modifiers';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { ModelSection } from '@/ui/c/ModelSection';
import { NoticeSection } from '@/ui/c/NoticeSection';
import { usePuffer } from '@/store';

export default function SettingsScreen() {
  const router = useRouter();
  const { counts, folders, job, clearIndex } = usePuffer();
  const [confirming, setConfirming] = useState(false);
  const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

  return (
    <Host style={{ flex: 1 }}>
      <List>
        <NoticeSection />
        <Section title="Privacy" footer={<Text>The index is stored in this app on your iPhone. Puffer has no account and makes no network requests except the one-time model download.</Text>}>
          <Label title="Everything stays on this iPhone" systemImage="lock.iphone" />
          <LabeledContent label="Photos remembered">
            <Text>{String(counts.photo)}</Text>
          </LabeledContent>
          <LabeledContent label="Document passages">
            <Text>{String(counts.passage)}</Text>
          </LabeledContent>
          <LabeledContent label="Granted folders">
            <Text>{String(folders.length)}</Text>
          </LabeledContent>
        </Section>
        <Section>
          <HStack modifiers={[onTapGesture(() => router.push('/settings/engine'))]}>
            <Label title="Search settings" systemImage="slider.horizontal.3" />
            <Spacer />
            <Image systemName="chevron.right" size={13} modifiers={[secondary]} />
          </HStack>
        </Section>
        <ModelSection />
        <Section title="Data">
          <ConfirmationDialog title="Clear the index?" isPresented={confirming} onIsPresentedChange={setConfirming} titleVisibility="visible">
            <ConfirmationDialog.Trigger>
              <Button label="Clear index" systemImage="trash" role="destructive" modifiers={[disabled(job.kind !== 'idle')]} />
            </ConfirmationDialog.Trigger>
            <ConfirmationDialog.Actions>
              <Button label="Clear index" role="destructive" onPress={clearIndex} />
              <Button label="Cancel" role="cancel" />
            </ConfirmationDialog.Actions>
            <ConfirmationDialog.Message>
              <Text>Your photos and files are not touched. Puffer will need to read them again.</Text>
            </ConfirmationDialog.Message>
          </ConfirmationDialog>
        </Section>
      </List>
    </Host>
  );
}
