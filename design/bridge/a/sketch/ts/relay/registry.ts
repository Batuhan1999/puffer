// relay/src/registry.ts
// Who may talk to this relay. The phone is the authority on agents; the relay keeps digests only.
// Persisted to relay/.state/registry.json (0600). Single writer: this module.

import type { AgentId, KeyDigest, WireRegistry } from './protocol';

export type Registry = {
  deviceKeyDigest: KeyDigest;
  /** The phone's registry revision last applied. A lower or equal revision from the phone is ignored. */
  revision: number;
  agents: readonly { id: AgentId; name: string; keyDigest: KeyDigest }[];
};

/**
 * Loads the state file. On first run mints a device key ("dk_" + 32 random bytes, base64url), stores
 * its digest, and returns the plaintext key once so the CLI can print the pairing link.
 */
export function openRegistry(path: string): { registry: Registry; newDeviceKey: string | null } {
  throw new Error('not implemented');
}

/** "Authorization: Bearer ak_..." -> the agent, by constant-time digest comparison. */
export function authenticateAgent(registry: Registry, authorization: string | undefined): { id: AgentId; name: string } | null {
  throw new Error('not implemented');
}

export function authenticateDevice(registry: Registry, authorization: string | undefined): boolean {
  throw new Error('not implemented');
}

/**
 * Full replace from the phone's snapshot when wire.revision > registry.revision. Idempotent: the same
 * snapshot twice is a no-op. Agents that disappear lose access immediately; their parked requests expire.
 */
export function applyPhoneRegistry(registry: Registry, wire: WireRegistry): Registry {
  throw new Error('not implemented');
}

export function saveRegistry(path: string, registry: Registry): void {
  throw new Error('not implemented');
}

/** puffer://pair?relay=<encoded base URL>&key=<device key> */
export function pairingLink(baseUrl: string, deviceKey: string): string {
  throw new Error('not implemented');
}
