import {
  Host,
  HStack,
  Image,
  LabeledContent,
  List,
  Section,
  Text,
  VStack,
} from '@expo/ui/swift-ui';
import { font } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { useBridge } from '@/bridge';
import { blue, orange, secondary } from '@/ui/colors';
import { ago } from '@/ui/format';
import { alertError, Loading, Unavailable } from '@/ui/states';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export default function ConnectScreen() {
  // `link` is the approve link's secret: Puffer opens here only through puffer://connect/<id>?link=<secret>.
  const { id, link } = useLocalSearchParams<{ id: string; link?: string }>();
  const bridge = useBridge();
  const { openConnectLink } = bridge;
  const router = useRouter();
  const [openedAt] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const connect = bridge.connects.find((c) => c.id === id);

  useEffect(() => {
    if (link) openConnectLink(id, link).catch(alertError('Could Not Open'));
  }, [id, link, openConnectLink]);

  if (!connect) {
    // Opened from the page's link, Puffer may not have heard from the relay yet.
    const heard = bridge.relay.kind === 'paired' && (bridge.relay.lastContact ?? 0) >= openedAt;
    return (
      <>
        <Stack.Screen options={{ title: 'Connect' }} />
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button variant="done" onPress={() => router.back()}>
            Done
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
        {bridge.loaded && (heard || bridge.relay.kind === 'unpaired') ? (
          <Unavailable
            title="No Longer Waiting"
            systemImage="link"
            description="This connection request was answered or expired. Start again from the app that asked."
          />
        ) : (
          <Loading label="Checking with your relay" />
        )}
      </>
    );
  }

  const settle = (work: Promise<unknown>, failure: string) => {
    setBusy(true);
    work.then(
      () => router.back(),
      (e) => {
        setBusy(false);
        alertError(failure)(e);
      },
    );
  };
  const approve = () => settle(bridge.approveConnect(connect), 'Could Not Approve');
  const decline = () => settle(bridge.declineConnect(connect.id), 'Could Not Decline');
  const { origin } = connect;

  return (
    <>
      <Stack.Screen options={{ title: 'Connect Agent', headerLargeTitleEnabled: true }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button disabled={busy} onPress={decline}>
          Decline
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="prominent" disabled={busy} onPress={approve}>
          Approve
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <List>
          <Section
            footer={
              <Text>
                {origin.kind === 'oauth' && LOOPBACK.has(origin.redirectHost)
                  ? `${connect.clientName} returns to an app on a computer. Only approve if you just started connecting it there. ` +
                    'Once approved, it can read and write your notes and search your documents.'
                  : 'Only approve if you just started connecting an app or agent. Once approved, it can read and write your ' +
                    'notes and search your documents.'}
              </Text>
            }
          >
            <HStack spacing={12}>
              <Image systemName={origin.kind === 'link' ? 'message.badge' : 'link.badge.plus'} size={26} modifiers={[blue]} />
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{`${connect.clientName} wants to connect`}</Text>
                <Text modifiers={[font({ size: 13 }), secondary]}>{ago(connect.requestedAt)}</Text>
              </VStack>
            </HStack>
            {origin.kind === 'link' ? (
              <LabeledContent label="Name">
                <Text modifiers={[orange]}>Chosen by the agent, not verified</Text>
              </LabeledContent>
            ) : (
              <>
                <LabeledContent label="Returns To">
                  <Text>{origin.redirectHost}</Text>
                </LabeledContent>
                <LabeledContent label="Name From">
                  {origin.clientHost ? (
                    <Text>{origin.clientHost}</Text>
                  ) : (
                    <Text modifiers={[orange]}>The app itself, not verified</Text>
                  )}
                </LabeledContent>
              </>
            )}
          </Section>

        </List>
      </Host>
    </>
  );
}
