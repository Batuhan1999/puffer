// `npm run relay -- [--host 127.0.0.1] [--port 8787] [--state .state/registry.json] [--public-url URL] ...`; flags and
// env in README.md. node:http, no framework. Binds 127.0.0.1 unless --host or HOST says otherwise.
//
// Routes
// Every bearer key resolves to one tenant (registry.Tenants): a device key to its own tenant, an agent key or an OAuth
// access token (oauth.claim) to the tenant whose phone registered the agent. Each tenant has its own mailbox and notifier.
//
//   POST /mcp              agent bearer key  -> Streamable HTTP MCP (mcp.createAgentServer) on the agent's tenant, tools
//                                               and events/*; 401 names the resource metadata for OAuth clients
//   /v1/ask, /v1/answers/<id>, /v1/recent, /v1/sources, /v1/changes, /v1/notes/...  agent bearer key -> http.serveAgentApi,
//                                               the same operations as JSON, for agents without MCP; same 401 challenge
//   GET  /openapi.json     no auth           -> http.openApiDocument for those
//   GET  /start            no auth           -> http.startDocument: how an agent connects by message and uses the API
//   POST /v1/connect, POST /v1/connect/<id>/token  no auth / poll token -> oauth.linkConnect, oauth.linkToken
//   GET  /c/<secret>       no auth           -> a page that opens Puffer's approval for that connection
//   POST /v1/device/register  no auth, per caller -> tenants.register: a new tenant and its dk_ key
//   POST /v1/device/sync   device bearer key -> protocol.parseSyncBody -> tenants.synced -> tenants.applyRegistry
//                                               -> notifier.setWebhooks -> notifier.recordHeads -> mailbox.replacePages
//                                               -> oauth.decline/approve -> mailbox.sync -> oauth.revokedKeys
//                          an unknown or pruned device key gets 401 unknown_device: the phone registers again
//   GET  /v1/device/connects/by-link/<secret>  device bearer key -> oauth.byLink: the connection a link opened
//   POST /v1/device/connects/<id>/confirm  device bearer key -> oauth.confirm (the link secret claims it for the tenant)
//   GET  /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server  -> discovery (SDK)
//   POST /register, GET /authorize, GET /authorize/poll/<token>, POST /token                   -> oauth.AuthServer
//   GET  /healthz          no auth           -> { ok: true }
//   GET  /open/<id>        no auth           -> a page that opens Puffer's agent list (puffer://agents)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  localhostAllowedHostnames,
  oauthMetadataResponse,
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server';

import { openApiDocument, serveAgentApi, startDocument } from './http';
import { RateLimit, callerKey } from './limits';
import { DEFAULT_MAILBOX_OPTIONS } from './mailbox';
import { createAgentServer } from './mcp';
import { AuthServer, DEFAULT_CONNECT_TTL_MS } from './oauth';
import { ConfirmBody, ConnectId, PROTOCOL_VERSION, RequestId, parseSyncBody, type AgentId, type SyncResponse } from './protocol';
import { Tenants, type Tenant } from './registry';

// Claude Code times each HTTP MCP request to the server's first response byte at 60 s by default
// (code.claude.com/docs/en/mcp), and a JSON-mode tool result sends its first byte only when it is done.
// 50 s stays under that with margin, and under the 2 min auto-background and 5 min idle limits.
const DEFAULT_WAIT_MS = 50_000;
/**
 * Room for one answer with 15 MB of original files as base64 (20 MB) plus its text. The phone sends larger outboxes in
 * parts. Larger bodies get 413, before a byte is read when Content-Length says so.
 */
const MAX_SYNC_BODY_BYTES = 24 * 1024 * 1024;
/** Sync bodies over this (or of unknown length) are read and parsed one at a time, so a few phones cannot fill memory. */
const LARGE_SYNC_BODY_BYTES = 4 * 1024 * 1024;
const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const MAX_CONFIRM_BODY_BYTES = 1024;
/** A name plus a callback_url of up to 2048 characters. */
const MAX_CONNECT_BODY_BYTES = 4 * 1024;
const SWEEP_EVERY_MS = 30_000;
/** Self-registration per caller address. Each registration is a tenant on disk until the relay's operator removes it. */
const REGISTRATIONS = { perCaller: 5, windowMs: 60 * 60_000 };
const DEFAULT_MAX_DEVICES = 1_000;
/**
 * Node's requestTimeout runs only until the request is fully received, so the 25 s device long-poll and the 50 s MCP
 * wait are not cut short by it; it bounds uploads, including the wait for a turn to send a large sync body. A sync body
 * with files is up to 24 MB, so it alone gets 2 minutes to arrive. Small bodies anyone may send get 10 s.
 */
