// Relay entry point. Binds 127.0.0.1 only; the simulator reaches it at http://localhost:8787 (verified in the
// grounding). Public exposure is a separate step (tunnel in front, OAuth 2.1 in `authenticate`), never the default.
//
// Routes:
//   POST /pair          body PairRequest  -> PairResponse          (one-time code from stdout)
//   GET  /link          WebSocket upgrade, Authorization: Bearer <deviceToken>
//   ANY  /mcp           Streamable HTTP MCP, Authorization: Bearer <agentSecret>
//   GET  /.well-known/oauth-protected-resource  (later; 404 now)
// Origin and Host are validated with the SDK's localhost validators before any handler runs.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { Ledger } from './ledger';
import type { AgentContext } from './mcp';
import { PhoneLink } from './phone';

export type RelayConfig = { port: number; dataFile: string; maxWaitMs: number };

/** Returns the agent for a bearer secret or writes 401 and returns null. Static keys now; OAuth 2.1 later lives here. */
export function authenticate(req: IncomingMessage, res: ServerResponse, ledger: Ledger): AgentContext | null {
  throw new Error('not implemented');
}

export function start(config: RelayConfig): Promise<{ close(): Promise<void> }> {
  throw new Error('not implemented');
}

if (require.main === module) {
  start({ port: 8787, dataFile: '.puffer-relay.sqlite', maxWaitMs: 540_000 }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
