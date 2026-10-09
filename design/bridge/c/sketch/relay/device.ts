import type { Mailbox } from './mailbox';
import type { Registry } from './pairing';

/**
 * WebSocket endpoint at /device. The phone dials out, so the relay never needs an inbound path to the phone.
 * Flow: hello(nonce) -> pair | auth -> sync -> asks flow down, answers flow up.
 * One device at a time. A newer connection replaces the older one.
 * Presence flips to offline on close or after two missed pings (iOS suspends sockets without a close frame).
 */
export function attachDeviceSocket(server: import('node:http').Server, mailbox: Mailbox, registry: Registry): void {
  throw new Error('not implemented');
}
