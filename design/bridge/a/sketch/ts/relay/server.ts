// relay/src/server.ts
// `npx tsx src/server.ts [--port 8787] [--host 127.0.0.1] [--state .state/registry.json] [--wait 50s]`
// node:http, no framework. Binds to 127.0.0.1 by default: nothing is reachable from outside this Mac
// until the user deliberately puts HTTPS and a tunnel or host in front of it.
//
// Routes
//   POST /mcp              agent bearer key  -> Streamable HTTP MCP (mcp.createAgentServer)
//   POST /v1/device/sync   device bearer key -> protocol.parseSyncBody -> registry.applyPhoneRegistry -> mailbox.sync
//   GET  /healthz          no auth           -> { ok, phone: { online, lastSeenAt } } with no request contents

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Mailbox } from './mailbox';
import type { Registry } from './registry';

export type RelayConfig = {
  host: string;
  port: number;
  statePath: string;
  waitMs: number;
  publicBaseUrl: string; // what goes into the pairing link and setup commands; http://localhost:<port> by default
};

export function parseArgs(argv: readonly string[]): RelayConfig {
  throw new Error('not implemented');
}

/** Opens the registry, prints the pairing link on first run (and on --print-pairing), starts the server. */
export async function main(argv: readonly string[]): Promise<void> {
  throw new Error('not implemented');
}

/**
 * Routes one request. 401 without a valid bearer for the route, 426 on protocol mismatch.
 * The registry reference is replaced (not mutated) when the phone pushes a newer revision.
 */
export function handle(
  deps: { mailbox: Mailbox; registry: () => Registry; setRegistry: (r: Registry) => void; config: RelayConfig },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  throw new Error('not implemented');
}
