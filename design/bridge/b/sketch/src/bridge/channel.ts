import type { AgentRoster, Outcome, RequestId, ToPhone, ToRelay } from '../../shared/bridge-protocol';

// The phone's socket to the relay. Pure transport: reconnect with backoff, heartbeat, typed send/receive,
// a short background grace via UIApplication.beginBackgroundTask so an in-flight `decided` gets out before iOS
// suspends the app. No policy here; `bridge.tsx` owns what to do with messages.

export type ChannelState =
  | { kind: 'unpaired' }
  | { kind: 'connecting'; relayUrl: string }
  | { kind: 'online'; relayUrl: string; since: number }
  | { kind: 'offline'; relayUrl: string; retryAt: number; reason: string };

export type Pairing = { relayUrl: string; deviceToken: string; deviceId: string };

export interface Channel {
  state(): ChannelState;
  onState(listener: (s: ChannelState) => void): () => void;
  onMessage(listener: (m: ToPhone) => void): () => void;
  /** Buffered while offline; flushed in order on reconnect. `decided` is retried until `decided-ack`. */
  send(m: ToRelay): void;
  sendDecision(id: RequestId, outcome: Outcome): void;
  syncAgents(agents: readonly AgentRoster[]): void;
  close(): void;
}

/** `pairing` comes from the Keychain (expo-secure-store); the device token never touches AsyncStorage or the DB. */
export function openChannel(pairing: Pairing, deviceName: string): Channel {
  throw new Error('not implemented');
}

/** POST /pair on the relay with the code the user typed, then persist the result in the Keychain. */
export async function pair(relayUrl: string, code: string, deviceName: string): Promise<Pairing> {
  throw new Error('not implemented');
}
