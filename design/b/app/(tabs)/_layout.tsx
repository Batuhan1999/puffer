import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { useAgents } from '@/ui/b/agents';

export default function TabsLayout() {
  const { pending } = useAgents();
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="memory">
        <NativeTabs.Trigger.Icon sf={{ default: 'photo.on.rectangle.angled', selected: 'photo.on.rectangle.angled.fill' }} />
        <NativeTabs.Trigger.Label>Memory</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.2.wave.2', selected: 'person.2.wave.2.fill' }} />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={pending.length === 0}>{String(pending.length)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
