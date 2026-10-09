import { Button, DisclosureGroup, Host, List, Section, Text } from '@expo/ui/swift-ui';
import { foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';

import type { Item } from '@/domain';
import { usePuffer } from '@/store';
import { fileParts, sourceName } from '@/ui/format';
import { itemHref } from '@/ui/nav';
import { Unavailable } from '@/ui/states';

type DocFile = { key: string; name: string; passages: Item[] };
type Source = { name: string; files: DocFile[] };

function group(items: readonly Item[]): Source[] {
  const files = new Map<string, DocFile & { source: string }>();
  for (const item of items) {
    if (item.kind !== 'passage') continue;
    let file = files.get(item.sourceUri);
    if (!file) {
      file = { key: item.sourceUri, name: fileParts(item).file, source: sourceName(item), passages: [] };
      files.set(item.sourceUri, file);
    }
    file.passages.push(item);
  }
  const sources = new Map<string, Source>();
  for (const file of files.values()) {
    const source = sources.get(file.source) ?? { name: file.source, files: [] };
    source.files.push(file);
    sources.set(file.source, source);
  }
  return [...sources.values()].map((s) => ({ ...s, files: s.files.sort((a, b) => a.name.localeCompare(b.name)) }));
}

export default function DocumentsScreen() {
  const { items } = usePuffer();
  const router = useRouter();
  const sources = useMemo(() => group(items), [items]);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <Stack.Screen options={{ title: 'Documents', headerLargeTitleEnabled: false }} />
      {sources.length ? (
        <Host style={{ flex: 1 }}>
          <List>
            {sources.map((source) => (
              <Section key={source.name} title={source.name}>
                {source.files.map((file) => (
                  <DisclosureGroup
                    key={file.key}
                    label={file.name}
                    isExpanded={open === file.key}
                    onIsExpandedChange={(expanded) => setOpen(expanded ? file.key : null)}
                  >
                    {open === file.key
                      ? file.passages.map((passage) => (
                          <Button key={passage.id} onPress={() => router.push(itemHref('/library', passage.id))}>
                            <Text modifiers={[foregroundStyle('primary'), lineLimit(3)]}>{passage.text ?? passage.title}</Text>
                          </Button>
                        ))
                      : null}
                  </DisclosureGroup>
                ))}
              </Section>
            ))}
          </List>
        </Host>
      ) : (
        <Unavailable
          title="No Documents Yet"
          systemImage="doc.text"
          description="Add a folder from iCloud Drive or On My iPhone, or pick individual files in Library."
        />
      )}
    </>
  );
}