const TIMEOUTS = { headersMs: 10_000, requestMs: 30_000, smallBodyMs: 10_000, syncBodyMs: 120_000, checkEveryMs: 1_000 };
const READ = ['GET', 'HEAD'] as const;
const DISCOVERY = ['GET', 'HEAD', 'OPTIONS'] as const;
/** /authorize creates a connection and its poll mints a code, so neither answers HEAD. */
const GET = ['GET'] as const;
const WRITE = ['POST'] as const;

/** Answered as {error: code, message}, the shape the HTTP API promises agents. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Config = {
  host: string;
  /** PUFFER_TRUST_PROXY=fly: Fly's proxy sets Fly-Client-IP, so per-caller limits key on it instead of the socket. */
  trustFlyClientIp: boolean;
  port: number;
  statePath: string;
  /** Origin agents and the phone reach this relay at. Null: http://localhost:<bound port>. */
  publicUrl: string | null;
  waitMs: number;
  devCallbacks: boolean;
  notifyDebounceMs: number;
  offlineAfterMs: number;
  connectTtlMs: number;
  /** Devices (tenants) the relay holds at most; self-registration answers 503 beyond it. */
  maxDevices: number;
};

function integer(name: string, raw: string, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > max) throw new Error(`${name} must be an integer from 0 to ${max}, got ${raw}`);
  return value;
}

function origin(name: string, raw: string): string {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (!url || !/^https?:$/.test(url.protocol) || url.origin !== raw.replace(/\/$/, '')) {
    throw new Error(`${name} must be an http(s) origin such as https://relay.example.com, got ${raw}`);
  }
  return url.origin;
}

/** CLI flags win over the environment, which wins over the defaults. */
function config(argv: string[], env: NodeJS.ProcessEnv): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      state: { type: 'string' },
      'public-url': { type: 'string' },
      'wait-ms': { type: 'string' },
      'dev-callbacks': { type: 'boolean' },
      'notify-debounce-ms': { type: 'string' },
      'offline-after-ms': { type: 'string' },
      'connect-ttl-ms': { type: 'string' },
      'max-devices': { type: 'string' },
    },
  });
  const publicUrl = values['public-url'] ?? env.PUFFER_PUBLIC_URL;
  if (![undefined, '', 'fly'].includes(env.PUFFER_TRUST_PROXY)) throw new Error(`PUFFER_TRUST_PROXY must be fly or unset, got ${env.PUFFER_TRUST_PROXY}`);
  return {
    host: values.host ?? env.HOST ?? '127.0.0.1',
    trustFlyClientIp: env.PUFFER_TRUST_PROXY === 'fly',
    port: integer('--port', values.port ?? env.PORT ?? '8787', 65_535),
    statePath: resolve(values.state ?? env.PUFFER_STATE ?? resolve(import.meta.dirname, '../.state/registry.json')),
    publicUrl: publicUrl ? origin('--public-url', publicUrl) : null,
    waitMs: integer('--wait-ms', values['wait-ms'] ?? String(DEFAULT_WAIT_MS)),
    devCallbacks: values['dev-callbacks'] ?? env.PUFFER_DEV_CALLBACKS === '1',
    notifyDebounceMs: integer('--notify-debounce-ms', values['notify-debounce-ms'] ?? env.PUFFER_NOTIFY_DEBOUNCE_MS ?? '3000'),
    offlineAfterMs: integer('--offline-after-ms', values['offline-after-ms'] ?? String(DEFAULT_MAILBOX_OPTIONS.offlineAfterMs)),
    connectTtlMs: integer('--connect-ttl-ms', values['connect-ttl-ms'] ?? String(DEFAULT_CONNECT_TTL_MS)),
    maxDevices: integer('--max-devices', values['max-devices'] ?? env.PUFFER_MAX_DEVICES ?? String(DEFAULT_MAX_DEVICES)),
  };
}

