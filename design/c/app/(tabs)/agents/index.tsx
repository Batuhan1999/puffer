import { DisclosureGroup, Host, HStack, Image, Label, List, Section, Spacer, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, onTapGesture } from '@expo/ui/swift-ui/modifiers';
import { useRouter } from 'expo-router';

import { AGENTS, AgentRequest, COLLECTIONS, useAgentPreview } from '@/ui/c/agents';

const STATUS: Record<AgentRequest['decision'], string> = { pending: 'Waiting', approved: 'Approved', denied: 'Denied' };

export default function AgentsScreen() {
  const router = useRouter();
  const { requests, preapproved, setPreapproved } = useAgentPreview();
  const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

  return (
    <Host style={{ flex: 1 }}>
      <List>
        <Section footer={<Text>Nothing here connects to a real agent. The requests are simulated, and nothing is sent anywhere.</Text>}>
          <Label title="Concept preview" systemImage="flask" />
          <Text modifiers={[font({ size: 15 }), secondary]}>
            Later, assistants you trust could ask Puffer a question. You would see exactly which snippets and photos would be shared, and approve or deny each request. Your index and vectors never leave this iPhone.
          </Text>
        </Section>
        <Section title="Requests">
          {requests.map((r) => (
            <HStack key={r.id} modifiers={[onTapGesture(() => router.push({ pathname: '/agents/request/[id]', params: { id: r.id } }))]}>
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ weight: 'semibold' })]}>{r.agent}</Text>
                <Text modifiers={[font({ size: 14 }), secondary]}>{r.question}</Text>
              </VStack>
              <Spacer />
              <Text modifiers={[font({ size: 14 }), foregroundStyle(r.decision === 'pending' ? 'orange' : 'gray')]}>{STATUS[r.decision]}</Text>
              <Image systemName="chevron.right" size={13} modifiers={[secondary]} />
            </HStack>
          ))}
        </Section>
        <Section title="Pre-approved collections" footer={<Text>A pre-approved collection would let that agent read matching snippets without asking each time.</Text>}>
          {AGENTS.map((a) => (
            <DisclosureGroup key={a.name} label={a.name}>
              {COLLECTIONS.map((c) => (
                <Toggle
                  key={c.id}
                  label={c.name}
                  systemImage={c.symbol}
                  isOn={preapproved(a.name, c.id)}
                  onIsOnChange={(on) => setPreapproved(a.name, c.id, on)}
                />
              ))}
            </DisclosureGroup>
          ))}
        </Section>
      </List>
    </Host>
  );
}
