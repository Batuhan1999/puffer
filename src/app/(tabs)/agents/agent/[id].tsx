import { Button, HStack, Image, Section, Text, VStack } from '@expo/ui/swift-ui';
import { font } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert } from 'react-native';

import { historyOf, lastActivity, useBridge } from '@/bridge';
import { blue, secondary } from '@/ui/colors';
import { ago } from '@/ui/format';
import { HistoryRow } from '@/ui/history';
import { ScreenList } from '@/ui/screen';
import { alertError, Loading, Unavailable } from '@/ui/states';

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bridge = useBridge();
  const router = useRouter();
  const agent = bridge.agents.find((a) => a.id === id);

  if (!bridge.loaded) return <Loading />;
  if (!agent) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <Unavailable title="Agent Disconnected" systemImage="person.badge.key" description="This agent is no longer connected." />
      </>
    );
  }

  const history = historyOf(
    bridge.requests.filter((r) => r.agentId === agent.id),
    bridge.reads.filter((r) => r.agentId === agent.id),
  );

  const disconnect = () =>
    Alert.alert(`Disconnect ${agent.name}?`, `${agent.name} can no longer read or write your notes, and its key stops working.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          router.back();
          bridge.disconnect(agent.id).catch(alertError('Could Not Disconnect'));
        },
      },
    ]);

  return (
    <>
      <Stack.Screen options={{ title: agent.name, headerLargeTitleEnabled: false }} />
      <ScreenList>
        <Section>
          <HStack spacing={16}>
            <Image systemName="person.badge.key" size={34} modifiers={[blue]} />
            <VStack alignment="leading" spacing={2}>
              <Text modifiers={[font({ size: 22, weight: 'bold' })]}>{agent.name}</Text>
              <Text modifiers={[secondary]}>
                {`Connected ${ago(agent.connectedAt).toLowerCase()} · active ${ago(lastActivity(agent.id, agent.connectedAt, bridge)).toLowerCase()}`}
              </Text>
            </VStack>
          </HStack>
        </Section>
        <Section title="History">
          {history.length ? (
            history.map((entry) => <HistoryRow key={entry.kind === 'request' ? entry.request.id : entry.read.id} entry={entry} />)
          ) : (
            <Text modifiers={[secondary]}>Nothing yet.</Text>
          )}
        </Section>
        <Section>
          <Button label={`Disconnect ${agent.name}`} systemImage="xmark.circle" role="destructive" onPress={disconnect} />
        </Section>
      </ScreenList>
    </>
  );
}