const NO_STORE = { 'cache-control': 'no-store' };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** 405 for a method the route does not serve, before anything builds a Request from it (TRACE would throw). */
function serves(req: IncomingMessage, res: ServerResponse, methods: readonly string[]): boolean {
  if (methods.includes(req.method ?? '')) return true;
  sendJson(res, 405, { error: 'method_not_allowed', message: `Use ${methods.join(' or ')}.` }, { allow: methods.join(', ') });
  return false;
}

/** The phone answers any 401 by registering again: the key is unknown, or the relay pruned its device. */
function refuseDevice(res: ServerResponse): void {
  sendJson(
    res,
    401,
    { error: 'unknown_device', message: 'This relay does not know this device key. Register again with POST /v1/device/register.' },
    { ...NO_STORE, 'www-authenticate': 'Bearer realm="puffer", error="invalid_token"' },
  );
}

/** One holder at a time, in arrival order. `enter` resolves with the function that lets the next one in. */
class Turnstile {
  private busy = false;
  private readonly queue: (() => void)[] = [];

  enter(): Promise<() => void> {
    const leave = () => {
      const next = this.queue.shift();
      if (next) next();
      else this.busy = false;
    };
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(leave);
    }
    return new Promise((admitted) => this.queue.push(() => admitted(leave)));
  }
}

/** Writes a web Response, from the SDK's auth helpers or from oauth.ts. */
async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** A body that has not arrived within `deadlineMs` drops the connection: a trickled body must not hold a slot. */
async function readBody(req: IncomingMessage, maxBytes: number, deadlineMs = TIMEOUTS.requestMs): Promise<string> {
  const timer = setTimeout(() => req.destroy(new HttpError(408, 'timeout', 'The body took too long to arrive.')), deadlineMs);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    // Leaving the loop must not destroy the request: the socket still has to carry the 413.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maxBytes) throw new HttpError(413, 'body_too_large', `The body is larger than ${maxBytes} bytes.`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(req: IncomingMessage, maxBytes: number, deadlineMs?: number): Promise<unknown> {
  const text = await readBody(req, maxBytes, deadlineMs);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_request', 'The body is not JSON.');
  }
}

/**
 * Content-free on purpose: no question, agent or status. `target` is built from validated ids and secrets only, so it
 * needs no escaping.
 */
function sendOpenPage(res: ServerResponse, status: number, target: string | null): void {
  const body = target
    ? `<meta http-equiv="refresh" content="0; url=${target}"><title>Open Puffer</title></head>` +
      `<body><p><a href="${target}">Open Puffer</a></p><p>Open this link on the iPhone that has Puffer.</p>`
    : '<title>Puffer</title></head><body><p>This link has expired. Start connecting again from the app or agent.</p>';
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      `<meta name="viewport" content="width=device-width, initial-scale=1">${body}</body></html>`,
  );
}

