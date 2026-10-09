import { createModifierWithEventListener } from '@expo/ui/swift-ui/modifiers';

import type { SymbolName } from './rows';

export type SwipeTint = 'red' | 'orange' | 'indigo' | 'purple' | 'gray' | 'blue' | 'yellow' | 'green';

export type SwipeButton<Id extends string = string> = {
  id: Id;
  label: string;
  systemImage?: SymbolName;
  tint?: SwipeTint;
  /** SwiftUI removes the row as the button fires, so leave it off for an action that asks first. */
  destructive?: boolean;
};

/**
 * SwiftUI's `swipeActions` on a list row, registered natively as `swipeActions`. The first button on each edge sits
 * outermost and runs on a full swipe. A build without the native modifier ignores it, so every action also needs
 * another way in (the row's context menu).
 */
export function swipeActions<Id extends string>(
  {
    leading = [],
    trailing = [],
    leadingFullSwipe = true,
    trailingFullSwipe = true,
  }: {
    leading?: SwipeButton<Id>[];
    trailing?: SwipeButton<Id>[];
    leadingFullSwipe?: boolean;
    trailingFullSwipe?: boolean;
  },
  onAction: (id: Id) => void,
) {
  return createModifierWithEventListener('swipeActions', ({ id }: { id: Id }) => onAction(id), {
    leading,
    trailing,
    leadingFullSwipe,
    trailingFullSwipe,
  });
}
