import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, PlatformColor } from 'react-native';

import { usePuffer } from '@/store';
import { plural } from '@/ui/format';
import { GRID_GAP, PhotoTile, useTileSize } from '@/ui/results';
import { Unavailable } from '@/ui/states';

export default function PhotosScreen() {
  const { items } = usePuffer();
  const tile = useTileSize();
  const photos = useMemo(
    () => items.filter((i) => i.kind === 'photo').sort((a, b) => b.addedAt - a.addedAt),
    [items],
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Photos', headerLargeTitleEnabled: false }} />
      {photos.length ? (
        <FlatList
          data={photos}
          numColumns={3}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <PhotoTile item={item} size={tile} />}
          columnWrapperStyle={{ gap: GRID_GAP }}
          contentContainerStyle={{ gap: GRID_GAP }}
          contentInsetAdjustmentBehavior="automatic"
          style={{ backgroundColor: PlatformColor('systemBackground') }}
          accessibilityLabel={plural(photos.length, 'photo')}
        />
      ) : (
        <Unavailable
          title="No Photos Yet"
          systemImage="photo"
          description="Read your photo library from Library, or add a folder that contains images."
        />
      )}
    </>
  );
}
