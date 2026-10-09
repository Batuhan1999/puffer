import { Button, Host, HStack, Image, List, Section, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import { disabled, font, foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { blue, orange, secondary } from '@/ui/colors';
import { ago } from '@/ui/format';
import { usePreview } from '@/ui/preview';
import { Unavailable } from '@/ui/states';

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const preview = usePreview();
  const router = useRouter();
  const agent = preview.agents.find((a) => a.id === id);

  if (!agent) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <Unavailable title="Unknown Agent" systemImage="questionmark.circle" description="This agent is not in the preview." />
      </>
    );
  }

  const requests = preview.requests.filter((r) => r.agentId === agent.id);

  return (
    <>
      <Stack.Screen options={{ title: agent.name, headerLargeTitleEnabled: false }} />
      <Host style={{ flex: 1 }}>
        <List>
          <Section>
            <HStack spacing={16}>
              <Image systemName={agent.symbol} size={34} modifiers={[blue]} />
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ size: 22, weight: 'bold' })]}>{agent.name}</Text>
                <Text modifiers={[secondary]}>{agent.role}</Text>
                <Text modifiers={[font({ size: 13 }), orange]}>Preview · Not connected</Text>
              </VStack>
            </HStack>
          </Section>

          <Section
            title="Open Without Asking"
            footer={
              <Text>
                {`When ${agent.name} asks about something in these collections, matching text snippets would be shared without asking you. Photos always wait for your approval.`}
              </Text>
            }
          >
            {preview.collections.map((collection) => (
              <Toggle
                key={collection.id}
                label={collection.name}
                systemImage={collection.symbol}
                isOn={agent.allowed.includes(collection.id)}
                onIsOnChange={(on) => preview.allow(agent.id, collection.id, on)}
              />
            ))}
          </Section>

          {requests.length ? (
            <Section title="Requests">
              {requests.map((request) => (
                <Button
                  key={request.id}
                  onPress={() => router.push({ pathname: '/request/[id]', params: { id: request.id } })}
                >
                  <VStack alignment="leading" spacing={2}>
                    <Text modifiers={[foregroundStyle('primary'), lineLimit(2)]}>{request.question}</Text>
                    <Text modifiers={[font({ size: 13 }), secondary]}>
                      {request.status.kind === 'pending'
                        ? `Waiting · ${ago(request.receivedAt)}`
                        : request.status.kind === 'shared'
                          ? 'Shared'
                          : 'Denied'}
                    </Text>
                  </VStack>
                </Button>
              ))}
            </Section>
          ) : null}

          <Section footer={<Text>Connecting needs the relay, which is not built yet.</Text>}>
            <Button label={`Connect ${agent.name}`} systemImage="link" modifiers={[disabled(true)]} />
          </Section>
        </List>
      </Host>
    </>
  );
}
