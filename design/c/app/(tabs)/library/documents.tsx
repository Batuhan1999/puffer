import { ContentUnavailableView, Host, HStack, Image, Label, List, Section, Spacer, Text } from '@expo/ui/swift-ui';
import { foregroundStyle, onTapGesture } from '@expo/ui/swift-ui/modifiers';
import { useRouter } from 'expo-router';

import type { Item } from '@/domain';
import { documentName, sourceLabel } from '@/ui/c/format';
import { usePuffer } from '@/store';

type Doc = { name: string; first: Item; passages: number };

export default function DocumentsScreen() {
  const router = useRouter();
  const { items } = usePuffer();

  const groups = new Map<string, Map<string, Doc>>();
  for (const item of items) {
    if (item.kind !== 'passage') continue;
    const source = sourceLabel(item);
    const docs = groups.get(source) ?? new Map<string, Doc>();
    const key = `${item.sourceUri.split('#')[0]}|${documentName(item)}`;
    const doc = docs.get(key);
    if (doc) doc.passages += 1;
    else docs.set(key, { name: documentName(item), first: item, passages: 1 });
    groups.set(source, docs);
  }

  if (groups.size === 0) {
    return (
      <Host style={{ flex: 1 }}>
        <ContentUnavailableView title="No documents yet" description="Add a folder or pick files from Library." systemImage="doc.text" />
      </Host>
    );
  }

  return (
    <Host style={{ flex: 1 }}>
      <List>
        {[...groups].map(([source, docs]) => (
          <Section key={source} title={source}>
            {[...docs].map(([key, doc]) => (
              <HStack key={key} modifiers={[onTapGesture(() => router.push({ pathname: '/item/[id]', params: { id: doc.first.id } }))]}>
                <Label title={doc.name} systemImage="doc.text" />
                <Spacer />
                <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
                  {doc.passages === 1 ? '1 passage' : `${doc.passages} passages`}
                </Text>
                <Image systemName="chevron.right" size={13} modifiers={[foregroundStyle({ type: 'hierarchical', style: 'tertiary' })]} />
              </HStack>
            ))}
          </Section>
        ))}
      </List>
    </Host>
  );
}
