import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { usePuffer } from '@/store';
import { ActivityAccessory, activityOf, useNoticeHandling } from '@/ui/activity';
import { pendingRequests, usePreview } from '@/ui/preview';

export default function TabsLayout() {
  const puffer = usePuffer();
  const pending = pendingRequests(usePreview().requests).length;
  useNoticeHandling();

  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      {activityOf(puffer) ? (
        <NativeTabs.BottomAccessory>
          <ActivityAccessory />
        </NativeTabs.BottomAccessory>
      ) : null}
      <NativeTabs.Trigger name="library">
        <NativeTabs.Trigger.Icon sf={{ default: 'square.stack', selected: 'square.stack.fill' }} />
        <NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.2.badge.key', selected: 'person.2.badge.key.fill' }} />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={pending === 0}>{String(pending)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
