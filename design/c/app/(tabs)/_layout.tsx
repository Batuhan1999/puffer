import { useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useEffect, useRef } from 'react';

import { useAgentPreview } from '@/ui/c/agents';
import { usePuffer } from '@/store';

export const unstable_settings = { initialRouteName: '(search)' };

export default function TabsLayout() {
  const router = useRouter();
  const { model } = usePuffer();
  const { requests } = useAgentPreview();
  const welcomed = useRef(false);
  const pending = requests.filter((r) => r.decision === 'pending').length;

  useEffect(() => {
    if (model.phase === 'absent' && !welcomed.current) {
      welcomed.current = true;
      router.push('/setup');
    }
  }, [model.phase, router]);

  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="library">
        <NativeTabs.Trigger.Icon sf="photo.on.rectangle.angled" />
        <NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon sf="person.crop.circle.badge.checkmark" />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={pending === 0}>{String(pending)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf="gearshape" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(search)" role="search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
