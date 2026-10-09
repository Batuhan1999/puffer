import type { AgentId, DeviceId } from './protocol';

// The relay's only durable data: one paired device key and the agent credential hashes. A JSON file for the prototype.

export type DeviceRecord = { deviceId: DeviceId; publicKeyDer: string };
export type AgentRecord = { agentId: AgentId; secretSha256: string; name: string; revoked: boolean };

export interface Registry {
  /** Prints a one-time code to the relay console and returns it. Valid 10 minutes. */
  newPairingCode(): string;
  /** Consumes the code. Replaces any previously paired device, because one relay serves one phone. */
  pairDevice(code: string, publicKeyDer: string): DeviceRecord | null;
  device(): DeviceRecord | null;
  verifyDeviceSignature(deviceId: DeviceId, nonce: string, signature: string): boolean;
  verifyPhoneSignature(deviceId: DeviceId, payload: string, signature: string): boolean;
  upsertAgent(record: AgentRecord): void;
  revokeAgent(agentId: AgentId): void;
}

/**
 * Agent authentication seam. The prototype accepts `Authorization: Bearer pk_<agentId>.<secret>`
 * and compares sha256(secret) in constant time. OAuth 2.1 (RFC 9728 metadata, PKCE, RFC 8707 audience)
 * is a second implementation of this interface for Claude.ai and ChatGPT connectors. Nothing else changes.
 */
export interface AgentAuthenticator {
  authenticate(authorizationHeader: string | undefined): AgentId | null;
}

export function createRegistry(path: string): Registry {
  throw new Error('not implemented');
}
export function bearerAuthenticator(registry: Registry): AgentAuthenticator {
  throw new Error('not implemented');
}
