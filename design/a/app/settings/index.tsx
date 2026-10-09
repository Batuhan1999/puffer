import { Button, ConfirmationDialog, Host, LabeledContent, Label, List, Section, Text } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';

import { usePuffer } from '@/store';
import { usePreview } from '@/ui/preview';
import { NavRow } from '@/ui/rows';

const MODES = { hybrid: 'Meaning and words', vector: 'Meaning only', keyword: 'Words only' } as const;

export default function SettingsScreen() {
  const puffer = usePuffer();
  const { prefs } = usePreview();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const idle = puffer.job.kind === 'idle';

  return (
    <>
      <Stack.Screen options={{ title: 'Settings' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" onPress={() => router.back()}>
          Done
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <List>
          <Section footer={<Text>How Puffer matches, how precise it is, and how long each step takes.</Text>}>
            <NavRow
              title="Search Engine"
              systemImage="cpu"
              value={MODES[prefs.mode]}
              onPress={() => router.push('/settings/engine')}
            />
          </Section>

          <Section title="Library">
            <LabeledContent label="Photos">
              <Text>{puffer.counts.photo.toLocaleString()}</Text>
            </LabeledContent>
            <LabeledContent label="Document passages">
              <Text>{puffer.counts.passage.toLocaleString()}</Text>
            </LabeledContent>
            <LabeledContent label="Folders">
              <Text>{puffer.folders.length.toLocaleString()}</Text>
            </LabeledContent>
            <ConfirmationDialog
              title="Clear everything Puffer has learned?"
              titleVisibility="visible"
              isPresented={confirming}
              onIsPresentedChange={setConfirming}
            >
              <ConfirmationDialog.Trigger>
                <Button
                  label="Clear Index"
                  role="destructive"
                  onPress={() => setConfirming(true)}
                  modifiers={idle ? undefined : [disabled(true)]}
                />
              </ConfirmationDialog.Trigger>
              <ConfirmationDialog.Actions>
                <Button label="Clear Index" role="destructive" onPress={puffer.clearIndex} />
                <Button label="Cancel" role="cancel" />
              </ConfirmationDialog.Actions>
              <ConfirmationDialog.Message>
                <Text>Your photos and files stay where they are. You can read them again later.</Text>
              </ConfirmationDialog.Message>
            </ConfirmationDialog>
          </Section>

          <Section
            title="Privacy"
            footer={
              <Text>
                The agent bridge is a preview. Nothing in it connects to a real agent yet, and nothing is sent.
              </Text>
            }
          >
            <Label title="Search runs on this iPhone" systemImage="iphone" />
            <Label title="Photos and files are never uploaded" systemImage="lock.shield" />
            <Label title="Agents only get what you approve" systemImage="hand.raised" />
            <Label title="The index and its vectors never leave" systemImage="eye.slash" />
          </Section>

          <Section title="About">
            <LabeledContent label="Model">
              <Text>EmbeddingGemma 2</Text>
            </LabeledContent>
            <LabeledContent label="Runtime">
              <Text>LiteRT-LM, on device</Text>
            </LabeledContent>
            <LabeledContent label="Languages">
              <Text>100+</Text>
            </LabeledContent>
          </Section>
        </List>
      </Host>
    </>
  );
}