async function main(): Promise<void> {
  const { host, trustFlyClientIp, port, statePath, publicUrl, waitMs, devCallbacks, notifyDebounceMs, offlineAfterMs, connectTtlMs, maxDevices } =
    config(process.argv.slice(2), process.env);
  let base = publicUrl ?? '';
  const tenants = Tenants.open({
    path: statePath,
    mailbox: { ...DEFAULT_MAILBOX_OPTIONS, offlineAfterMs },
    notifier: { debounceMs: notifyDebounceMs, allowLoopback: devCallbacks },
    openUrl: (id) => `${base}/open/${id}`,
  });
  const largeSyncs = new Turnstile();
  const registrations = new RateLimit<string>(REGISTRATIONS.perCaller, REGISTRATIONS.windowMs);
  const oauth = new AuthServer({
    issuer: () => base,
    clientsPath: join(dirname(statePath), 'oauth-clients.json'),
    sessionsPath: join(dirname(statePath), 'oauth-sessions.json'),
    sessionKeyPath: join(dirname(statePath), 'oauth-session-key.json'),
    connectTtlMs,
    allowLoopback: devCallbacks,
    knowsKey: (tenant, digest) => tenants.knowsKey(tenant, digest),
  });

  type McpCaller = { tenant: Tenant; agentId: AgentId };
  const mcp = toNodeHandler(
    createMcpHandler(
      ({ authInfo }) => {
        const caller = authInfo?.extra?.caller as McpCaller | undefined;
        if (!caller) throw new Error('MCP request reached the handler without an authenticated agent');
        const { tenant, agentId } = caller;
        return createAgentServer(agentId, { operations: tenant.operations, notifier: tenant.notifier, waitMs });
      },
      // The relay publishes nothing on subscriptions/listen; each open stream would only hold a request slot.
      { maxSubscriptions: 16 },
    ),
  );
  /** The agent an ak_ key or an OAuth access token names and its tenant, unless no phone registered it or the relay revoked it. */
  const agentOf = (authorization: string | undefined) => tenants.agent(oauth.claim(authorization));
  const unknownAgent = () =>
    bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'unknown, expired or revoked agent key or access token'), {
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauth.metadata().resourceServerUrl),
    });
  const agentApi = {
    waitMs,
    authenticate: (authorization: string | undefined) => {
      const found = agentOf(authorization);
      return found ? { agentId: found.agent.id, operations: found.tenant.operations } : null;
    },
    challenge: () => unknownAgent().headers.get('www-authenticate') ?? 'Bearer',
    readJson: (req: IncomingMessage, maxBytes: number) => readJson(req, maxBytes, TIMEOUTS.smallBodyMs),
  };
  const callerOf = (req: IncomingMessage) => {
    const forwarded = trustFlyClientIp ? req.headers['fly-client-ip'] : undefined;
    return callerKey(typeof forwarded === 'string' && isIP(forwarded) ? forwarded : (req.socket.remoteAddress ?? 'unknown'));
  };
  // The SDK's localhost guards would refuse a hosted relay's own hostname.
  const allowedHosts = [...localhostAllowedHostnames(), ...(publicUrl ? [new URL(publicUrl).hostname] : [])];
  /** DNS-rebinding guard: the Host, and the Origin a browser adds, must name this relay. Null when both pass. */
  const foreignCaller = (req: IncomingMessage) => {
    const host = validateHostHeader(req.headers.host, allowedHosts);
    if (!host.ok) return host;
    const origin = validateOriginHeader(req.headers.origin, allowedHosts);
    return origin.ok ? null : origin;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname: path } = url;

    if (path === '/healthz') {
      if (!serves(req, res, READ)) return;
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/openapi.json') {
      if (!serves(req, res, READ)) return;
      return sendJson(res, 200, openApiDocument(`${base}/v1`));
    }

    // No auth: the page names nothing but the app, and looks up nothing, so it reveals no other tenant's request.
    const open = /^\/open\/([^/]*)$/.exec(path);
    if (open) {
      if (!serves(req, res, READ)) return;
      if (!RequestId.safeParse(open[1]).success) return sendJson(res, 404, { error: 'not_found', message: 'No such request.' });
      return sendOpenPage(res, 200, 'puffer://agents');
    }

    if (path === '/start') {
      if (!serves(req, res, READ)) return;
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(startDocument(base));
    }

    // No auth: the secret is 192 random bits, and only the user's messages carry it.
    const approve = /^\/c\/([A-Za-z0-9_-]{32})$/.exec(path);
    if (approve?.[1]) {
      if (!serves(req, res, READ)) return;
      const id = oauth.linkTarget(approve[1]);
      return sendOpenPage(res, id ? 200 : 404, id ? `puffer://connect/${id}?link=${approve[1]}` : null);
    }

    // DNS-rebinding guards for the authenticated routes. The routes above them reveal nothing, and a platform
    // health check may arrive with an internal Host.
    const foreign = foreignCaller(req);
    if (foreign) {
      // MCP clients expect a JSON-RPC error; every other route answers {error, message}.
      const body = path === '/mcp' ? { jsonrpc: '2.0', error: { code: -32000, message: foreign.message }, id: null } : { error: foreign.errorCode, message: foreign.message };
      return sendJson(res, 403, body, NO_STORE);
    }

    if (path === '/mcp') {
      if (!serves(req, res, ['POST', 'GET', 'DELETE'])) return;
      const found = agentOf(req.headers.authorization);
      if (!found) return sendResponse(res, unknownAgent());
      const caller: McpCaller = { tenant: found.tenant, agentId: found.agent.id };
      return mcp(Object.assign(req, { auth: { token: '', clientId: found.agent.id, scopes: [], extra: { caller } } }), res);
    }
    if (await serveAgentApi(req, res, url, agentApi)) return;

    if (path === '/v1/connect') {
      if (!serves(req, res, WRITE)) return;
      return sendResponse(res, oauth.linkConnect(await readBody(req, MAX_CONNECT_BODY_BYTES, TIMEOUTS.smallBodyMs), callerOf(req)));
    }
    const collecting = /^\/v1\/connect\/([^/]*)\/token$/.exec(path);
    if (collecting) {
      if (!serves(req, res, WRITE)) return;
      const body = await readBody(req, MAX_CONFIRM_BODY_BYTES, TIMEOUTS.smallBodyMs);
      const left = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) left.abort();
      });
      return sendResponse(res, await oauth.linkToken(collecting[1] ?? '', req.headers.authorization, body, waitMs, left.signal));
    }

    if (path.startsWith('/.well-known/')) {
      if (!serves(req, res, DISCOVERY)) return;
      const metadata = oauth.metadata();
      // Clients that ignore the 401's resource_metadata fall back to the root document; it is the same one.
      const served =
        path === '/.well-known/oauth-protected-resource'
          ? new URL(getOAuthProtectedResourceMetadataUrl(metadata.resourceServerUrl)).pathname
          : path;
      const requestedHeaders = req.headers['access-control-request-headers'];
      const request = new Request(new URL(served, base), {
        method: req.method,
        headers: requestedHeaders ? { 'access-control-request-headers': requestedHeaders } : {},
      });
      const document = oauthMetadataResponse(request, metadata);
      if (document) return sendResponse(res, document);
    }

    if (path === '/register') {
      if (!serves(req, res, WRITE)) return;
      return sendResponse(res, oauth.register(await readBody(req, MAX_OAUTH_BODY_BYTES, TIMEOUTS.smallBodyMs), callerOf(req)));
    }
    if (path === '/authorize') {
      if (!serves(req, res, GET)) return;
      return sendResponse(res, await oauth.authorize(url.searchParams, callerOf(req)));
    }
    const poll = /^\/authorize\/poll\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (poll?.[1]) {
      if (!serves(req, res, GET)) return;
      return sendResponse(res, oauth.poll(poll[1]));
    }
    if (path === '/token') {
      if (!serves(req, res, WRITE)) return;
      return sendResponse(res, oauth.token(req.headers['content-type'], await readBody(req, MAX_OAUTH_BODY_BYTES, TIMEOUTS.smallBodyMs)));
    }

    if (path === '/v1/device/register') {
      if (!serves(req, res, WRITE)) return;
      await readBody(req, MAX_CONFIRM_BODY_BYTES, TIMEOUTS.smallBodyMs);
      if (!registrations.take(callerOf(req))) {
        return sendJson(res, 429, { error: 'rate_limited', message: 'Too many devices registered from your network. Try again in an hour.' }, {
          ...NO_STORE,
          'retry-after': String(REGISTRATIONS.windowMs / 1000),
        });
      }
      if (tenants.activeCount() >= maxDevices) {
        return sendJson(res, 503, { error: 'capacity', message: 'This relay holds as many devices as it can. Try again later.' }, NO_STORE);
      }
      const { id, deviceKey } = tenants.register();
      return sendJson(res, 200, { v: PROTOCOL_VERSION, deviceId: id, deviceKey }, NO_STORE);
    }

    const byLink = /^\/v1\/device\/connects\/by-link\/([^/]*)$/.exec(path);
    if (byLink) {
      if (!serves(req, res, READ)) return;
      const tenant = tenants.device(req.headers.authorization);
      if (!tenant) return refuseDevice(res);
      const connect = /^[A-Za-z0-9_-]{32}$/.test(byLink[1] ?? '') ? oauth.byLink(tenant.id, byLink[1] ?? '') : null;
      if (!connect) return sendJson(res, 404, { error: 'not_found', message: 'No connection is waiting for this link.' }, NO_STORE);
      return sendJson(res, 200, { v: PROTOCOL_VERSION, connect }, NO_STORE);
    }

    const confirming = /^\/v1\/device\/connects\/([^/]*)\/confirm$/.exec(path);
    if (confirming) {
      if (!serves(req, res, WRITE)) return;
      const tenant = tenants.device(req.headers.authorization);
      if (!tenant) return refuseDevice(res);
      const body = ConfirmBody.safeParse(await readJson(req, MAX_CONFIRM_BODY_BYTES, TIMEOUTS.smallBodyMs));
      if (!body.success) return sendJson(res, 400, { error: 'the body must be {"v":1,"link":"<the link secret>"}' });
      const id = ConnectId.safeParse(confirming[1]);
      return sendJson(res, 200, id.success ? oauth.confirm(tenant.id, id.data, body.data.link) : { status: 'gone' }, NO_STORE);
    }

    if (path === '/v1/device/sync') {
      if (!serves(req, res, WRITE)) return;
      const tenant = tenants.device(req.headers.authorization);
      if (!tenant) return refuseDevice(res);
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_SYNC_BODY_BYTES) throw new HttpError(413, 'body_too_large', `The body is larger than ${MAX_SYNC_BODY_BYTES} bytes.`);
      const leave = declared <= LARGE_SYNC_BODY_BYTES ? null : await largeSyncs.enter();
      let parsed: ReturnType<typeof parseSyncBody>;
      try {
        parsed = parseSyncBody(await readJson(req, MAX_SYNC_BODY_BYTES, TIMEOUTS.syncBodyMs));
      } finally {
        leave?.();
      }
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      tenants.synced(tenant);
      const { mailbox, notifier } = tenant;
      if (parsed.body.registry) {
        const applied = tenants.applyRegistry(tenant, parsed.body.registry);
        mailbox.revoke(applied.removed);
        notifier.revoke(applied.removed);
        if (applied.accepted) {
          notifier.setWebhooks(applied.agents);
          tenant.registryAccepted = true;
        }
      }
      const known = ({ agentId }: { agentId: AgentId }) => tenant.record.registry.agents.some((agent) => agent.id === agentId);
      if (parsed.body.changeHeads) notifier.recordHeads(parsed.body.changeHeads.filter(known));
      if (parsed.body.changePages) mailbox.replacePages(parsed.body.changePages.filter(known));
      if (parsed.body.connectDeclines) oauth.decline(tenant.id, parsed.body.connectDeclines);
      oauth.approve();
      const disconnected = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) disconnected.abort();
      });
      // The first sync after a restart is answered at once, so the phone re-sends the webhook settings within one
      // round trip instead of after its long-poll; a change in that window would otherwise only set the baseline.
      const askNow = !tenant.registryAccepted && !tenant.registryAsked;
      tenant.registryAsked ||= askNow;
      const reply = await mailbox.sync(askNow ? { ...parsed.body, waitMs: 0 } : parsed.body, disconnected.signal);
      const body: SyncResponse = {
        v: PROTOCOL_VERSION,
        ...reply,
        registryRevision: tenant.record.registry.revision,
        wantsRegistry: !tenant.registryAccepted,
        revokedKeys: oauth.revokedKeys(tenant.id),
      };
      return sendJson(res, 200, body, NO_STORE);
    }

    sendJson(res, 404, { error: 'not_found', message: 'No such path.' }, NO_STORE);
  }

  const hsts = publicUrl?.startsWith('https:') ?? false;
  const server = createServer(
    { headersTimeout: TIMEOUTS.headersMs, requestTimeout: TIMEOUTS.syncBodyMs, connectionsCheckingInterval: TIMEOUTS.checkEveryMs },
    (req, res) => {
      if (hsts) res.setHeader('strict-transport-security', 'max-age=31536000');
      route(req, res).catch((error: unknown) => {
        if (res.headersSent || !req.socket || req.socket.destroyed) return void res.destroy();
        // The rest of an oversized body is still unread, so the connection is not reused.
        if (error instanceof HttpError) {
          return sendJson(res, error.status, { error: error.code, message: error.message }, { ...NO_STORE, connection: 'close' });
        }
        console.error(error);
        sendJson(res, 500, { error: 'internal_error', message: 'The relay could not handle this request.' });
      });
    },
  );
  setInterval(() => {
    tenants.sweep();
    oauth.sweep();
  }, SWEEP_EVERY_MS).unref();

  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(port, host, ready);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('relay is not listening on a TCP port');
  base = publicUrl ?? `http://localhost:${address.port}`;
  try {
    buildOAuthProtectedResourceMetadata(oauth.metadata());
  } catch (error) {
    throw new Error(`OAuth needs an https public URL (plain http only on localhost), got ${base}: ${String(error)}`);
  }
  console.log(`${tenants.count} device(s) registered. Phones register themselves at POST /v1/device/register.`);
  console.log(`Puffer relay on ${base} (listening on ${host}:${address.port}, MCP at /mcp, wait budget ${waitMs} ms)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
