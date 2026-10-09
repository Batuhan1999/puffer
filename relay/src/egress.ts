// Every request the relay makes to a URL someone else chose: MCP event callbacks, the webhook the user set on the
// phone, and client ID metadata documents. Private and loopback addresses are refused, and the connection goes to
// the address that was checked, so DNS cannot answer differently between the check and the connect. Bodies are read
// as sent (identity) and only up to a cap: a gzip bomb or an endless body costs a few KB.

import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
// BlockList matches ::ffff:a.b.c.d against the IPv4 rules itself. These are the other IPv6 forms that embed or
// reach a private IPv4 address, plus loopback, unique local (Fly's private network is fdaa::/16), link-local and multicast.
for (const [network, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function inList(list: BlockList, address: string): boolean | null {
  const family = isIP(address);
  if (family === 0) return null;
  try {
    return list.check(address, family === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return null;
  }
}

/** Public unicast only; loopback too when `allowLoopback` (--dev-callbacks). Anything unparseable is refused. */
export function addressAllowed(address: string, allowLoopback: boolean): boolean {
  const notPublic = inList(NOT_PUBLIC, address);
  return notPublic === false || (notPublic === true && allowLoopback && inList(LOOPBACK, address) === true);
}

export type Exchange = {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** 0: answer with the status and never read the body. */
  maxBytes: number;
};

/** Why an exchange produced no usable response. The relay logs it; callers decide how much to say on the wire. */
export type EgressFailure = 'blocked_address' | 'dns' | 'connection_refused' | 'timeout' | 'tls_error' | 'encoded' | 'too_large';

export type Reply = { kind: 'response'; status: number; body: string } | { kind: 'failed'; why: EgressFailure };

/** No redirects: a 3xx is an answer, not a hop to somewhere the address policy never checked. */
export async function send(url: URL, exchange: Exchange, allowLoopback: boolean): Promise<Reply> {
  const signal = AbortSignal.timeout(exchange.timeoutMs);
  let targets: { address: string; family: number }[];
  try {
    targets = await lookup(url.hostname.replace(/^\[(.*)\]$/, '$1'), { all: true, verbatim: true });
  } catch {
    return { kind: 'failed', why: 'dns' };
  }
  const [first] = targets;
  if (!first || targets.some(({ address }) => !addressAllowed(address, allowLoopback))) return { kind: 'failed', why: 'blocked_address' };
  const { method, headers, body, maxBytes } = exchange;
  return new Promise<Reply>((resolve) => {
    const fail = (why: EgressFailure) => resolve({ kind: 'failed', why });
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: { ...headers, 'accept-encoding': 'identity', ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) },
        signal,
        // Every address was checked; Node's happy eyeballs (lookup with `all`) may try any of them.
        lookup: (_hostname, options, callback) =>
          options.all ? callback(null, targets) : (callback as (e: null, a: string, f: number) => void)(null, first.address, first.family),
      },
      (res) => read(res, maxBytes, signal).then(resolve),
    );
    request.on('error', (error: NodeJS.ErrnoException) =>
      fail(signal.aborted ? 'timeout' : /CERT|TLS|SSL/.test(String(error.code)) ? 'tls_error' : 'connection_refused'),
    );
    request.end(body);
  });
}

function read(res: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Reply> {
  const status = res.statusCode ?? 0;
  const encoding = res.headers['content-encoding'];
  if (maxBytes === 0 || (encoding !== undefined && encoding !== 'identity')) {
    res.destroy();
    return Promise.resolve(maxBytes === 0 ? { kind: 'response', status, body: '' } : { kind: 'failed', why: 'encoded' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        resolve({ kind: 'failed', why: 'too_large' });
      } else {
        chunks.push(chunk);
      }
    });
    res.on('end', () => resolve({ kind: 'response', status, body: Buffer.concat(chunks).toString('utf8') }));
    res.on('close', () => resolve({ kind: 'failed', why: signal.aborted ? 'timeout' : 'connection_refused' }));
  });
}
