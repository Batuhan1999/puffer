import { Button, Host, HStack, Image, Label, ProgressView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, font, multilineTextAlignment, padding } from '@expo/ui/swift-ui/modifiers';
import Storage from 'expo-sqlite/kv-store';
import { ReactNode, useState } from 'react';

import { isModelDownloaded } from '@/model';
import { usePuffer } from '@/store';

import { secondary, yellow } from './colors';
import { megabytes } from './format';
import { Caption, Feature } from './rows';

const ONBOARDED = 'puffer.onboarded';

/** The first launch asks to download the search model once; everything else works without it. */
export function Gate({ children }: { children: ReactNode }) {
  const [welcome, setWelcome] = useState(() => Storage.getItemSync(ONBOARDED) === null && !isModelDownloaded());
  const puffer = usePuffer();
  if (!welcome) return children;
  const done = () => {
    Storage.setItemSync(ONBOARDED, new Date().toISOString());
    setWelcome(false);
  };
  return (
    <Intro
      onContinue={() => {
        if (puffer.model.phase === 'absent') puffer.downloadModel();
        done();
      }}
      onSkip={done}
    />
  );
}

function Intro({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) {
  return (
    <Host style={{ flex: 1 }}>
      <VStack spacing={28} modifiers={[padding({ horizontal: 28, top: 48, bottom: 16 })]}>
        <Image systemName="note.text" size={64} modifiers={[yellow]} />
        <VStack spacing={10}>
          <Text modifiers={[font({ size: 34, weight: 'bold' }), multilineTextAlignment('center')]}>Welcome to Puffer</Text>
          <Text modifiers={[font({ size: 17 }), secondary, multilineTextAlignment('center')]}>
            Notes on your iPhone that your agents can read and write, and documents they can search.
          </Text>
        </VStack>
        <VStack alignment="leading" spacing={22}>
          <Feature symbol="note.text" title="Notes" body="Write like in Apple Notes, or bring your Apple Notes over." />
          <Feature symbol="person.2.badge.key" title="Agents" body="Connect an agent once. It can then read and write your notes." />
          <Feature symbol="lock.shield" title="On this iPhone" body="Search runs on the device. Your index never leaves it." />
        </VStack>
        <Spacer />
        <VStack spacing={12}>
          <Caption>Search downloads a 388 MB model once. After that it works offline.</Caption>
          <Button onPress={onContinue} modifiers={[buttonStyle('glassProminent'), controlSize('large')]}>
            <HStack>
              <Spacer />
              <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>Download and Continue</Text>
              <Spacer />
            </HStack>
          </Button>
          <Button label="Not Now" onPress={onSkip} />
        </VStack>
      </VStack>
    </Host>
  );
}

export function ModelStatus() {
  const { model, retryModel, downloadModel } = usePuffer();
  switch (model.phase) {
    case 'downloading':
      return (
        <VStack alignment="leading" spacing={8} modifiers={[padding({ vertical: 4 })]}>
          <Label title="Downloading the search model" systemImage="arrow.down.circle" />
          <ProgressView value={model.total ? model.written / model.total : null} />
          <Caption>{`${megabytes(model.written)} of ${megabytes(model.total)}. Keep Puffer open on Wi-Fi.`}</Caption>
        </VStack>
      );
    case 'error':
      return (
        <VStack alignment="leading" spacing={8} modifiers={[padding({ vertical: 4 })]}>
          <Label title="The search model needs attention" systemImage="exclamationmark.triangle.fill" />
          <Caption>{model.message}</Caption>
          <Button label="Try Again" systemImage="arrow.clockwise" onPress={retryModel} />
        </VStack>
      );
    case 'absent':
      return <Button label="Download the Search Model (388 MB)" systemImage="arrow.down.circle" onPress={downloadModel} />;
    case 'ready':
      return <Label title="Search model ready" systemImage="checkmark.circle.fill" />;
    default:
      return (
        <HStack spacing={12}>
          <ProgressView />
          <Text>Preparing the search model</Text>
        </HStack>
      );
  }
}
