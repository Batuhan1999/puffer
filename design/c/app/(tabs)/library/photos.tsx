import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, useWindowDimensions } from 'react-native';

import { usePuffer } from '@/store';

const COLUMNS = 3;
const GAP = 2;

export default function PhotosScreen() {
  const router = useRouter();
  const { items } = usePuffer();
  const { width } = useWindowDimensions();
  const size = (width - GAP * (COLUMNS - 1)) / COLUMNS;
  const photos = items.filter((i) => i.kind === 'photo' && i.thumbUri);

  return (
    <FlatList
      data={photos}
      numColumns={COLUMNS}
      keyExtractor={(i) => i.id}
      contentInsetAdjustmentBehavior="automatic"
      columnWrapperStyle={{ gap: GAP }}
      contentContainerStyle={{ gap: GAP }}
      renderItem={({ item }) => (
        <Pressable onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}>
          <Image source={{ uri: item.thumbUri }} style={[styles.tile, { width: size, height: size }]} contentFit="cover" recyclingKey={item.id} />
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({ tile: { backgroundColor: '#8E8E9320' } });
