import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, PlatformColor, StyleSheet, Text, View } from 'react-native';

import { useSearch } from '@/store';
import { usePreview } from '@/ui/preview';
import { type ItemAction, Results, type Scope } from '@/ui/results';
import { Loading, Unavailable } from '@/ui/states';

export default function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const preview = usePreview();
  const router = useRouter();
  const collection = preview.collections.find((c) => c.id === id);
  const [scope, setScope] = useState<Scope>('all');
  const { result, error } = useSearch(collection ? { kind: 'text', text: collection.query } : null, preview.prefs);

  if (!collection) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <Unavailable title="Collection Deleted" systemImage="square.stack" description="This collection no longer exists." />
      </>
    );
  }

  const agents = preview.agents.filter((a) => a.allowed.includes(collection.id)).map((a) => a.name);
  const visible = result?.hits.filter((h) => !collection.hidden.includes(h.item.id)) ?? [];
  const hide: ItemAction = {
    title: 'Not in This Collection',
    icon: 'minus.circle',
    destructive: true,
    run: (item) => preview.hideFromCollection(collection.id, item.id),
  };

  const confirmDelete = () =>
    Alert.alert(`Delete “${collection.name}”?`, 'Your photos and documents stay in Puffer. Only the collection goes away.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          router.back();
          preview.removeCollection(collection.id);
        },
      },
    ]);

  let body;
  if (error) body = <Unavailable title="Search Failed" systemImage="exclamationmark.triangle" description={error} />;
  else if (!result) body = <Loading label="Gathering" />;
  else if (!visible.length)
    body = (
      <Unavailable
        title="Nothing Here Yet"
        systemImage={collection.symbol}
        description="Nothing in your library matches this description. Add more photos or documents, or edit the description."
      />
    );
  else
    body = (
      <Results
        hits={visible}
        scope={scope}
        onScope={setScope}
        extra={[hide]}
        header={
          <View style={styles.header}>
            <Text style={styles.query}>{`Anything that looks like ${collection.query}.`}</Text>
            {agents.length ? (
              <Text style={styles.meta}>{`${agents.join(' and ')} can use this collection without asking you.`}</Text>
            ) : null}
          </View>
        }
      />
    );

  return (
    <>
      <Stack.Screen options={{ title: collection.name }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Collection options">
          <Stack.Toolbar.MenuAction
            icon="pencil"
            onPress={() => router.push({ pathname: '/collection-editor', params: { id: collection.id } })}
          >
            Edit Description
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="person.2.badge.key" onPress={() => router.navigate('/agents')}>
            Agent Access
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
            Delete Collection
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {body}
    </>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 8, gap: 4 },
  query: { fontSize: 15, color: PlatformColor('secondaryLabel') },
  meta: { fontSize: 13, color: PlatformColor('tertiaryLabel') },
});
