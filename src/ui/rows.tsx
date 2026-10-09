import { Button, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { disabled, font, foregroundStyle, frame, lineLimit, type ModifierConfig } from '@expo/ui/swift-ui/modifiers';
import type { ComponentProps } from 'react';

import { blue, secondary, tertiary } from './colors';

export type SymbolName = NonNullable<ComponentProps<typeof Image>['systemName']>;

export function Caption({ children, lines }: { children: string; lines?: number }) {
  return <Text modifiers={[font({ size: 13 }), secondary, ...(lines ? [lineLimit(lines)] : [])]}>{children}</Text>;
}

export function NavRow({
  title,
  subtitle,
  systemImage,
  value,
  inactive,
  chevron = true,
  modifiers = [],
  onPress,
}: {
  title: string;
  subtitle?: string;
  systemImage?: SymbolName;
  value?: string;
  inactive?: boolean;
  chevron?: boolean;
  modifiers?: ModifierConfig[];
  onPress: () => void;
}) {
  return (
    <Button onPress={onPress} modifiers={inactive ? [...modifiers, disabled(true)] : modifiers}>
      <HStack spacing={12}>
        {systemImage ? <Image systemName={systemImage} modifiers={[frame({ width: 28 }), font({ size: 18 })]} /> : null}
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[foregroundStyle('primary')]}>{title}</Text>
          {subtitle ? <Caption lines={2}>{subtitle}</Caption> : null}
        </VStack>
        <Spacer />
        {value ? <Text modifiers={[secondary]}>{value}</Text> : null}
        {chevron ? <Image systemName="chevron.right" modifiers={[font({ size: 13, weight: 'semibold' }), tertiary]} /> : null}
      </HStack>
    </Button>
  );
}

export function Feature({ symbol, title, body }: { symbol: SymbolName; title: string; body: string }) {
  return (
    <HStack spacing={16} alignment="top">
      <Image systemName={symbol} size={26} modifiers={[frame({ width: 36 }), blue]} />
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{title}</Text>
        <Text modifiers={[font({ size: 15 }), secondary]}>{body}</Text>
      </VStack>
      <Spacer />
    </HStack>
  );
}
