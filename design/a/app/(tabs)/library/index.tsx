import { Button, ContentUnavailableView, Host, Label, List, Section, Text } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';
import { useMemo } from 'react';

import type { Item } from '@/domain';
import { usePuffer } from '@/store';
import { plural, sourceName } from '@/ui/format';
import { itemHref } from '@/ui/nav';
import { usePreview } from '@/ui/preview';
import { ItemLabel, NavRow } from '@/ui/rows';
import { ModelStatus } from '@/ui/welcome';

const RECENT = 5;

// `items` keeps the order Puffer read them in; `addedAt` is the capture or file date, so it cannot say what is new.
// Walking backwards, a document's earlier passages replace its later ones, so each file shows once from its start.
function recentlyAdded(items: readonly Item[]): Item[] {
  const latest = new Map<string, Item>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const key = item.kind === 'passage' ? item.sourceUri : item.id;
    if (latest.has(key) || latest.size < RECENT) latest.set(key, item);
  }
  return [...latest.values()];
}

export default function LibraryScreen() {
  const puffer = usePuffer();
  const { items, counts, folders, ready } = puffer;
  const { collections, agents, removeCollection } = usePreview();
  const router = useRouter();
  const canAdd = ready && puffer.job.kind === 'idle';
  const off = canAdd ? undefined : [disabled(true)];

  const { files, libraryPhotos } = useMemo(() => {
    const sources = new Set<string>();
    let fromPhotos = 0;
    for (const item of items) {
      if (item.kind === 'passage') sources.add(item.sourceUri);
      else if (!item.sourceUri.startsWith('folder:')) fromPhotos++;
    }
    return { files: sources.size, libraryPhotos: fromPhotos };
  }, [items]);

  const recent = useMemo(() => recentlyAdded(items), [items]);

  const sharedWith = (collectionId: string) =>
    agents.filter((a) => a.allowed.includes(collectionId)).map((a) => a.name);

  return (
    <>
      <Stack.Screen options={{ title: 'Library' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="plus" accessibilityLabel="Add to Library" disabled={!canAdd}>
          <Stack.Toolbar.MenuAction icon="photo.on.rectangle.angled" onPress={puffer.indexPhotos}>
            Read New Photos
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="folder.badge.plus" onPress={puffer.addFolder}>
            Add Folder
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="doc.badge.plus" onPress={puffer.addDocuments}>
            Add Files
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon="gearshape" accessibilityLabel="Settings" onPress={() => router.push('/settings')} />
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <List>
          {!ready ? (
            <Section>
              <ModelStatus />
            </Section>
          ) : null}
          {counts.photo + counts.passage === 0 ? (
            <Section>
              <ContentUnavailableView
                title="Your Library Is Empty"
                systemImage="tray"
                description="Add your photo library or a folder of documents below. Puffer reads them on this iPhone, and nothing leaves it."
              />
            </Section>
          ) : null}

          <Section
            title="Collections"
            footer={<Text>Collections gather things by what they show or say. Nothing is tagged by hand.</Text>}
          >
            <List.ForEach onDelete={(indices) => indices.forEach((i) => removeCollection(collections[i].id))}>
              {collections.map((c) => {
                const agentNames = sharedWith(c.id);
                return (
                  <NavRow
                    key={c.id}
                    title={c.name}
                    subtitle={agentNames.length ? `${c.query} · Open to ${agentNames.join(', ')}` : c.query}
                    systemImage={c.symbol}
                    onPress={() => router.push({ pathname: '/library/collection/[id]', params: { id: c.id } })}
                  />
                );
              })}
            </List.ForEach>
            <Button label="New Collection" systemImage="plus" onPress={() => router.push('/collection-editor')} />
          </Section>

          <Section title="Everything">
            <NavRow
              title="Photos"
              systemImage="photo"
              value={counts.photo.toLocaleString()}
              onPress={() => router.push('/library/photos')}
            />
            <NavRow
              title="Documents"
              systemImage="doc.text"
              value={files.toLocaleString()}
              onPress={() => router.push('/library/documents')}
            />
          </Section>

          {recent.length ? (
            <Section title="Recently Added">
              {recent.map((item) => (
                <Button key={item.id} onPress={() => router.push(itemHref('/library', item.id))}>
                  <ItemLabel item={item} detail={sourceName(item)} />
                </Button>
              ))}
            </Section>
          ) : null}

          <Section
            title="Sources"
            footer={
              <Text>
                Puffer reads these on this iPhone. Files stay where they are, and Puffer keeps only a small preview of
                each photo and the text of each document.
              </Text>
            }
          >
            <NavRow
              title="Photo Library"
              subtitle={libraryPhotos ? `${plural(libraryPhotos, 'photo')} read. Tap to read new ones.` : 'Not read yet'}
              systemImage="photo.on.rectangle.angled"
              chevron={false}
              inactive={!canAdd}
              onPress={puffer.indexPhotos}
            />
            {folders.map((folder) => (
              <Label key={folder.id} title={folder.name} systemImage="folder" />
            ))}
            <Button label="Add Folder" systemImage="folder.badge.plus" onPress={puffer.addFolder} modifiers={off} />
            <Button label="Add Files" systemImage="doc.badge.plus" onPress={puffer.addDocuments} modifiers={off} />
            {folders.length ? (
              <Button
                label="Check Folders for Changes"
                systemImage="arrow.triangle.2.circlepath"
                onPress={puffer.rescanFolders}
                modifiers={off}
              />
            ) : null}
          </Section>
        </List>
      </Host>
    </>
  );
}
