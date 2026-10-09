import { Host, List } from '@expo/ui/swift-ui';
import { tint } from '@expo/ui/swift-ui/modifiers';
import type { ReactNode } from 'react';

import { notesTint } from './colors';

const accent = tint(notesTint);

/** A screen's grouped list. Without a tab bar nothing sets the app's tint, so the list carries the Notes yellow. */
export function ScreenList({ children }: { children: ReactNode }) {
  return (
    <Host style={{ flex: 1 }}>
      <List modifiers={[accent]}>{children}</List>
    </Host>
  );
}
