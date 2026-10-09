import {
  Button,
  ContentUnavailableView,
  Divider,
  Host,
  LabeledContent,
  Text,
  VStack,
} from '@expo/ui/swift-ui';
import { buttonStyle, font, foregroundStyle, textSelection } from '@expo/ui/swift-ui/modifiers';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { sourceLabel } from '@/ui/c/format';
import { usePuffer } from '@/store';

export default function ItemSheet() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { items } = usePuffer();
  const item = items.find((i) => i.id === id);

  const similar = () => {
    if (item) router.replace({ pathname: '/similar/[id]', params: { id: item.id } });
  };

  if (!item) {
    return (
      <Host style={{ flex: 1 }}>
        <ContentUnavailableView title="Not in your memory anymore" systemImage="questionmark.folder" />
      </Host>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: item.kind === 'photo' ? 'Photo' : 'Passage' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="xmark" onPress={() => router.back()} />
      </Stack.Toolbar>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {item.kind === 'photo' && item.thumbUri && (
          <View style={styles.photoFrame}>
            <Image source={{ uri: item.thumbUri }} style={styles.photo} contentFit="contain" />
          </View>
        )}
        <Host matchContents={{ vertical: true }} style={styles.host}>
          <VStack alignment="leading" spacing={12}>
            <Text modifiers={[font({ size: 20, weight: 'semibold' })]}>{item.title}</Text>
            {item.kind === 'passage' && item.text ? (
              <Text modifiers={[font({ size: 17 }), textSelection(true)]}>{item.text}</Text>
            ) : null}
            <Divider />
            <LabeledContent label="Source">
              <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>{sourceLabel(item)}</Text>
            </LabeledContent>
            <LabeledContent label="Added">
              <Text date={new Date(item.addedAt)} dateStyle="date" />
            </LabeledContent>
            <Button
              label={item.kind === 'photo' ? 'Find similar photos and documents' : 'Find similar passages and photos'}
              systemImage="sparkle.magnifyingglass"
              onPress={similar}
              modifiers={[buttonStyle('glassProminent')]}
            />
          </VStack>
        </Host>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  host: { marginHorizontal: 20, marginTop: 12 },
  photoFrame: { marginHorizontal: 20, marginTop: 8, borderRadius: 16, overflow: 'hidden' },
  photo: { width: '100%', height: 300 },
});
