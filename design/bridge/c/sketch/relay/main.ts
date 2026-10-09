// pnpm tsx relay/main.ts   -> listens on 127.0.0.1:8787, prints the pairing code and the `claude mcp add` line.
// Binds loopback only. Public exposure (tunnel or deploy) is a separate, explicit step, and changes only `listen` and TLS.
export async function main(): Promise<void> {
  throw new Error('not implemented');
}
