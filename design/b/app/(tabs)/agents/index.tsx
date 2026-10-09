import { Button, HStack, Host, Image, Label, List, Section, Spacer, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, font, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { Stack, router } from 'expo-router';
import { PlatformColor } from 'react-native';

import { AgentRequest, useAgents } from '@/ui/b/agents';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const small = font({ size: 13 });

export default function Agents() {
  const bridge = useAgents();
  const { pending, history, agents, collections, agent } = bridge;

  const open = (r: AgentRequest) => router.push(`/agents/request/${r.id}`);

  return (
    <>
      <Stack.Screen options={{ title: 'Agents' }} />
      <Host style={{ flex: 1 }}>
        <List>
          <Section
            footer={
              <Text>
                Preview. No agent can reach Puffer yet. Requests on this screen are generated on this phone to show how approval will work.
              </Text>
            }>
            <Label title="Agent bridge preview" systemImage="eye" color={PlatformColor('systemOrange')} />
          </Section>

          <Section title={pending.length ? `Waiting for you (${pending.length})` : 'Waiting for you'}>
            {pending.length === 0 && <Text modifiers={[secondary]}>No open requests.</Text>}
            {pending.map((r) => (
              <Button key={r.id} onPress={() => open(r)} modifiers={[buttonStyle('plain')]}>
                <HStack spacing={12}>
                  <Image systemName={agent(r.agentId).symbol} size={22} color={PlatformColor('systemBlue')} />
                  <VStack alignment="leading" spacing={2}>
                    <Text>{r.question}</Text>
                    <HStack spacing={4}>
                      <Text modifiers={[secondary, small]}>{agent(r.agentId).name}</Text>
                      <Text modifiers={[secondary, small]}>·</Text>
                      <Text date={new Date(r.at)} dateStyle="relative" modifiers={[secondary, small]} />
                    </HStack>
                  </VStack>
                  <Spacer />
                  <Image systemName="chevron.right" size={13} color={PlatformColor('tertiaryLabel')} />
                </HStack>
              </Button>
            ))}
            <Button label="Simulate a request" systemImage="wand.and.stars" onPress={bridge.simulateRequest} />
          </Section>

          <Section title="Connected agents" footer={<Text>A disconnected agent cannot ask anything. Connecting is a preview switch, nothing is set up outside this phone.</Text>}>
            {agents.map((a) => (
              <Toggle key={a.id} label={a.name} systemImage={a.symbol} isOn={a.connected} onIsOnChange={() => bridge.toggleAgent(a.id)} />
            ))}
          </Section>

          <Section
            title="Pre-approved collections"
            footer={<Text>A pre-approved collection answers matching questions from the listed agents without asking you each time.</Text>}>
            {collections.map((c) => (
              <Button key={c.id} onPress={() => router.push(`/agents/collection/${c.id}`)} modifiers={[buttonStyle('plain')]}>
                <HStack spacing={12}>
                  <Image systemName={c.symbol} size={20} color={PlatformColor('systemBlue')} />
                  <VStack alignment="leading" spacing={2}>
                    <Text>{c.name}</Text>
                    <Text modifiers={[secondary, small]}>
                      {c.preapproved.length ? `Open to ${c.preapproved.map((id) => agent(id).name).join(', ')}` : 'Asks every time'}
                    </Text>
                  </VStack>
                  <Spacer />
                  <Image systemName="chevron.right" size={13} color={PlatformColor('tertiaryLabel')} />
                </HStack>
              </Button>
            ))}
          </Section>

          {history.length > 0 && (
            <Section title="History">
              {history.map((r) => (
                <HStack key={r.id} spacing={12}>
                  <Image
                    systemName={r.status === 'approved' ? 'checkmark.circle.fill' : 'xmark.circle.fill'}
                    size={20}
                    color={PlatformColor(r.status === 'approved' ? 'systemGreen' : 'systemRed')}
                  />
                  <VStack alignment="leading" spacing={2}>
                    <Text>{r.question}</Text>
                    <Text modifiers={[secondary, small]}>
                      {r.status === 'approved'
                        ? `${agent(r.agentId).name} received ${r.shared?.photos ?? 0} photos and ${r.shared?.snippets ?? 0} snippets`
                        : `Denied for ${agent(r.agentId).name}`}
                    </Text>
                  </VStack>
                </HStack>
              ))}
            </Section>
          )}

          <Section title="What can leave the phone">
            <Label title="Snippets and captions you approve" systemImage="checkmark" color={PlatformColor('systemGreen')} />
            <Label title="Photos you approve, as images" systemImage="checkmark" color={PlatformColor('systemGreen')} />
            <Label title="Never the index or its vectors" systemImage="xmark" color={PlatformColor('systemRed')} />
          </Section>
        </List>
      </Host>
    </>
  );
}
