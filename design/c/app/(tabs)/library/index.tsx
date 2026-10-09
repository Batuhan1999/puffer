import { Button, Host, HStack, Image, Label, List, Section, Spacer, Text } from '@expo/ui/swift-ui';
import { disabled, foregroundStyle, onTapGesture } from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';

import { COLLECTIONS } from '@/ui/c/agents';
import { ItemRow } from '@/ui/c/ItemRow';
import { JobSection } from '@/ui/c/JobSection';
import { NoticeSection } from '@/ui/c/NoticeSection';
import { SetupPrompt } from '@/ui/c/SetupPrompt';
import { usePuffer } from '@/store';
import type { Item } from '@/domain';

function NavRow({ title, systemImage, detail, onPress }: { title: string; systemImage: 'photo' | 'doc.text' | 'folder' | 'house' | 'airplane' | 'doc.text.image'; detail?: string; onPress: () => void }) {
  const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
  return (
    <HStack modifiers={[onTapGesture(onPress)]}>
      <Label title={title} systemImage={systemImage} />
      <Spacer />
      {detail ? <Text modifiers={[secondary]}>{detail}</Text> : <Spacer />}
      <Image systemName="chevron.right" size={13} modifiers={[secondary]} />
    </HStack>
  );
}

export default function LibraryScreen() {
  const router = useRouter();
  const { items, counts, folders, ready, job, indexPhotos, addDocuments, addFolder, rescanFolders } = usePuffer();
  const busy = !ready || job.kind !== 'idle';
  const recent = [...items].sort((a, b) => b.addedAt - a.addedAt).slice(0, 5);
  const open = (item: Item) => router.push({ pathname: '/item/[id]', params: { id: item.id } });

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="plus" disabled={busy}>
          <Stack.Toolbar.MenuAction icon="photo.on.rectangle" onPress={indexPhotos}>
            Index photos
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="folder.badge.plus" onPress={addFolder}>
            Add folder
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="doc.badge.plus" onPress={addDocuments}>
            Pick files
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {items.length === 0 && job.kind === 'idle' ? (
        <SetupPrompt
          title="Your library is empty"
          description="Choose photos and document folders to remember. They stay on this iPhone."
          systemImage="tray"
          action="Add to library"
        />
      ) : (
        <Host style={{ flex: 1 }}>
          <List>
            <NoticeSection />
            <JobSection />
            <Section title="On this iPhone">
              <NavRow title="Photos" systemImage="photo" detail={String(counts.photo)} onPress={() => router.push('/library/photos')} />
              <NavRow title="Documents" systemImage="doc.text" detail={`${counts.passage} passages`} onPress={() => router.push('/library/documents')} />
            </Section>
            <Section title="Collections" footer={<Text>Collections are saved searches. They are kept in memory in this preview.</Text>}>
              {COLLECTIONS.map((c) => (
                <NavRow key={c.id} title={c.name} systemImage={c.symbol} onPress={() => router.push({ pathname: '/library/collection/[id]', params: { id: c.id } })} />
              ))}
            </Section>
            {recent.length > 0 && (
              <Section title="Recently added">
                {recent.map((item) => (
                  <ItemRow key={item.id} item={item} onPress={() => open(item)} />
                ))}
              </Section>
            )}
            {folders.length > 0 && (
              <Section title="Granted folders" footer={<Text>Puffer only reads folders you add here.</Text>}>
                {folders.map((f) => (
                  <Label key={f.id} title={f.name} systemImage="folder" />
                ))}
                <Button label="Rescan folders" systemImage="arrow.clockwise" onPress={rescanFolders} modifiers={[disabled(busy)]} />
              </Section>
            )}
          </List>
        </Host>
      )}
    </>
  );
}
