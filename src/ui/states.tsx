import { ContentUnavailableView, Host, ProgressView, Text, VStack } from '@expo/ui/swift-ui';
import { font } from '@expo/ui/swift-ui/modifiers';
import { Alert } from 'react-native';

import { errorText } from '@/store';

import { secondary } from './colors';
import type { SymbolName } from './rows';

export function alertError(title: string) {
  return (e: unknown) => Alert.alert(title, errorText(e));
}

export function Loading({ label }: { label?: string }) {
  return (
    <Host style={{ flex: 1 }}>
      <VStack spacing={10}>
        <ProgressView />
        {label ? (
          <Text modifiers={[font({ size: 15 }), secondary]}>{label}</Text>
        ) : null}
      </VStack>
    </Host>
  );
}

export function Unavailable({
  title,
  systemImage,
  description,
}: {
  title: string;
  systemImage: SymbolName;
  description: string;
}) {
  return (
    <Host style={{ flex: 1 }}>
      <ContentUnavailableView title={title} systemImage={systemImage} description={description} />
    </Host>
  );
}
