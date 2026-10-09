import { Button, HStack, Image, Label, LabeledContent, List, Section, ShareLink, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, frame, textSelection } from '@expo/ui/swift-ui/modifiers';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { type Agent, historyOf, lastActivity, type PendingConnect, type RelayStatus, useBridge } from '@/bridge';
import { orange, secondary } from '@/ui/colors';
import { ago } from '@/ui/format';
import { HistoryRow } from '@/ui/history';
import { ScreenList } from '@/ui/screen';
import { alertError } from '@/ui/states';

/** The line a user sends an agent so it asks to connect by itself (GET /start tells it how). */
function connectMessage(relay: RelayStatus) {
  return relay.kind === 'paired' ? `Connect to my Puffer: ${relay.url.replace(/\/$/, '')}/start` : null;
}

function ConnectRow({ connect, onPress }: { connect: PendingConnect; onPress: () => void }) {
  return (
    <Button onPress={onPress}>
      <HStack spacing={12}>
        <Image systemName="link.badge.plus" modifiers={[frame({ width: 28 }), font({ size: 20 })]} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle('primary')]}>{connect.clientName}</Text>
          <Text modifiers={[font({ size: 13 }), secondary]}>{`Wants to connect · ${ago(connect.requestedAt)}`}</Text>
        </VStack>
        <Spacer />
      </HStack>
    </Button>
  );
}

export default function AgentsScreen() {
  const bridge = useBridge();
  const { agents, connects, requests, reads, relay } = bridge;
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const message = connectMessage(relay);
  const history = historyOf(requests, reads);

  const disconnect = (agent: Agent) =>
    Alert.alert(`Disconnect ${agent.name}?`, `${agent.name} can no longer read or write your notes, and its key stops working.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => void bridge.disconnect(agent.id).catch(alertError('Could Not Disconnect')),
      },
    ]);

  return (
    <>
      <Stack.Screen options={{ title: 'Agents' }} />
      <ScreenList>
        {connects.length ? (
          <Section title="Waiting for You">
            {connects.map((connect) => (
              <ConnectRow
                key={connect.id}
                connect={connect}
                onPress={() => router.push({ pathname: '/connect/[id]', params: { id: connect.id } })}
              />
            ))}
          </Section>
        ) : null}

        <Section
          title="Connected"
          footer={<Text>A connected agent reads and writes your notes and searches your documents. Everything it does shows in History.</Text>}
        >
          {agents.length ? null : <Text modifiers={[secondary]}>No agents yet. Send one the message below.</Text>}
          <List.ForEach onDelete={(indices) => indices.forEach((i) => disconnect(agents[i]))}>
            {agents.map((agent) => (
              <Button
                key={agent.id}
                onPress={() => router.push({ pathname: '/agents/agent/[id]', params: { id: agent.id } })}
              >
                <HStack spacing={12}>
                  <Image systemName="person.badge.key" modifiers={[frame({ width: 28 }), font({ size: 18 })]} />
                  <VStack alignment="leading" spacing={2}>
                    <Text modifiers={[foregroundStyle('primary')]}>{agent.name}</Text>
                    <Text modifiers={[font({ size: 13 }), secondary]}>
                      {`Active ${ago(lastActivity(agent.id, agent.connectedAt, bridge)).toLowerCase()}`}
                    </Text>
                  </VStack>
                  <Spacer />
                </HStack>
              </Button>
            ))}
          </List.ForEach>
        </Section>

        <Section
          title="Connect by Message"
          footer={
            <Text>
              Send this to an agent you chat with. It asks to connect and sends you a link that opens Puffer, where you
              approve it. The message holds no key.
            </Text>
          }
        >
          {message ? (
            <>
              <Text modifiers={[font({ size: 15 }), textSelection(true)]}>{message}</Text>
              <Button
                label={copied ? 'Copied' : 'Copy Message'}
                systemImage={copied ? 'checkmark' : 'doc.on.doc'}
                onPress={() => Clipboard.setStringAsync(message).then(() => setCopied(true), alertError('Could Not Copy'))}
              />
              <ShareLink item={message} />
            </>
          ) : (
            <Text modifiers={[secondary]}>Puffer is setting up its relay. Check the internet connection.</Text>
          )}
        </Section>

        {relay.kind === 'paired' ? (
          <Section title="Relay">
            <Label title={relay.url} systemImage="antenna.radiowaves.left.and.right" />
            <LabeledContent label="Last Contact">
              <Text>{relay.lastContact === null ? 'Never' : ago(relay.lastContact)}</Text>
            </LabeledContent>
            {relay.lastError ? <Text modifiers={[font({ size: 15 }), orange]}>{relay.lastError}</Text> : null}
          </Section>
        ) : null}

        {history.length ? (
          <Section title="History">
            {history.slice(0, 100).map((entry) => (
              <HistoryRow key={entry.kind === 'request' ? entry.request.id : entry.read.id} entry={entry} />
            ))}
          </Section>
        ) : null}
      </ScreenList>
    </>
  );
}
