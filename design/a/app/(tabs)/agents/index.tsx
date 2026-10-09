import { Button, Host, HStack, Image, Label, List, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, frame, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';

import { orange, secondary } from '@/ui/colors';
import { ago, plural } from '@/ui/format';
import { type Agent, type AgentRequest, pendingRequests, usePreview } from '@/ui/preview';
import { NavRow } from '@/ui/rows';

function outcome(request: AgentRequest) {
  switch (request.status.kind) {
    case 'pending':
      return ago(request.receivedAt);
    case 'shared':
      return request.status.itemIds.length ? `Shared ${plural(request.status.itemIds.length, 'item')}` : 'Shared nothing';
    case 'denied':
      return 'Denied';
  }
}

function RequestRow({ request, agent, onPress }: { request: AgentRequest; agent: Agent; onPress: () => void }) {
  return (
    <Button onPress={onPress}>
      <HStack spacing={12} alignment="top">
        <Image systemName={agent.symbol} modifiers={[frame({ width: 28 }), font({ size: 20 })]} />
        <VStack alignment="leading" spacing={3}>
          <HStack>
            <Text modifiers={[font({ size: 15, weight: 'semibold' }), foregroundStyle('primary')]}>{agent.name}</Text>
            <Spacer />
            <Text modifiers={[font({ size: 13 }), secondary]}>{outcome(request)}</Text>
          </HStack>
          <Text modifiers={[foregroundStyle('primary'), lineLimit(2)]}>{request.question}</Text>
        </VStack>
      </HStack>
    </Button>
  );
}

export default function AgentsScreen() {
  const preview = usePreview();
  const router = useRouter();
  const pending = pendingRequests(preview.requests);
  const history = preview.requests.filter((r) => r.status.kind !== 'pending');
  const agentOf = (id: string) => preview.agents.find((a) => a.id === id);
  const open = (id: string) => router.push({ pathname: '/request/[id]', params: { id } });

  const access = (agent: Agent) => {
    const names = preview.collections.filter((c) => agent.allowed.includes(c.id)).map((c) => c.name);
    return names.length ? `${names.join(', ')} without asking` : 'Asks every time';
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Agents' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={preview.simulateRequest} accessibilityHint="Adds a simulated request to the list">
          Simulate
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <List>
          <Section>
            <HStack spacing={12} alignment="top">
              <Image systemName="eye" modifiers={[frame({ width: 28 }), font({ size: 20 }), orange]} />
              <VStack alignment="leading" spacing={3}>
                <Text modifiers={[font({ size: 15, weight: 'semibold' })]}>Preview</Text>
                <Text modifiers={[font({ size: 15 }), secondary]}>
                  The agent bridge is not built yet. Requests here are simulated on this iPhone, and approving one
                  sends nothing.
                </Text>
              </VStack>
            </HStack>
          </Section>

          <Section title="Waiting for You">
            {pending.length ? (
              pending.map((request) => {
                const agent = agentOf(request.agentId);
                return agent ? (
                  <RequestRow key={request.id} request={request} agent={agent} onPress={() => open(request.id)} />
                ) : null;
              })
            ) : (
              <Text modifiers={[secondary]}>No requests are waiting. Tap Simulate to see how one would look.</Text>
            )}
          </Section>

          <Section
            title="Agents"
            footer={<Text>Choose which collections an agent may use without asking. Everything else waits for you.</Text>}
          >
            {preview.agents.map((agent) => (
              <NavRow
                key={agent.id}
                title={agent.name}
                subtitle={access(agent)}
                systemImage={agent.symbol}
                onPress={() => router.push({ pathname: '/agents/agent/[id]', params: { id: agent.id } })}
              />
            ))}
          </Section>

          <Section
            title="How It Would Work"
            footer={<Text>Only captions, text snippets and photos you approve leave this iPhone. Never the index.</Text>}
          >
            <Label title="An agent asks a question through a small relay" systemImage="antenna.radiowaves.left.and.right" />
            <Label title="Puffer searches on this iPhone" systemImage="iphone" />
            <Label title="You see exactly what would be shared" systemImage="eye" />
            <Label title="You approve or deny each request" systemImage="hand.raised" />
          </Section>

          {history.length ? (
            <Section title="History">
              {history.map((request) => {
                const agent = agentOf(request.agentId);
                return agent ? (
                  <RequestRow key={request.id} request={request} agent={agent} onPress={() => open(request.id)} />
                ) : null;
              })}
            </Section>
          ) : null}
        </List>
      </Host>
    </>
  );
}
