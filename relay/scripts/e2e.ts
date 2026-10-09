// `npm run e2e`. Starts the real relay as a child process, plays the phone over the real sync protocol
// and the agent over MCP with the official client SDK, and prints one PASS/FAIL line per assertion.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

import { addressAllowed } from '../src/egress';

const RELAY_DIR = resolve(import.meta.dirname, '..');
const WAIT_MS = 1_500;
const OFFLINE_AFTER_MS = 1_500;
const DEBOUNCE_MS = 200;
const CONNECT_TTL_MS = 4_000;
const FORBIDDEN = ['vec', 'vector', 'embedding', 'sourceUri', 'photo:'];
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
const TOOLS = [
  'append_to_note',
  'ask_puffer',
  'create_note',
  'delete_note',
  'get_note',
  'get_puffer_answer',
  'get_puffer_changes',
  'list_note_folders',
  'list_notes',
  'list_puffer_recent',
  'list_puffer_sources',
  'search_notes',
  'update_note',
];

const handed = { id: z.string(), agentId: z.string(), askedAt: z.string(), expiresAt: z.string() };
const SyncReply = z.strictObject({
  v: z.literal(1),
  requests: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        ...handed,
        kind: z.literal('ask'),
        question: z.string(),
        filters: z.record(z.string(), z.string()).optional(),
        sort: z.literal('recent').optional(),
        limit: z.number().optional(),
        includeDocuments: z.string().optional(),
      }),
      z.strictObject({
        ...handed,
        kind: z.literal('recent'),
        limit: z.number(),
        filters: z.record(z.string(), z.string()).optional(),
        includeDocuments: z.string().optional(),
      }),
      z.strictObject({ ...handed, kind: z.literal('changes'), since: z.string().nullable(), limit: z.number() }),
      z.strictObject({ ...handed, kind: z.literal('sources') }),
      z.strictObject({ ...handed, kind: z.literal('getNote'), noteId: z.string() }),
    ]),
  ),
  acked: z.array(z.strictObject({ id: z.string(), kind: z.string() })),
  registryRevision: z.number(),
  readCursors: z.array(z.strictObject({ agentId: z.string(), cursor: z.string() })),
  wantsRegistry: z.boolean(),
  revokedKeys: z.array(z.string()),
});
type SyncReply = z.infer<typeof SyncReply>;
const askId = (reply: SyncReply, question: string) =>
  reply.requests.find((r) => r.kind === 'ask' && r.question === question)?.id;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      got: ${JSON.stringify(detail)}`}`);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const digest = (key: string) => `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
const agentKey = () => `ak_${randomBytes(32).toString('base64url')}`;

const agents = {
  A: { id: 'ag_claude', name: 'Claude Code', key: agentKey() },
  B: { id: 'ag_poke', name: 'Poke', key: agentKey() },
  C: { id: 'ag_chatgpt', name: 'ChatGPT', key: agentKey() },
  D: { id: 'ag_reader', name: 'Reader', key: agentKey() },
};
const wireAgent = (agent: { id: string; name: string; key: string }) => ({ id: agent.id, name: agent.name, keyDigest: digest(agent.key) });

type Relay = { base: string; pid: number; log: string; stop: () => Promise<void> };

async function startRelay(statePath: string, env: Record<string, string> = {}, args: string[] = [], devCallbacks = true): Promise<Relay> {
  const child = spawn(
    process.execPath,
    [
      ...['--import', 'tsx', 'src/server.ts', '--port', '0', '--state', statePath, '--wait-ms', String(WAIT_MS)],
      ...[...(devCallbacks ? ['--dev-callbacks'] : []), '--notify-debounce-ms', String(DEBOUNCE_MS), '--offline-after-ms', String(OFFLINE_AFTER_MS)],
      ...args,
    ],
    { cwd: RELAY_DIR, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } },
  );
  let out = '';
  const base = await new Promise<string>((ready, fail) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const port = /Puffer relay on \S+ \(listening on \S+:(\d+),/.exec(out)?.[1];
      if (port) ready(`http://localhost:${port}`);
    });
    child.once('exit', (code) => fail(new Error(`relay exited with ${code}\n${out}`)));
  });
  return {
    base,
    pid: child.pid ?? 0,
    log: out,
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
      }),
  };
}

async function post(base: string, path: string, authorization: string | null, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(new URL(path, base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : text };
}

/** The relay's resident set in KB, as ps reports it. */
const rssKb = (pid: number) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());

/** POST /v1/device/register, as a phone does at its first start. */
async function registerDevice(base: string) {
  const res = await fetch(new URL('/v1/device/register', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"v":1}' });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, any> };
}

/** The connection a connect page or approve page opens in Puffer: puffer://connect/<id>?link=<secret>. */
const pageLink = (html: string) => {
  const found = /puffer:\/\/connect\/(cn_[\w-]+)\?link=([\w-]{32})/.exec(html);
  return { id: found?.[1] ?? '', secret: found?.[2] ?? '' };
};
/** What Puffer, opened through an approve link, fetches for its approval screen. */
const byLink = async (base: string, deviceKey: string, secret: string) => {
  const res = await fetch(new URL(`/v1/device/connects/by-link/${secret}`, base), { headers: { authorization: `Bearer ${deviceKey}` } });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const confirmLink = async (base: string, deviceKey: string | null, connectId: string, secret: string) =>
  post(base, `/v1/device/connects/${connectId}/confirm`, deviceKey, { v: 1, link: secret });

const mcpStatus = async (base: string, key: string | null) =>
  (await post(base, '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status;

/** fetch refuses some methods (TRACE), so those go through node:http. */
const statusWithMethod = (base: string, path: string, method: string) =>
  new Promise<number>((done, fail) => {
    const req = httpRequest(new URL(path, base), { method }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on('error', fail);
    req.end();
  });

/** fetch will not send a Host header of our choosing, so the guard check goes through node:http. */
const statusWithHost = (base: string, host: string, path = '/mcp') =>
  new Promise<number>((done, fail) => {
    const req = httpRequest(new URL(path, base), { method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        guardBodies.push(body);
        done(res.statusCode ?? 0);
      });
    });
    req.on('error', fail);
    req.end('{}');
  });
const guardBodies: string[] = [];

const PHONE_KINDS = ['ask', 'recent', 'changes', 'sources', 'getNote'];

/**
 * The fake phone. Like Swift's Codable, it omits `registry`, `changeHeads`, `changePages` and `connectDeclines` instead of
 * sending null. It reads the library kinds unless `requestKinds` is null, which plays a phone that names none.
 */
function phone(base: string, deviceKey: string) {
  return async (
    body: {
      waitMs?: number;
      outbox?: unknown[];
      registry?: unknown;
      changeHeads?: unknown;
      changePages?: unknown;
      connectDeclines?: unknown;
      requestKinds?: string[] | null;
    } = {},
  ): Promise<SyncReply> => {
    const { status, json } = await post(base, '/v1/device/sync', deviceKey, {
      v: 1,
      waitMs: body.waitMs ?? 0,
      outbox: body.outbox ?? [],
      ...(body.requestKinds === null ? {} : { requestKinds: body.requestKinds ?? PHONE_KINDS }),
      ...(body.registry ? { registry: body.registry } : {}),
      ...(body.changeHeads ? { changeHeads: body.changeHeads } : {}),
      ...(body.changePages ? { changePages: body.changePages } : {}),
      ...(body.connectDeclines ? { connectDeclines: body.connectDeclines } : {}),
    });
    if (status !== 200) throw new Error(`sync answered ${status}: ${JSON.stringify(json)}`);
    return SyncReply.parse(json);
  };
}

/** A loopback webhook receiver. /mute never echoes the challenge; /gone answers events 410; script() queues statuses. */
type Hit = { path: string; headers: IncomingHttpHeaders; raw: string; body: Record<string, any> };
async function startReceiver() {
  const hits: Hit[] = [];
  const scripted = new Map<string, number[]>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const hit: Hit = { path: req.url ?? '', headers: req.headers, raw, body: JSON.parse(raw) };
    hits.push(hit);
    if (hit.body.type === 'verification') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(hit.path.endsWith('/mute') ? '{}' : JSON.stringify({ challenge: hit.body.challenge }));
    }
    res.writeHead(scripted.get(hit.path)?.shift() ?? (hit.path.endsWith('/gone') ? 410 : 200));
    res.end();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return {
    url: (name: string) => `http://localhost:${port}/hooks/${name}`,
    events: (name: string) => hits.filter((hit) => hit.path === `/hooks/${name}` && hit.body.type !== 'verification'),
    verifications: (name: string) => hits.filter((hit) => hit.path === `/hooks/${name}` && hit.body.type === 'verification'),
    script: (name: string, statuses: number[]) => scripted.set(`/hooks/${name}`, statuses),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Counts TCP connections and answers none: proof that the relay never connected. */
async function startListener() {
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return { port, connections: () => connections, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/**
 * Answers every request with a body nobody should read: /gzip a 256 MB gzip bomb whatever the request asked for,
 * anything else an identity body of 64 MB.
 */
async function startBomb() {
  const bomb = gzipSync(Buffer.alloc(256 * 1024 * 1024, 0x61), { level: 9 });
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const hits: { path: string; acceptEncoding: string }[] = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url ?? '', acceptEncoding: String(req.headers['accept-encoding']) });
    req.resume();
    if (req.url?.endsWith('/gzip')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': bomb.length });
      return void res.end(bomb);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    let sent = 0;
    const pump = () => {
      while (!res.destroyed && sent < 1024 && res.write(chunk)) sent++;
      if (res.destroyed || sent >= 1024) return void res.end();
      res.once('drain', pump);
    };
    pump();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return {
    url: (name: string) => `http://127.0.0.1:${port}/bomb/${name}`,
    hits,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const header = (hit: Hit | undefined, name: string) => String(hit?.headers[name] ?? '');
const webhookSecret = () => `whsec_${randomBytes(32).toString('base64')}`;
/** Standard Webhooks: v1 is base64 HMAC-SHA256, keyed with the secret's bytes, over "<id>.<timestamp>.<body>". */
const signedBy = (hit: Hit | undefined, secret: string) =>
  hit !== undefined &&
  header(hit, 'webhook-signature') ===
    `v1,${createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
      .update(`${header(hit, 'webhook-id')}.${header(hit, 'webhook-timestamp')}.${hit.raw}`)
      .digest('base64')}`;

type EventsReply = { ok: true; result: Record<string, any> } | { ok: false; code: number; data: Record<string, any> };
async function mcpEvents(client: Client, method: string, params: Record<string, unknown>): Promise<EventsReply> {
  try {
    return { ok: true, result: await client.request({ method, params }, z.looseObject({})) };
  } catch (error) {
    const { code, data } = error as { code: number; data?: Record<string, any> };
    return { ok: false, code, data: data ?? {} };
  }
}
const failure = (reply: EventsReply) => (reply.ok ? null : { code: reply.code, ...reply.data });
const subscription = (url: string, secret: string, extra: Record<string, unknown> = {}) => ({
  name: 'puffer.changes',
  arguments: {},
  delivery: { mode: 'webhook', url, secret },
  ...extra,
});

const results: CallToolResult[] = [];

async function connectAgent(base: string, key: string, mode?: 'auto'): Promise<Client> {
  const client = new Client({ name: 'puffer-e2e', version: '1.0.0' }, mode ? { versionNegotiation: { mode } } : {});
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  return client;
}

async function call(
  client: Client,
  name: 'ask_puffer' | 'get_puffer_answer' | 'get_puffer_changes' | 'list_puffer_recent' | 'list_puffer_sources',
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args });
  results.push(result);
  return result;
}

/** Every 200 body of the HTTP API, for the leak scan and the check that each key is documented. */
const httpBodies: Record<string, any>[] = [];

/** A call to the agent HTTP API. A body makes it a POST unless `method` says otherwise; `raw` is sent as is. */
async function api(base: string, path: string, key: string | null, init: { method?: string; body?: unknown; raw?: string } = {}) {
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  const res = await fetch(new URL(path, base), {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (res.status === 200 && path.startsWith('/v1/')) httpBodies.push(json);
  return { status: res.status, headers: res.headers, json };
}

/** Paths in `value` that the JSON Schema subset openapi.json uses (type, properties, items) does not allow. */
function offSchema(value: unknown, schema: Record<string, any>, path = ''): string[] {
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const allowed = [schema.type].flat().filter(Boolean);
  if (allowed.length && !allowed.includes(kind) && !(kind === 'integer' && allowed.includes('number'))) return [`${path || '.'}: ${kind}`];
  if (kind === 'array') return (value as unknown[]).flatMap((item, i) => offSchema(item, schema.items ?? {}, `${path}[${i}]`));
  if (kind !== 'object' || !schema.properties) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    schema.properties[key] ? offSchema(item, schema.properties[key], `${path}.${key}`) : [`${path}.${key}: undocumented`],
  );
}

const field = (result: CallToolResult, key: string): unknown =>
  Object.entries(result.structuredContent ?? {}).find(([name]) => name === key)?.[1];
const textOf = (result: CallToolResult) => result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');

/** An MCP client's OAuth state, in memory. It records the authorization URL instead of opening a browser. */
class MemoryOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  info: StoredOAuthClientInformation | undefined;
  verifier = '';
  private saved: StoredOAuthTokens | undefined;
  private discovery: OAuthDiscoveryState | undefined;

  constructor(
    readonly redirectUrl: string,
    readonly clientMetadata: OAuthClientMetadata,
  ) {}

  state() {
    return 'st-approve';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
}

const getJson = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const postForm = (url: string, params: Record<string, string>) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
/** The query of the redirect a poll answered with; empty when there is none. */
const redirectQuery = (reply: { json: Record<string, any> }) =>
  typeof reply.json.redirect === 'string' && URL.canParse(reply.json.redirect) ? new URL(reply.json.redirect).searchParams : new URLSearchParams();
const pollPath = (html: string) => /\/authorize\/poll\/[\w-]+/.exec(html)?.[0] ?? '/authorize/poll/missing';
/** Where a refused /authorize sends the browser, with the parameters the client reads. */
const backTo = (res: Response) => {
  const location = res.headers.get('location');
  const url = location ? new URL(location) : null;
  const param = (name: string) => url?.searchParams.get(name) ?? null;
  return { status: res.status, to: url && `${url.origin}${url.pathname}`, error: param('error'), state: param('state'), iss: param('iss') };
};

/** A loopback server for client ID metadata documents. */
async function startDocuments() {
  const documents = new Map<string, unknown>();
  const server = createServer((req, res) => {
    const document = documents.get(req.url ?? '');
    res.writeHead(document ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(document ?? {}));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    serve: (path: string, document: unknown) => documents.set(path, document),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * OAuth against a fresh relay: discovery, registration, the phone approving, declining or letting a connection expire,
 * the token at /mcp, revocation and a restart. Returns every secret the flow saw, for the state-file check.
 */
async function oauthChecks(restart: (env: Record<string, string>) => Promise<Relay>, deviceKey: string): Promise<string[]> {
  let { base } = await restart({ PUFFER_TRUST_PROXY: 'fly' });
  const sync = phone(base, deviceKey);
  const phoneAgents = [wireAgent(agents.A), wireAgent(agents.B), wireAgent(agents.C)];
  await sync({ registry: { revision: 3, agents: phoneAgents } });
  const resource = `${base}/mcp`;
  const secrets: string[] = [];

  const unauthorized = await fetch(resource, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const challenge = unauthorized.headers.get('www-authenticate') ?? '';
  const pathAware = await getJson(`${base}/.well-known/oauth-protected-resource/mcp`);
  const root = await getJson(`${base}/.well-known/oauth-protected-resource`);
  const server = await getJson(`${base}/.well-known/oauth-authorization-server`);
  const oidc = await fetch(`${base}/.well-known/openid-configuration`);
  check(
    'discovery: the /mcp 401 names the path-aware resource metadata, served there and at the root; the AS metadata offers S256, public clients, CIMD and iss; no openid-configuration',
    unauthorized.status === 401 &&
      challenge.startsWith('Bearer ') &&
      challenge.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`) &&
      isDeepStrictEqual(pathAware.json, { resource, authorization_servers: [base], resource_name: 'Puffer' }) &&
      isDeepStrictEqual(root.json, pathAware.json) &&
      isDeepStrictEqual(server.json, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      }) &&
      oidc.status === 404,
    { challenge, pathAware: pathAware.json, root: root.json, server: server.json, oidc: oidc.status },
  );

  const callbackUri = 'https://notes.example/oauth/callback';
  const registration = await post(base, '/register', null, {
    client_name: 'Notes\u202e\u2028\u3000  helper',
    redirect_uris: [callbackUri],
    token_endpoint_auth_method: 'client_secret_basic',
    grant_types: ['authorization_code', 'refresh_token'],
  });
  const dcr = registration.json as Record<string, any>;
  const plainHttp = await post(base, '/register', null, { redirect_uris: ['http://notes.example/callback'] });
  const fragment = await post(base, '/register', null, { redirect_uris: ['https://notes.example/callback#top'] });
  check(
    'DCR: a public client registers with 201 and auth method none whatever it asked for, its name stripped of bidi controls and line separators with whitespace runs collapsed; non-loopback http or a fragment is 400 invalid_redirect_uri',
    registration.status === 201 &&
      /^cl_[\w-]{22}$/.test(dcr.client_id) &&
      dcr.token_endpoint_auth_method === 'none' &&
      dcr.client_name === 'Notes helper' &&
      typeof dcr.client_id_issued_at === 'number' &&
      isDeepStrictEqual([dcr.redirect_uris, dcr.grant_types, dcr.response_types], [[callbackUri], ['authorization_code', 'refresh_token'], ['code']]) &&
      [plainHttp, fragment].every((refused) => refused.status === 400 && (refused.json as Record<string, unknown>).error === 'invalid_redirect_uri'),
    { registration, plainHttp, fragment },
  );
  const notesId = String(dcr.client_id);

  const request = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      client_id: notesId,
      redirect_uri: callbackUri,
      response_type: 'code',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource,
      ...extra,
    });
  /** `caller` sets Fly-Client-IP, which this relay trusts (PUFFER_TRUST_PROXY=fly); without it the socket address counts. */
  const authorize = (params: URLSearchParams, caller?: string) =>
    fetch(`${base}/authorize?${params}`, { redirect: 'manual', headers: caller ? { 'fly-client-ip': caller } : {} });
  const unknownClient = await authorize(request({ client_id: `cl_${randomBytes(16).toString('base64url')}` }));
  const otherRedirect = await authorize(request({ redirect_uri: 'https://notes.example/elsewhere' }));
  const refusedPages = [await unknownClient.text(), await otherRedirect.text()];
  check(
    'authorize: an unknown client or an unregistered redirect_uri gets a 400 page and no redirect',
    [unknownClient, otherRedirect].every((res) => res.status === 400 && !res.headers.has('location')) &&
      refusedPages.every((html) => html.includes('not registered')),
    { statuses: [unknownClient.status, otherRedirect.status], refusedPages },
  );

  const evil = (await post(base, '/register', null, { client_name: 'La\u0301\u0301\u0301\u0301nding\u2029page', redirect_uris: ['https://evil.example/landing'] }))
    .json as Record<string, any>;
  const noPkce = request({ state: 'st-1' });
  noPkce.delete('code_challenge');
  noPkce.delete('code_challenge_method');
  const refused = [
    await authorize(noPkce, '192.0.2.10'),
    await authorize(request({ code_challenge_method: 'plain', state: 'st-2' }), '192.0.2.10'),
    await authorize(request({ resource: 'https://other.example/mcp', state: 'st-3' }), '192.0.2.10'),
    await authorize(request({ client_id: String(evil.client_id), redirect_uri: 'https://evil.example/landing', response_type: 'x' }), '192.0.2.10'),
  ];
  const refusalPages = await Promise.all(refused.map(async (res) => ({ ...backTo(res), html: await res.text() })));
  check(
    'authorize: missing PKCE, plain PKCE, a foreign resource and a self-registered client with a bad response_type get a 400 page, never a redirect (no open redirect); a name loses paragraph separators and keeps at most 2 combining marks in a row',
    evil.client_name === 'La\u0301\u0301ndingpage' &&
      refusalPages.every((page) => page.status === 400 && page.to === null && page.html.includes('Puffer cannot connect this app')) &&
      ['S256 is required', 'S256 is required', 'resource must be', 'response_type=code'].every((why, i) => refusalPages[i]?.html.includes(why)),
    refusalPages,
  );

  const deskCallback = 'http://127.0.0.1:47613/callback';
  const desk = new MemoryOAuthProvider(deskCallback, {
    client_name: 'Desk <script>alert(1)</script> helper',
    redirect_uris: [deskCallback],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  const tokenReplies: { status: number; headers: Headers; body: Record<string, unknown> }[] = [];
  const recording = async (url: string | URL, init?: RequestInit) => {
    const res = await fetch(url, init);
    if (new URL(url).pathname === '/token') tokenReplies.push({ status: res.status, headers: res.headers, body: await res.clone().json() });
    return res;
  };
  const deskTransport = () => new StreamableHTTPClientTransport(new URL(resource), { authProvider: desk, fetch: recording });
  const firstTry = await new Client({ name: 'desk', version: '1.0.0' }).connect(deskTransport()).then(
    () => null,
    (error: unknown) => error,
  );
  const authorizationUrl = desk.authorizationUrl;

  const page = await fetch(authorizationUrl ?? `${base}/authorize`);
  const pageHtml = await page.text();
  const deskLink = pageLink(pageHtml);
  const opened = await byLink(base, deviceKey, deskLink.secret);
  const connect = opened.json.connect as Record<string, any> | undefined;
  check(
    'the SDK client discovers the relay, registers by DCR and builds an S256 authorization URL; Puffer, opened through the page\'s link, fetches the connection by its secret, without the key',
    firstTry instanceof UnauthorizedError &&
      authorizationUrl?.searchParams.get('code_challenge_method') === 'S256' &&
      authorizationUrl.searchParams.get('resource') === resource &&
      opened.status === 200 &&
      connect?.id === deskLink.id &&
      connect.clientName === 'Desk <script>alert(1)</script> helper' &&
      connect.origin === 'oauth' &&
      connect.clientHost === null &&
      connect.redirectHost === '127.0.0.1' &&
      /^sha256:[0-9a-f]{64}$/.test(connect.keyDigest) &&
      /^cn_[\w-]{16}$/.test(connect.id) &&
      Date.parse(connect.expiresAt) - Date.parse(connect.requestedAt) === CONNECT_TTL_MS &&
      !JSON.stringify(opened.json).includes('ak_'),
    { firstTry: String(firstTry), authorizationUrl: authorizationUrl?.href, opened },
  );

  const pollUrl = `${base}${pollPath(pageHtml)}`;
  const csp = page.headers.get('content-security-policy') ?? '';
  const waiting = await getJson(pollUrl);
  check(
    'the connect page (no-store, strict CSP) shows the approve link as a QR code and an Open in Puffer link with its secret, the escaped client name and where it returns; its poll says waiting',
    page.status === 200 &&
      page.headers.get('cache-control') === 'no-store' &&
      page.headers.get('referrer-policy') === 'no-referrer' &&
      ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'"].every((rule) => csp.includes(rule)) &&
      !csp.includes('unsafe') &&
      pageHtml.includes('<svg') &&
      pageHtml.includes(`href="puffer://connect/${deskLink.id}?link=${deskLink.secret}"`) &&
      pageHtml.includes('alert(1)') &&
      !pageHtml.includes('<script>alert') &&
      pageHtml.includes('Returns to 127.0.0.1') &&
      isDeepStrictEqual(waiting, { status: 200, json: { status: 'waiting' } }),
    { csp, pageHtml, waiting },
  );

  const deskAgent = { id: 'ag_desk', name: 'Desk helper', keyDigest: connect?.keyDigest };
  await sync({ registry: { revision: 4, agents: [...phoneAgents, deskAgent] } });
  const registryOnly = await getJson(pollUrl);
  const unauthenticated = await confirmLink(base, null, deskLink.id, deskLink.secret);
  const confirmed = await confirmLink(base, deviceKey, deskLink.id, deskLink.secret);
  const reconfirmed = await confirmLink(base, deviceKey, deskLink.id, deskLink.secret);
  check(
    'a digest in the registry without a confirmed link approves nothing; confirm needs the device key; the link secret confirms, again on a retry',
    registryOnly.json.status === 'waiting' &&
      unauthenticated.status === 401 &&
      isDeepStrictEqual(confirmed, { status: 200, json: { status: 'confirmed' } }) &&
      isDeepStrictEqual(reconfirmed, confirmed),
    { registryOnly: registryOnly.json, unauthenticated: unauthenticated.status, confirmed, reconfirmed },
  );
  const approved = await getJson(pollUrl);
  const again = await getJson(pollUrl);
  const callback = new URL(String(approved.json.redirect));
  const code = callback.searchParams.get('code') ?? '';
  check(
    'once the link is confirmed and the phone pushes an agent with that digest, the poll answers approved with a redirect carrying code, state and iss, and repeats it',
    approved.json.status === 'approved' &&
      `${callback.origin}${callback.pathname}` === deskCallback &&
      /^[\w-]{43}$/.test(code) &&
      callback.searchParams.get('state') === 'st-approve' &&
      callback.searchParams.get('iss') === base &&
      isDeepStrictEqual(again, approved),
    { approved: approved.json, again: again.json },
  );

  const exchange = (verifier: string) =>
    postForm(`${base}/token`, {
      grant_type: 'authorization_code',
      code,
      client_id: String(desk.info?.client_id),
      redirect_uri: deskCallback,
      code_verifier: verifier,
      resource,
    });
  const wrong = await exchange(pkce().verifier);
  const wrongBody = await wrong.json();
  await deskTransport().finishAuth(callback.searchParams);
  const [issued] = tokenReplies;
  const accessToken = String(issued?.body.access_token ?? '');
  const accessClaims = JSON.parse(Buffer.from(accessToken.slice(3).split('.')[0] ?? '', 'base64url').toString() || '{}');
  check(
    'token: a wrong code_verifier is invalid_grant and leaves the code usable; the SDK then gets a signed at_ access token naming that digest for an hour, an rt_ refresh token, no-store',
    wrong.status === 400 &&
      wrongBody.error === 'invalid_grant' &&
      issued?.status === 200 &&
      accessToken.startsWith('at_') &&
      accessClaims.ag === connect?.keyDigest &&
      issued.body.expires_in === 3600 &&
      /^rt_[\w-]{64}$/.test(String(issued.body.refresh_token)) &&
      isDeepStrictEqual(Object.keys(issued.body).sort(), ['access_token', 'expires_in', 'refresh_token', 'token_type']) &&
      issued.body.token_type === 'Bearer' &&
      issued.headers.get('cache-control') === 'no-store' &&
      issued.headers.get('pragma') === 'no-cache',
    { wrong: wrongBody, issued: issued && { status: issued.status, keys: Object.keys(issued.body) } },
  );

  const deskClient = new Client({ name: 'desk', version: '1.0.0' });
  await deskClient.connect(deskTransport());
  const question = 'Where is the spare bike key?';
  const asking = call(deskClient, 'ask_puffer', { question });
  const handedAsk = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'ask' && r.question === question);
  await sync({
    outbox: [{ id: handedAsk?.id, kind: 'answered', items: [{ title: 'Hallway notes', kind: 'passage', text: 'Spare bike key: top drawer by the door.' }] }],
  });
  const answered = await asking;
  const reading = call(deskClient, 'get_puffer_changes', {});
  const handedChanges = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'changes');
  await sync({ outbox: [{ id: handedChanges?.id, kind: 'answered', changes: { events: [], nextCursor: '4', hiddenCount: 0 } }] });
  const read = await reading;
  check(
    "an SDK client holding the OAuth token calls ask_puffer and get_puffer_changes as agent ag_desk and gets the phone's answers",
    handedAsk?.agentId === 'ag_desk' &&
      field(answered, 'status') === 'answered' &&
      textOf(answered).includes('top drawer') &&
      handedChanges?.agentId === 'ag_desk' &&
      field(read, 'status') === 'answered' &&
      field(read, 'next_cursor') === '4',
    { answered: answered.structuredContent, read: read.structuredContent },
  );

  await deskClient.close();
  const refreshWith = (refreshToken: unknown, clientId = String(desk.info?.client_id)) =>
    postForm(`${base}/token`, { grant_type: 'refresh_token', refresh_token: String(refreshToken), client_id: clientId, resource });
  const rotated = await (await refreshWith(issued?.body.refresh_token)).json();
  const retried = await (await refreshWith(issued?.body.refresh_token)).json();
  const otherClient = await (await refreshWith(rotated.refresh_token, notesId)).json();
  const rotatedWorks = await mcpStatus(base, String(rotated.access_token));
  check(
    'refresh: the refresh token rotates to a new one with a fresh access token; repeating the old one at once returns the same new one; another client_id is invalid_grant',
    /^rt_[\w-]{64}$/.test(String(rotated.refresh_token)) && rotated.refresh_token !== issued?.body.refresh_token &&
      retried.refresh_token === rotated.refresh_token && otherClient.error === 'invalid_grant' && rotatedWorks !== 401,
    { rotated: Object.keys(rotated), retried: Object.keys(retried), otherClient, rotatedWorks },
  );
  const replay = await exchange(desk.verifier);
  const replayBody = await replay.json();
  const refusedAtOnce = await mcpStatus(base, accessToken);
  const refreshRefused = await (await refreshWith(rotated.refresh_token)).json();
  const toldPhone = await sync();
  const removedOnPhone = await sync({ registry: { revision: 5, agents: phoneAgents } });
  check(
    'a redeemed code presented again is invalid_grant and revokes its session: /mcp answers 401 before the phone syncs, the refresh token is invalid_grant, every sync lists the digest in revokedKeys until the phone removes the agent',
    replay.status === 400 && replayBody.error === 'invalid_grant' && refusedAtOnce === 401 && refreshRefused.error === 'invalid_grant' &&
      isDeepStrictEqual(toldPhone.revokedKeys, [connect?.keyDigest]) && isDeepStrictEqual(removedOnPhone.revokedKeys, []),
    { replay: replayBody, refusedAtOnce, toldPhone: toldPhone.revokedKeys, removedOnPhone: removedOnPhone.revokedKeys },
  );

  const declining = await fetch(`${base}/authorize?${request({ state: 'st-decline' })}`);
  const decliningHtml = await declining.text();
  const declinePoll = `${base}${pollPath(decliningHtml)}`;
  const toDecline = pageLink(decliningHtml);
  const shown = await byLink(base, deviceKey, toDecline.secret);
  await sync({ connectDeclines: [toDecline.id] });
  const goneAfterDecline = await byLink(base, deviceKey, toDecline.secret);
  const declined = await getJson(declinePoll);
  const declinedTo = redirectQuery(declined);
  check(
    'a declined connection polls declined with access_denied, the state and iss, and its link no longer opens it',
    declining.status === 200 &&
      shown.json.connect?.clientName === 'Notes helper' &&
      declined.json.status === 'declined' &&
      declinedTo.get('error') === 'access_denied' &&
      declinedTo.get('state') === 'st-decline' &&
      declinedTo.get('iss') === base &&
      goneAfterDecline.status === 404,
    { declined: declined.json, shown, goneAfterDecline },
  );

  const guessing = await fetch(`${base}/authorize?${request({ state: 'st-guess' })}`);
  const guessingHtml = await guessing.text();
  const toGuess = pageLink(guessingHtml);
  const guesses = [];
  for (const secret of ['A'.repeat(32), 'short', 'B'.repeat(32), toGuess.secret]) guesses.push((await confirmLink(base, deviceKey, toGuess.id, secret)).json);
  const guessedOut = await getJson(`${base}${pollPath(guessingHtml)}`);
  const unknownConnect = (await confirmLink(base, deviceKey, 'cn_nonexistent_0000000', toGuess.secret)).json;
  check(
    'a wrong link secret leaves 2 then 1 tries (a malformed one counts), the 3rd declines the connection with access_denied, and the right secret after that or an unknown id is gone',
    isDeepStrictEqual(guesses, [
      { status: 'wrongCode', attemptsLeft: 2 },
      { status: 'wrongCode', attemptsLeft: 1 },
      { status: 'declined' },
      { status: 'gone' },
    ]) &&
      guessedOut.json.status === 'declined' &&
      redirectQuery(guessedOut).get('error') === 'access_denied' &&
      redirectQuery(guessedOut).get('state') === 'st-guess' &&
      isDeepStrictEqual(unknownConnect, { status: 'gone' }) &&
      (await byLink(base, deviceKey, toGuess.secret)).status === 404,
    { guesses, guessedOut: guessedOut.json, unknownConnect },
  );

  const expiring = await fetch(`${base}/authorize?${request({ state: 'st-expire' })}`);
  const expiringHtml = await expiring.text();
  const expiringPoll = `${base}${pollPath(expiringHtml)}`;
  const unusedHtml = await (await authorize(request({ state: 'st-unused' }))).text();
  const lateConfirmedHtml = await (await authorize(request({ state: 'st-late' }))).text();
  const [toExpire, unused, lateConfirmed] = await Promise.all(
    [expiringHtml, unusedHtml, lateConfirmedHtml].map(async (html) => {
      const { id, secret } = pageLink(html);
      return { id, secret, keyDigest: String((await byLink(base, deviceKey, secret)).json.connect?.keyDigest) };
    }),
  );
  await confirmLink(base, deviceKey, unused?.id ?? '', unused?.secret ?? '');
  await confirmLink(base, deviceKey, lateConfirmed?.id ?? '', lateConfirmed?.secret ?? '');
  const unusedAgent = { id: 'ag_unused', name: 'Unused helper', keyDigest: unused?.keyDigest };
  await sync({ registry: { revision: 6, agents: [...phoneAgents, unusedAgent] } });
  await sleep(CONNECT_TTL_MS + 300);
  const expired = await getJson(expiringPoll);
  const lateAgent = { id: 'ag_late', name: 'Late helper', keyDigest: toExpire?.keyDigest };
  const lateConfirmedAgent = { id: 'ag_late_confirmed', name: 'Late confirmed helper', keyDigest: lateConfirmed?.keyDigest };
  const late = await sync({ registry: { revision: 7, agents: [...phoneAgents, unusedAgent, lateAgent, lateConfirmedAgent] } });
  const stillExpired = await getJson(expiringPoll);
  const unusedPoll = await getJson(`${base}${pollPath(unusedHtml)}`);
  const expiredTo = redirectQuery(expired);
  check(
    'past --connect-ttl-ms a connection polls expired with access_denied, its link no longer opens it, and a late registry with its digest does not approve it',
    toExpire !== undefined &&
      expired.json.status === 'expired' &&
      expiredTo.get('error') === 'access_denied' &&
      /expired/.test(expiredTo.get('error_description') ?? '') &&
      expiredTo.get('state') === 'st-expire' &&
      (await byLink(base, deviceKey, toExpire.secret)).status === 404 &&
      stillExpired.json.status === 'expired',
    { expired: expired.json, stillExpired: stillExpired.json },
  );
  const cleared = await sync({ registry: { revision: 8, agents: phoneAgents } });
  check(
    'an approved connection never redeemed, and a confirmed one the phone added after its deadline, end abandoned (the page reads expired) and are listed in revokedKeys until removed; an unconfirmed digest is not',
    unusedPoll.json.status === 'expired' &&
      isDeepStrictEqual([...late.revokedKeys].sort(), [unused?.keyDigest, lateConfirmed?.keyDigest].sort()) &&
      !late.revokedKeys.includes(toExpire?.keyDigest ?? '') &&
      isDeepStrictEqual(cleared.revokedKeys, []),
    { unusedPoll: unusedPoll.json, revoked: late.revokedKeys, cleared: cleared.revokedKeys },
  );
  secrets.push(accessToken, code, desk.verifier, deskLink.secret, toDecline.secret, toGuess.secret, toExpire?.secret ?? '');
  secrets.push(String(issued?.body.refresh_token), String(rotated.refresh_token));
  secrets.push(...[pollUrl, declinePoll, expiringPoll].map((url) => url.split('/').at(-1) ?? ''));

  const capped = async (caller: string) => (await authorize(request(), caller)).status;
  const first = [await capped('203.0.113.7'), await capped('203.0.113.7'), await capped('203.0.113.7')];
  const fourth = await authorize(request(), '203.0.113.7');
  const fourthHtml = await fourth.text();
  const neighbour = await capped('198.51.100.9');
  const sameSlash64 = [await capped('2001:db8:1:2::1'), await capped('2001:db8:1:2::2'), await capped('2001:db8:1:2:0:0:0:3'), await capped('2001:db8:1:2:ffff::9')];
  const otherSlash64 = await capped('2001:db8:1:3::1');
  check(
    'a caller (Fly-Client-IP, an IPv6 /64 counting as one) gets at most 3 connections waiting for the phone; the 4th is a 429 page, and other callers are unaffected',
    isDeepStrictEqual(first, [200, 200, 200]) &&
      fourth.status === 429 &&
      !fourth.headers.has('location') &&
      fourthHtml.includes('waiting for Puffer') &&
      neighbour === 200 &&
      isDeepStrictEqual(sameSlash64, [200, 200, 200, 429]) &&
      otherSlash64 === 200,
    { first, fourth: fourth.status, neighbour, sameSlash64, otherSlash64 },
  );

  const documents = await startDocuments();
  try {
    const documentUrl = `${documents.origin}/client.json`;
    const webUrl = `${documents.origin}/web.json`;
    const registered = 'http://127.0.0.1:47614/callback';
    const webCallback = 'https://clipper.example/callback';
    documents.serve('/client.json', { client_id: documentUrl, client_name: 'Clipboard assistant', redirect_uris: [registered], token_endpoint_auth_method: 'none' });
    documents.serve('/web.json', { client_id: webUrl, client_name: 'Web clipper', redirect_uris: [webCallback] });
    documents.serve('/mismatch.json', { client_id: `${documents.origin}/someone-else.json`, client_name: 'Mismatch', redirect_uris: [registered] });
    const cimd = await authorize(request({ client_id: documentUrl, redirect_uri: 'http://127.0.0.1:51234/callback', state: 'st-cimd' }));
    const cimdHtml = await cimd.text();
    const web = await authorize(request({ client_id: webUrl, redirect_uri: webCallback, state: 'st-web' }));
    const webHtml = await web.text();
    const cimdConnect = (await byLink(base, deviceKey, pageLink(cimdHtml).secret)).json.connect;
    const webConnect = (await byLink(base, deviceKey, pageLink(webHtml).secret)).json.connect;
    const mismatch = await authorize(request({ client_id: `${documents.origin}/mismatch.json`, redirect_uri: registered }));
    const mismatchHtml = await mismatch.text();
    check(
      'CIMD: a metadata document client_id gets the page (a loopback redirect on another port still matches); the phone sees its host only when the redirect is not loopback; a document naming another client_id is a 400 page',
      cimd.status === 200 &&
        cimdHtml.includes('Clipboard assistant') &&
        cimdConnect?.origin === 'oauth' &&
        cimdConnect.clientHost === null &&
        cimdConnect.redirectHost === '127.0.0.1' &&
        web.status === 200 &&
        webConnect?.origin === 'oauth' &&
        webConnect.clientHost === '127.0.0.1' &&
        webConnect.redirectHost === 'clipper.example' &&
        mismatch.status === 400 &&
        !mismatch.headers.has('location') &&
        mismatchHtml.includes('different client_id'),
      { cimd: cimd.status, cimdConnect, webConnect, mismatch: mismatch.status, mismatchHtml },
    );
    secrets.push(pageLink(cimdHtml).secret, pageLink(webHtml).secret, ...[cimdHtml, webHtml].map((html) => pollPath(html).split('/').at(-1) ?? ''));
  } finally {
    await documents.close();
  }

  ({ base } = await restart({}));
  const afterRestart = request();
  afterRestart.delete('resource');
  const persisted = await fetch(`${base}/authorize?${afterRestart}`);
  check(
    'a dynamically registered client survives a relay restart: /authorize still shows its page',
    persisted.status === 200 && (await persisted.text()).includes('Notes helper'),
    persisted.status,
  );
  const spoofed = [];
  for (const caller of ['203.0.113.21', '203.0.113.22', '203.0.113.23']) spoofed.push((await authorize(afterRestart, caller)).status);
  check(
    'without PUFFER_TRUST_PROXY a forged Fly-Client-IP is ignored: every request counts against the socket address',
    isDeepStrictEqual(spoofed, [200, 200, 429]),
    spoofed,
  );
  return secrets.filter((secret) => secret.length >= 6);
}

/** This phone's tenant as registry.json holds it. */
function tenantOnDisk(statePath: string, deviceKey: string): { revision: number; agents: { id: string; name: string; keyDigest: string }[] } & Record<string, any> {
  const { tenants } = JSON.parse(readFileSync(statePath, 'utf8')) as { tenants: Record<string, any>[] };
  const tenant = tenants.find((t) => t.deviceKeyDigest === digest(deviceKey));
  if (!tenant) throw new Error('registry.json has no tenant for this device key');
  return tenant as { revision: number; agents: { id: string; name: string; keyDigest: string }[] };
}

/**
 * Connect by message: an agent without OAuth asks at POST /v1/connect and sends the user approve_url; Puffer, opened
 * through it, presents the link secret at confirm; the agent's token poll gets the key once.
 */
async function linkChecks(base: string, deviceKey: string, statePath: string): Promise<void> {
  const sync = phone(base, deviceKey);
  const registry = tenantOnDisk(statePath, deviceKey);
  await sync({ registry: { revision: registry.revision, agents: registry.agents } });
  const error = (reply: { json: unknown }) => (reply.json as Record<string, unknown>).error;

  const start = await fetch(`${base}/start`);
  const startText = await start.text();
  const tooLong = await post(base, '/v1/connect', null, { name: 'x'.repeat(61) });
  const blank = await post(base, '/v1/connect', null, { name: ' \u202e\u2028 ' });
  const asked = await post(base, '/v1/connect', null, { name: '  Notes\u202e\u2028  Agent ' });
  const grant = asked.json as Record<string, string | number>;
  check(
    'GET /start is Markdown naming this relay\'s connect, token and API URLs with no secret; POST /v1/connect cleans the name like a client name, refuses an empty or 61-character one, and answers connect_id, approve_url, poll_token, expires_in, interval',
    start.status === 200 &&
      start.headers.get('content-type') === 'text/markdown; charset=utf-8' &&
      [`POST ${base}/v1/connect`, `${base}/v1/connect/<connect_id>/token`, `POST ${base}/v1/ask`, `${base}/openapi.json`, 'include_documents', 'next_cursor', `${base}/v1/notes/search`].every((part) => startText.includes(part)) &&
      !/include_images|waiting_for_user|photo/.test(startText) &&
      !startText.includes(deviceKey) &&
      !/(ak|dk)_[\w-]{8}/.test(startText) &&
      [tooLong, blank].every((refused) => refused.status === 400 && error(refused) === 'invalid_request') &&
      asked.status === 200 &&
      isDeepStrictEqual(Object.keys(grant).sort(), ['approve_url', 'connect_id', 'expires_in', 'interval', 'poll_token']) &&
      String(grant.approve_url).startsWith(`${base}/c/`) &&
      /^[\w-]{32}$/.test(String(grant.approve_url).slice(`${base}/c/`.length)) &&
      grant.expires_in === 600 &&
      grant.interval === 5,
    { start: start.status, startHead: startText.slice(0, 80), tooLong, blank, asked },
  );

  const secret = String(grant.approve_url).slice(`${base}/c/`.length);
  const tokenPath = `/v1/connect/${grant.connect_id}/token`;
  const listed = (await byLink(base, deviceKey, secret)).json.connect as Record<string, any> | undefined;
  const page = await fetch(String(grant.approve_url));
  const pageHtml = await page.text();
  const unknownPage = await fetch(`${base}/c/${'A'.repeat(32)}`);
  const noAuth = await post(base, tokenPath, null, {});
  const wrongPoll = await post(base, tokenPath, 'not-the-poll-token', {});
  const pending = await post(base, tokenPath, String(grant.poll_token), {});
  const tooSoon = await post(base, tokenPath, String(grant.poll_token), {});
  check(
    "Puffer opened through the link fetches it as origin link with the cleaned name, no redirect and no key; /c/<secret> is a no-store, no-referrer page that opens puffer://connect/<id>?link=<secret>, an unknown secret 404s; the token poll needs its own token, then says authorization_pending, then slow_down",
    listed?.id === grant.connect_id &&
      listed?.origin === 'link' &&
      listed.clientName === 'Notes Agent' &&
      !('redirectHost' in listed) &&
      !JSON.stringify(listed).includes('ak_') &&
      page.status === 200 &&
      page.headers.get('cache-control') === 'no-store' &&
      page.headers.get('referrer-policy') === 'no-referrer' &&
      pageHtml.includes(`url=puffer://connect/${grant.connect_id}?link=${secret}`) &&
      !pageHtml.includes('Notes') &&
      unknownPage.status === 404 &&
      noAuth.status === 401 &&
      error(wrongPoll) === 'expired_token' &&
      error(pending) === 'authorization_pending' &&
      error(tooSoon) === 'slow_down',
    { listed, pageHtml, unknownPage: unknownPage.status, noAuth, wrongPoll, pending, tooSoon },
  );

  const wrongSecret = await confirmLink(base, deviceKey, String(grant.connect_id), 'C'.repeat(32));
  const confirmed = await post(base, `/v1/device/connects/${grant.connect_id}/confirm`, deviceKey, { v: 1, link: secret });
  await sleep(WAIT_MS);
  const waiting = post(base, tokenPath, String(grant.poll_token), { wait: 25 }).then((reply) => ({ reply, at: Date.now() }));
  await sleep(300);
  const approvedAt = Date.now();
  await sync({ registry: { revision: registry.revision + 1, agents: [...registry.agents, { id: 'ag_notes', name: 'Notes Agent', keyDigest: listed?.keyDigest }] } });
  const { reply: delivered, at: deliveredAt } = await waiting;
  const issued = delivered.json as Record<string, string>;
  const works = await api(base, '/v1/answers/rq_unknown0000?wait=0', issued.key ?? null);
  const twice = await post(base, tokenPath, String(grant.poll_token), {});
  const twiceKey = (twice.json as Record<string, string>).key;
  const other = (await post(base, '/v1/connect', null, { name: 'Second Agent' })).json as Record<string, string>;
  await sync({ connectDeclines: [other.connect_id] });
  const declined = await post(base, `/v1/connect/${other.connect_id}/token`, other.poll_token ?? null, {});
  check(
    'a wrong secret leaves 2 tries and the link secret confirms; a waiting token poll returns the key within 1 s of the registry gaining its digest, with base_url and openapi_url; the key works on /v1; a second poll within a minute (a lost reply) gets the same key; a declined link connection polls access_denied',
    isDeepStrictEqual(wrongSecret.json, { status: 'wrongCode', attemptsLeft: 2 }) &&
      isDeepStrictEqual(confirmed.json, { status: 'confirmed' }) &&
      delivered.status === 200 &&
      digest(issued.key ?? '') === listed?.keyDigest &&
      deliveredAt - approvedAt < 1_000 &&
      issued.base_url === `${base}/v1` &&
      issued.openapi_url === `${base}/openapi.json` &&
      works.status === 200 &&
      works.json.status === 'expired' &&
      twice.status === 200 &&
      twiceKey === issued.key &&
      error(declined) === 'access_denied',
    { wrongSecret, confirmed, delivered: delivered.status, deliveredAfterMs: deliveredAt - approvedAt, works, twice: twice.status, declined },
  );
}

/**
 * A relay without --dev-callbacks, the production policy: no callback, webhook or metadata document fetch may reach a
 * loopback or private address, whatever the URL says, and the error says nothing about why.
 */
async function addressChecks(statePath: string): Promise<void> {
  const notPublic = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fc00::1', 'fdaa::3', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', 'not-an-ip'];
  const isPublic = ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'];
  check(
    'the address policy refuses loopback, private, link-local, CGNAT, unique-local (fdaa::/16), multicast, unspecified and their IPv4-mapped forms, and allows public ones; --dev-callbacks adds loopback only',
    notPublic.every((address) => !addressAllowed(address, false)) && isPublic.every((address) => addressAllowed(address, false)) &&
      addressAllowed('127.0.0.1', true) && addressAllowed('::1', true) && !addressAllowed('10.1.2.3', true) && !addressAllowed('fdaa::3', true),
    { allowed: notPublic.filter((address) => addressAllowed(address, false)), refused: isPublic.filter((address) => !addressAllowed(address, false)) },
  );

  const relay = await startRelay(statePath, {}, [], false);
  const listener = await startListener();
  try {
    const deviceKey = String((await registerDevice(relay.base)).json.deviceKey);
    const sync = phone(relay.base, deviceKey);
    const target = (host: string, path: string) => `https://${host}:${listener.port}/${path}`;
    await sync({ registry: { revision: 1, agents: [{ ...wireAgent(agents.A), notify: { url: target('127.0.0.1', 'webhook') } }] } });
    const a = await connectAgent(relay.base, agents.A.key);
    const refused = [];
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) refused.push(failure(await mcpEvents(a, 'events/subscribe', subscription(target(host, 'hook'), webhookSecret()))));
    await sync({ changeHeads: [{ agentId: agents.A.id, seq: 1 }] });
    await sync({ changeHeads: [{ agentId: agents.A.id, seq: 2 }] });
    await sleep(DEBOUNCE_MS + 400);
    const clientId = target('127.0.0.1', 'client.json');
    const page = await fetch(`${relay.base}/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: 'https://app.example/cb', response_type: 'code' })}`);
    const pageHtml = await page.text();
    await a.close();
    check(
      'without --dev-callbacks a subscription, the phone-set webhook and a metadata document on loopback never connect; the agent sees the one generic reason, the page a generic error',
      refused.every((reason) => isDeepStrictEqual(reason, { code: -32015, reason: 'challenge_failed' })) &&
        page.status === 400 && pageHtml.includes('could not be fetched') && !/HTTP \d|refused|blocked/i.test(pageHtml) &&
        listener.connections() === 0,
      { refused, page: page.status, pageHtml, connections: listener.connections() },
    );
  } finally {
    await listener.close();
    await relay.stop();
  }
}

/** A sync with Content-Length `bytes` whose body never comes: the relay must answer from the header alone. */
function declaredSync(base: string, deviceKey: string, bytes: number): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      new URL('/v1/device/sync', base),
      { method: 'POST', headers: { authorization: `Bearer ${deviceKey}`, 'content-type': 'application/json', 'content-length': String(bytes) } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          done({ status: res.statusCode ?? 0, body });
          req.destroy();
        });
      },
    );
    req.on('error', fail);
    req.write('{');
  });
}

/**
 * Memory on the small VM: a sync body over 24 MB is refused from its Content-Length, large bodies are read one at a time
 * and all get through, and a tenant keeps at most 32 MiB of settled answer text and files.
 */
async function memoryChecks(base: string, deviceKey: string): Promise<void> {
  const sync = phone(base, deviceKey);
  const rawSync = async (body: string) => {
    const res = await fetch(new URL('/v1/device/sync', base), {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceKey}`, 'content-type': 'application/json' },
      body,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const padded = (bytes: number) => JSON.stringify({ v: 1, waitMs: 0, outbox: [], requestKinds: PHONE_KINDS, padding: 'x'.repeat(bytes) });
  const MB = 1024 * 1024;
  const tooLarge = await declaredSync(base, deviceKey, 25 * MB);
  const together = await Promise.all([rawSync(padded(5 * MB)), rawSync(`{${'x'.repeat(5 * MB)}`), rawSync(padded(6 * MB))]);
  const afterwards = await rawSync(padded(5 * MB));
  check(
    'a sync declaring more than 24 MB is 413 body_too_large before its body arrives; three 5 to 6 MB syncs sent at once, one malformed, are read in turn (200, 400, 200) and the next large one still gets through',
    tooLarge.status === 413 && JSON.parse(tooLarge.body || '{}').error === 'body_too_large' &&
      isDeepStrictEqual(together.map((reply) => reply.status), [200, 400, 200]) && afterwards.status === 200,
    { tooLarge, together: together.map((reply) => reply.status), afterwards: afterwards.status },
  );

  const ask = async (question: string) =>
    String((await api(base, '/v1/ask', agents.A.key, { body: { question, include_documents: 'file', wait: 0 } })).json.request_id);
  const firstId = await ask('first scanned contract');
  const secondId = await ask('second scanned contract');
  const handed = (await sync()).requests.map((r) => r.id);
  const file = (name: string, fill: string) => ({
    title: name,
    text: 'Signed on page 4.',
    document: { kind: 'file', name, mimeType: 'application/pdf', data: Buffer.alloc(12.5 * MB, fill).toString('base64') },
  });
  await sync({ outbox: [{ id: firstId, kind: 'answered', items: [file('first.pdf', 'a')] }] });
  await sync({ outbox: [{ id: secondId, kind: 'answered', items: [file('second.pdf', 'b')] }] });
  const collect = (id: string) => api(base, `/v1/answers/${id}?include_documents=file&wait=0`, agents.A.key);
  const [first, second] = [await collect(firstId), await collect(secondId)];
  const kept = second.json.items?.[0]?.document?.file?.data as string | undefined;
  check(
    'a tenant keeps at most 32 MiB of settled answers: of two 16.7 MB file answers the first to settle is dropped (its id reads expired) and the second is collected whole',
    handed.includes(firstId) && handed.includes(secondId) &&
      first.json.status === 'expired' && second.json.status === 'answered' && kept === Buffer.alloc(12.5 * MB, 'b').toString('base64'),
    { first: first.json.status, second: second.json.status, keptLength: kept?.length },
  );
}

/**
 * get_note with a body the phone cut at 200,000 characters, and a sync whose outbox holds one malformed outcome and one
 * row without a request id (an old local ledger row), which must not fail the sync.
 */
async function noteChecks(base: string, deviceKey: string): Promise<void> {
  const sync = phone(base, deviceKey);
  const handedNote = async (noteId: string) => {
    for (let tries = 0; tries < 5; tries++) {
      const found = (await sync({ waitMs: 1_000 })).requests.find((r) => r.kind === 'getNote' && r.noteId === noteId);
      if (found) return found.id;
    }
    return undefined;
  };
  const reading = api(base, '/v1/notes/n_long_log?wait=5', agents.A.key);
  const longId = await handedNote('n_long_log');
  const meta = { title: 'Long log', folder: 'Notes', created: '2026-10-01T09:00:00Z', modified: '2026-10-09T09:00:00Z', version: 7, pinned: false };
  await sync({ outbox: [{ id: longId, kind: 'answered', approvedBy: 'grant', note: { id: 'n_long_log', ...meta, body: 'x'.repeat(200_000), truncated: true } }] });
  const read = await reading;
  const broken = api(base, '/v1/notes/n_other?wait=5', agents.A.key);
  const brokenId = await handedNote('n_other');
  const tolerated = await sync({ outbox: [{ id: brokenId, kind: 'answered', note: { id: 'n_other' } }, { id: 'dev_local_row', kind: 'nothingFound' }] });
  const brokenRead = await broken;
  check(
    'get_note passes a body the phone cut as truncated and warns against update_note with it; a sync with one malformed outcome and one row without a request id is 200: the first settles as expired and is acked, the second is dropped',
    read.json.status === 'answered' && read.json.note?.truncated === true && read.json.note?.body?.length === 200_000 &&
      /Do not pass it to update_note/.test(String(read.json.message)) &&
      isDeepStrictEqual(tolerated.acked, [{ id: brokenId, kind: 'expired' }]) && brokenRead.json.status === 'expired',
    { note: { ...read.json.note, body: read.json.note?.body?.length }, acked: tolerated.acked, broken: brokenRead.json.status },
  );
}

/**
 * Two phones on one relay. Tenant B's phone and agent see nothing of tenant A: not its request ids, its connection's
 * link secret or connect id, nor its OAuth tokens, and B naming A's agent key in its registry changes nothing. Then a
 * restart with a bad entry in oauth-sessions.json: the relay starts, and a refresh retried across the restart within the
 * grace minute gets the same token instead of revoking the session.
 */
async function isolationChecks(restart: () => Promise<Relay>, firstBase: string, deviceKey: string, statePath: string): Promise<void> {
  let base = firstBase;
  const syncA = phone(base, deviceKey);
  const tenantA = tenantOnDisk(statePath, deviceKey);
  let revisionA = tenantA.revision;
  const agentsA = tenantA.agents;
  const deviceKeyB = String((await registerDevice(base)).json.deviceKey);
  const syncB = phone(base, deviceKeyB);
  const other = { id: 'ag_other_phone', name: 'Other phone agent', key: agentKey() };
  const seenByB: unknown[] = [];
  const asB = <T>(reply: T): T => {
    seenByB.push(reply);
    return reply;
  };

  asB(await syncB({ registry: { revision: 1, agents: [wireAgent(other), { id: 'ag_stolen', name: 'Stolen', keyDigest: digest(agents.A.key) }] } }));
  const asked = await api(base, '/v1/ask', agents.A.key, { body: { question: 'tenant A private question', wait: 0 } });
  const requestId = String(asked.json.request_id);
  const bSync = asB(await syncB());
  const aSync = await syncA();
  await syncA({ outbox: [{ id: requestId, kind: 'nothingFound' }] });
  // B's agent probes with A's request id, so these replies echo it; they are checked by status, not scanned.
  const otherHttp = await api(base, `/v1/answers/${requestId}?wait=0`, other.key);
  const otherClient = await connectAgent(base, other.key);
  const otherMcp = await call(otherClient, 'get_puffer_answer', { request_id: requestId });
  await otherClient.close();

  const link = (await post(base, '/v1/connect', null, { name: 'Isolation agent' })).json as Record<string, string>;
  const linkSecret = String(link.approve_url).split('/c/')[1] ?? '';
  const linkDigest = String((await byLink(base, deviceKey, linkSecret)).json.connect?.keyDigest);
  await confirmLink(base, deviceKey, String(link.connect_id), linkSecret);
  const bByLink = asB(await byLink(base, deviceKeyB, linkSecret));
  const bConfirm = asB(await confirmLink(base, deviceKeyB, String(link.connect_id), linkSecret));
  asB(await syncB({ connectDeclines: [link.connect_id] }));
  revisionA += 1;
  await syncA({ registry: { revision: revisionA, agents: [...agentsA, { id: 'ag_isolation', name: 'Isolation agent', keyDigest: linkDigest }] } });
  const collected = await post(base, `/v1/connect/${link.connect_id}/token`, link.poll_token ?? null, {});

  const callbackUri = 'https://isolation.example/callback';
  const client = (await post(base, '/register', null, { client_name: 'Isolation client', redirect_uris: [callbackUri] })).json as Record<string, string>;
  const clientId = String(client.client_id);
  const { verifier, challenge } = pkce();
  const authorizeQuery = { client_id: clientId, redirect_uri: callbackUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st-iso' };
  const authorizeHtml = await (await fetch(`${base}/authorize?${new URLSearchParams(authorizeQuery)}`)).text();
  const oauthLink = pageLink(authorizeHtml);
  const oauthDigest = String((await byLink(base, deviceKey, oauthLink.secret)).json.connect?.keyDigest);
  await confirmLink(base, deviceKey, oauthLink.id, oauthLink.secret);
  revisionA += 1;
  await syncA({
    registry: {
      revision: revisionA,
      agents: [...agentsA, { id: 'ag_isolation', name: 'Isolation agent', keyDigest: linkDigest }, { id: 'ag_iso_oauth', name: 'Isolation client', keyDigest: oauthDigest }],
    },
  });
  const code = new URL(String((await getJson(`${base}${pollPath(authorizeHtml)}`)).json.redirect)).searchParams.get('code') ?? '';
  const tokens = (await (await postForm(`${base}/token`, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callbackUri, code_verifier: verifier })).json()) as Record<string, string>;
  const refresh = async (token: string) =>
    (await (await postForm(`${base}/token`, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId })).json()) as Record<string, string>;
  const rotated = await refresh(String(tokens.refresh_token));
  const oauthAsk = api(base, '/v1/ask', String(rotated.access_token), { body: { question: 'tenant A oauth question', wait: 0 } });
  const oauthId = String((await oauthAsk).json.request_id);
  const bLater = asB(await syncB());
  const aLater = await syncA();
  await syncA({ outbox: [{ id: oauthId, kind: 'nothingFound' }] });

  const secretsOfA = [requestId, linkSecret, String(link.connect_id), String(link.poll_token), oauthLink.secret, oauthLink.id, oauthId,
    String(tokens.refresh_token), String(rotated.refresh_token), String(tokens.access_token), String(rotated.access_token)];
  const seen = JSON.stringify(seenByB);
  check(
    "tenant B's phone and agent see none of tenant A's request ids, link secrets, connect ids, poll token or OAuth tokens: B's syncs carry no A request, B's agent reads A's request id as expired, A's link secret 404s for B and confirms as gone, B declining A's connect id is ignored, and B naming A's agent key in its registry leaves that key on A",
    asked.status === 200 && /^rq_/.test(requestId) &&
      aSync.requests.some((r) => r.id === requestId) && !bSync.requests.some((r) => r.id === requestId) &&
      otherHttp.json.status === 'expired' && field(otherMcp, 'status') === 'expired' &&
      bByLink.status === 404 && isDeepStrictEqual(bConfirm.json, { status: 'gone' }) &&
      collected.status === 200 && digest(String((collected.json as Record<string, string>).key)) === linkDigest &&
      /^rt_/.test(String(rotated.refresh_token)) && aLater.requests.some((r) => r.id === oauthId) && !bLater.requests.some((r) => r.id === oauthId) &&
      secretsOfA.every((secret) => secret.length >= 8 && !seen.includes(secret)),
    { requestId, aSync: aSync.requests.map((r) => r.id), bSync: bSync.requests.map((r) => r.id), otherHttp: otherHttp.json, bByLink, bConfirm: bConfirm.json, collected: collected.status, leaked: secretsOfA.filter((secret) => seen.includes(secret)) },
  );

  const sessionsPath = join(dirname(statePath), 'oauth-sessions.json');
  const rotatedAgain = await refresh(String(rotated.refresh_token));
  const stored = JSON.parse(readFileSync(sessionsPath, 'utf8')) as { sessions: unknown[] };
  writeFileSync(sessionsPath, JSON.stringify({ sessions: [...stored.sessions, { id: 'not-a-session', state: { kind: 'active' } }] }), { mode: 0o600 });
  ({ base } = await restart());
  const retried = await refresh(String(rotated.refresh_token));
  const next = await refresh(String(rotatedAgain.refresh_token));
  const nextWorks = await mcpStatus(base, String(next.access_token));
  check(
    'a restart drops an unreadable entry in oauth-sessions.json and keeps the others; a refresh retried across the restart within a minute gets the same token, and the session stays usable',
    retried.refresh_token === rotatedAgain.refresh_token && /^rt_/.test(String(next.refresh_token)) && next.refresh_token !== rotatedAgain.refresh_token &&
      nextWorks !== 401,
    { retried: Object.keys(retried), next: Object.keys(next), nextWorks },
  );
}

/**
 * Tenant lifecycle from registry.json alone: at start the relay prunes a device that never synced within 24 h of
 * registering and one idle for 30 days without agents; it keeps an idle one with agents, but only active and pending
 * devices count against --max-devices.
 */
async function lifecycleChecks(statePath: string): Promise<void> {
  const now = Date.now();
  const day = 24 * 60 * 60_000;
  const deviceKey = () => `dk_${randomBytes(32).toString('base64url')}`;
  const keys = { neverSynced: deviceKey(), idleAlone: deviceKey(), idleWithAgents: deviceKey(), pending: deviceKey() };
  const tenant = (key: string, registeredAt: number, lastSyncAt: number | null, withAgents: boolean) => ({
    id: `tn_${randomBytes(16).toString('base64url')}`,
    deviceKeyDigest: digest(key),
    registeredAt,
    lastSyncAt,
    revision: withAgents ? 1 : 0,
    agents: withAgents ? [wireAgent(agents.D)] : [],
  });
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      tenants: [
        tenant(keys.neverSynced, now - day - 60 * 60_000, null, false),
        tenant(keys.idleAlone, now - 40 * day, now - 31 * day, false),
        tenant(keys.idleWithAgents, now - 40 * day, now - 31 * day, true),
        tenant(keys.pending, now - 60_000, null, false),
      ],
    }),
    { mode: 0o600 },
  );
  const relay = await startRelay(statePath, {}, ['--max-devices', '2']);
  try {
    const kept = (JSON.parse(readFileSync(statePath, 'utf8')) as { tenants: { deviceKeyDigest: string }[] }).tenants.map((t) => t.deviceKeyDigest);
    const registrations = [(await registerDevice(relay.base)).status, (await registerDevice(relay.base)).status];
    const syncStatus = async (key: string) => (await post(relay.base, '/v1/device/sync', key, { v: 1, waitMs: 0, outbox: [] })).status;
    const statuses = {
      neverSynced: await syncStatus(keys.neverSynced),
      idleAlone: await syncStatus(keys.idleAlone),
      idleWithAgents: await syncStatus(keys.idleWithAgents),
      pending: await syncStatus(keys.pending),
    };
    check(
      'at start the relay prunes a device that never synced within 24 h and one idle 30 days without agents (their keys get 401), keeps an idle one with agents and a new one; with --max-devices 2 the idle one does not count, so one registration fits and the next is 503',
      isDeepStrictEqual(kept, [digest(keys.idleWithAgents), digest(keys.pending)]) &&
        isDeepStrictEqual(registrations, [200, 503]) &&
        isDeepStrictEqual(statuses, { neverSynced: 401, idleAlone: 401, idleWithAgents: 200, pending: 200 }),
      { kept, registrations, statuses },
    );
  } finally {
    await relay.stop();
  }
}

async function run(statePath: string): Promise<void> {
  let relay = await startRelay(statePath);
  try {
    const registered = await registerDevice(relay.base);
    const deviceKey = String(registered.json.deviceKey ?? '');
    check(
      'a fresh relay mints no device of its own; a phone registers itself: v 1, a tn_ device id and a dk_ key, no-store',
      !relay.log.includes('dk_') && !relay.log.includes('puffer://pair') &&
        registered.status === 200 && registered.json.v === 1 && /^tn_[\w-]{22}$/.test(registered.json.deviceId) &&
        /^dk_[\w-]{43}$/.test(deviceKey) && registered.headers.get('cache-control') === 'no-store',
      { log: relay.log, registered: registered.json },
    );

    check('401 without a token', (await mcpStatus(relay.base, null)) === 401);
    check('401 with an agent key the phone never registered', (await mcpStatus(relay.base, agents.A.key)) === 401);
    check('401 on sync without the device key', (await post(relay.base, '/v1/device/sync', null, { v: 1, waitMs: 0, outbox: [] })).status === 401);
    const unknownDevice = await post(relay.base, '/v1/device/sync', `dk_${randomBytes(32).toString('base64url')}`, { v: 1, waitMs: 0, outbox: [] });
    check(
      'an unknown device key gets 401 unknown_device telling the phone to register again',
      unknownDevice.status === 401 && (unknownDevice.json as Record<string, string>).error === 'unknown_device' &&
        /register again/i.test((unknownDevice.json as Record<string, string>).message ?? ''),
      unknownDevice,
    );
    check('426 on sync with another protocol version', (await post(relay.base, '/v1/device/sync', deviceKey, { v: 2, waitMs: 0, outbox: [] })).status === 426);
    check('400 on a malformed sync body', (await post(relay.base, '/v1/device/sync', deviceKey, { v: 1, waitMs: 'soon', outbox: [] })).status === 400);

    const pushed = await phone(relay.base, deviceKey)({
      registry: { revision: 1, agents: [wireAgent(agents.A), wireAgent(agents.B), wireAgent(agents.C), wireAgent(agents.D)] },
    });
    check('registry push from the phone is applied', pushed.registryRevision === 1, pushed);
    const onDisk = tenantOnDisk(statePath, deviceKey);
    check(
      'registry.json records when the device registered and, from its first sync, when it last synced',
      typeof onDisk.registeredAt === 'number' && typeof onDisk.lastSyncAt === 'number' && onDisk.lastSyncAt >= onDisk.registeredAt,
      onDisk,
    );
    await relay.stop();

    relay = await startRelay(statePath);
    const sync = phone(relay.base, deviceKey);
    const a = await connectAgent(relay.base, agents.A.key);
    const b = await connectAgent(relay.base, agents.B.key);
    const c = await connectAgent(relay.base, agents.C.key);
    check('a restart keeps agent digests', (await a.listTools()).tools.length === TOOLS.length);
    const health = await fetch(`${relay.base}/healthz`);
    const healthBody = await health.json();
    const traceStatus = await statusWithMethod(relay.base, '/.well-known/oauth-authorization-server', 'TRACE');
    const syncHeaders = (await fetch(`${relay.base}/v1/device/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, waitMs: 0, outbox: [] }),
    })).headers;
    check(
      '/healthz answers {ok:true} and nothing about the phone; TRACE on a discovery route is 405, not 500; sync responses are no-store; no HSTS on plain http',
      isDeepStrictEqual(healthBody, { ok: true }) && traceStatus === 405 && syncHeaders.get('cache-control') === 'no-store' &&
        !health.headers.has('strict-transport-security'),
      { healthBody, traceStatus, cacheControl: syncHeaders.get('cache-control') },
    );

    const modern = await connectAgent(relay.base, agents.A.key, 'auto');
    const tools = (await modern.listTools()).tools;
    const askTool = tools.find((t) => t.name === 'ask_puffer');
    check(
      '2026-07-28 client negotiates the modern era and lists the 5 library and 8 note tools',
      modern.getProtocolEra() === 'modern' && isDeepStrictEqual(tools.map((t) => t.name).sort(), TOOLS),
      { era: modern.getProtocolEra(), tools: tools.map((t) => t.name) },
    );
    const allDescriptions = tools.map((t) => t.description ?? '').join('\n');
    check(
      'tool descriptions say a connected agent reads and writes with no per-request approval, name no consent, photo or hidden-change vocabulary, and the ask_puffer sentences are spaced',
      /Once connected, you can read and write the user's notes and documents/.test(askTool?.description ?? '') &&
        (askTool?.description ?? '').includes('list_notes. Documents come') &&
        !/ {2}|\.[A-Z]/.test(askTool?.description ?? '') &&
        !/waiting_for_user|approv|grant|photo|image|hidden_count|access covers/i.test(allDescriptions),
      allDescriptions,
    );
    const changesTool = tools.find((t) => t.name === 'get_puffer_changes')?.description ?? '';
    check('get_puffer_changes description explains the cursor', /next_cursor/.test(changesTool) && /`since`/.test(changesTool), changesTool);
    await modern.close();

    const openapi = await getJson(`${relay.base}/openapi.json`);
    const operations = Object.values(openapi.json.paths ?? {}).flatMap((methods) => Object.values(methods as Record<string, any>));
    const described = Object.fromEntries(operations.map((op) => [op.operationId, op.description]));
    check(
      'GET /openapi.json needs no key: OpenAPI 3.1, every operation named and described as its MCP tool, bearer auth, <base>/v1 as server, wait defaults to 25 s',
      openapi.status === 200 && /^3\.1\./.test(openapi.json.openapi) &&
        isDeepStrictEqual(Object.keys(described).sort(), tools.map((t) => t.name).sort()) &&
        tools.every((t) => described[t.name] === t.description) &&
        isDeepStrictEqual(Object.keys(openapi.json.paths).sort(), [
          '/answers/{request_id}',
          '/ask',
          '/changes',
          '/notes',
          '/notes/folders',
          '/notes/search',
          '/notes/{note_id}',
          '/notes/{note_id}/append',
          '/recent',
          '/sources',
        ]) &&
        isDeepStrictEqual(openapi.json.servers, [{ url: `${relay.base}/v1` }]) &&
        isDeepStrictEqual(openapi.json.security, [{ agentKey: [] }]) &&
        openapi.json.components.securitySchemes.agentKey.scheme === 'bearer' &&
        openapi.json.paths['/ask'].post.requestBody.content['application/json'].schema.properties.wait.default === 25,
      openapi.json,
    );
    const startText = await (await fetch(`${relay.base}/start`)).text();
    const latestHint = (text: string) => text.includes('list_puffer_recent') && text.includes('sort "recent"');
    check(
      'the ask_puffer description, the OpenAPI document and GET /start send "latest" requests to list_puffer_recent, and "latest X about Y" to ask_puffer with sort "recent"',
      latestHint(askTool?.description ?? '') && latestHint(openapi.json.info.description) && latestHint(startText) &&
        startText.includes(`${relay.base}/v1/recent`) && startText.includes(`${relay.base}/v1/sources`) &&
        /newest modified first/.test(tools.find((t) => t.name === 'list_puffer_recent')?.description ?? ''),
      { ask: askTool?.description, info: openapi.json.info.description },
    );

    const mcpChallenge = (await fetch(`${relay.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
      .headers.get('www-authenticate');
    const unauthorized = [
      await api(relay.base, '/v1/ask', null, { body: { question: 'Where is the spare key?' } }),
      await api(relay.base, '/v1/changes', agentKey()),
      await api(relay.base, `/v1/changes?access_token=${agents.A.key}&key=${agents.A.key}`, null),
    ];
    check(
      'the HTTP API answers 401 {error: invalid_token, message} with the /mcp challenge for no key, an unknown key, and a registered key in the query string',
      /resource_metadata=/.test(mcpChallenge ?? '') &&
        unauthorized.every((r) => r.status === 401 && r.headers.get('www-authenticate') === mcpChallenge && r.json.error === 'invalid_token' && r.json.message),
      unauthorized.map((r) => ({ status: r.status, challenge: r.headers.get('www-authenticate'), json: r.json })),
    );

    const badInput = [
      await api(relay.base, '/v1/ask', agents.A.key, { body: {} }),
      await api(relay.base, '/v1/ask', agents.A.key, { body: { question: 'Where is the spare key?', wait: 51 } }),
      await api(relay.base, '/v1/ask', agents.A.key, { raw: 'question=spare+key' }),
      await api(relay.base, '/v1/changes?limit=0', agents.A.key),
      await api(relay.base, '/v1/changes?limit=2&limit=3', agents.A.key),
      await api(relay.base, '/v1/answers/not-an-id', agents.A.key),
      await api(relay.base, '/v1/changes?wait=1.5', agents.A.key),
    ];
    const tooBig = await api(relay.base, '/v1/ask', agents.A.key, { body: { question: 'x'.repeat(9_000) } });
    const tooBigUnauthenticated = await api(relay.base, '/register', null, { raw: 'x'.repeat(70_000) });
    const wrongMethod = await api(relay.base, '/v1/ask', agents.A.key, { method: 'GET' });
    const literalPaths = [
      await api(relay.base, '/v1/notes/search', agents.A.key, { method: 'DELETE' }),
      await api(relay.base, '/v1/notes/folders', agents.A.key, { method: 'PATCH', body: { body: 'x', base_version: 1 } }),
    ];
    const aliveAfter = (await fetch(`${relay.base}/healthz`)).status;
    check(
      'bad input is 400 {error: invalid_request, message} (no question, wait 51, a non-JSON body, limit 0, a repeated parameter, a malformed request id, wait 1.5 named as not an integer); a 9 KB ask and a 70 KB unauthenticated /register are 413 and the relay keeps serving; GET /v1/ask is 405 with Allow: POST; DELETE /v1/notes/search and PATCH /v1/notes/folders are 405 with Allow: GET, never a note_id',
      badInput.every((r) => r.status === 400 && r.json.error === 'invalid_request' && r.json.message) &&
        !/received string/.test(badInput.at(-1)?.json.message) &&
        [tooBig, tooBigUnauthenticated].every((r) => r.status === 413 && r.json.error === 'body_too_large' && r.json.message) &&
        aliveAfter === 200 && wrongMethod.status === 405 && wrongMethod.headers.get('allow') === 'POST' &&
        literalPaths.every((r) => r.status === 405 && r.headers.get('allow') === 'GET'),
      [...badInput, tooBig, tooBigUnauthenticated, wrongMethod, ...literalPaths].map((r) => ({ status: r.status, json: r.json })),
    );

    const passport = 'When does my passport expire?';
    const offline = await call(a, 'ask_puffer', { question: passport });
    const offlineId = String(field(offline, 'request_id'));
    check('phone_offline with a request_id when no phone has synced recently', field(offline, 'status') === 'phone_offline' && offlineId.startsWith('rq_'), offline.structuredContent);
    const offlineLink = String(field(offline, 'open_url'));
    check(
      'the offline answer asks the agent to have the user open Puffer, with the /open/<id> link and without the question',
      offlineLink === `${relay.base}/open/${offlineId}` &&
        textOf(offline).includes('open Puffer on their iPhone') &&
        textOf(offline).endsWith(offlineLink) &&
        !textOf(offline).includes('passport'),
      textOf(offline),
    );
    const openPage = await fetch(offlineLink);
    const openHtml = await openPage.text();
    check(
      'GET /open/<id> is a no-store, no-referrer page that opens puffer://agents and names nothing else, whatever the request; a malformed id is 404',
      openPage.status === 200 &&
        openPage.headers.get('content-type') === 'text/html; charset=utf-8' &&
        openPage.headers.get('cache-control') === 'no-store' &&
        openPage.headers.get('referrer-policy') === 'no-referrer' &&
        openHtml.includes('url=puffer://agents') &&
        !openHtml.includes('puffer://request/') &&
        !/passport|claude|offline|pending/i.test(openHtml) &&
        (await fetch(`${relay.base}/open/rq_bad`)).status === 404,
      { status: openPage.status, headers: Object.fromEntries(openPage.headers), openHtml },
    );

    const wake = await sync();
    const queued = wake.requests.find((r) => r.id === offlineId);
    check(
      'the next sync delivers the request queued while offline',
      queued?.kind === 'ask' && queued.question === passport && queued.agentId === agents.A.id && !('broaden' in queued),
      wake.requests,
    );
    const isoSeconds = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
    check('wire timestamps are whole-second ISO 8601', wake.requests.every((r) => isoSeconds.test(r.askedAt) && isoSeconds.test(r.expiresAt)), queued);
    const ackNothing = await sync({ outbox: [{ id: offlineId, kind: 'nothingFound' }] });
    check('an outbox entry is acked with its kind', isDeepStrictEqual(ackNothing.acked, [{ id: offlineId, kind: 'nothingFound' }]), ackNothing.acked);
    check('get_puffer_answer returns nothing_found for it', field(await call(a, 'get_puffer_answer', { request_id: offlineId }), 'status') === 'nothing_found');

    const lease = 'What is the deposit in my lease?';
    const grantStarted = Date.now();
    const grantAsk = call(a, 'ask_puffer', { question: lease });
    const grantId = askId(await sync({ waitMs: 10_000 }), lease);
    await sync({
      outbox: [
        {
          id: grantId,
          kind: 'answered',
          photosWithheld: 1,
          photosUnavailable: 0,
          approvedBy: 'grant',
          items: [
            {
              title: 'Lease agreement, page 3',
              kind: 'passage',
              text: "... a security deposit of three months' rent, payable ...",
              vec: [0.12, -0.4],
              embedding: [0.5],
              sourceUri: 'photo:LEAKED-ASSET-ID',
            },
          ],
        },
      ],
    });
    const grant = await grantAsk;
    const grantMs = Date.now() - grantStarted;
    check(
      'an answer returns from the same ask_puffer call when the phone answers in its next sync',
      field(grant, 'status') === 'answered' && grantMs < WAIT_MS,
      { status: field(grant, 'status'), ms: grantMs },
    );
    check(
      "an answer from a phone still sending approvedBy, photosWithheld and photosUnavailable is accepted; the agent gets the passage under a plain header, text only, with no approval or photo field",
      textOf(grant).startsWith("From the user's Puffer library:\n1. Lease agreement, page 3") && textOf(grant).includes('security deposit') &&
        grant.content.every((x) => x.type === 'text') &&
        isDeepStrictEqual(Object.keys(grant.structuredContent ?? {}).sort(), ['items', 'request_id', 'status']) &&
        isDeepStrictEqual(Object.keys((field(grant, 'items') as Record<string, unknown>[])[0] ?? {}).sort(), ['text', 'title']),
      grant,
    );

    const spareKey = 'Where is the spare key?';
    const answerSpareKey = async () => {
      const id = askId(await sync({ waitMs: 10_000 }), spareKey);
      await sync({
        outbox: [
          {
            id,
            kind: 'answered',
            approvedBy: 'grant',
            items: [{ title: 'House notes', kind: 'passage', text: 'The spare key is in the blue box.', vec: [0.3], sourceUri: 'photo:LEAKED-ASSET-ID' }],
          },
        ],
      });
    };
    const httpAsk = api(relay.base, '/v1/ask', agents.A.key, { body: { question: spareKey } });
    await answerSpareKey();
    const viaHttp = await httpAsk;
    const mcpAsk = call(a, 'ask_puffer', { question: spareKey });
    await answerSpareKey();
    const viaMcp = await mcpAsk;
    const { message: httpText, ...httpResult } = viaHttp.json;
    const sameIdOverMcp = await call(a, 'get_puffer_answer', { request_id: httpResult.request_id });
    const sameIdOverHttp = await api(relay.base, `/v1/answers/${httpResult.request_id}`, agents.A.key);
    check(
      'POST /v1/ask returns the structured result ask_puffer gives for the same question plus message (its text); get_puffer_answer and GET /v1/answers/<id> return it again; no-store',
      viaHttp.status === 200 && httpResult.status === 'answered' &&
        isDeepStrictEqual({ ...httpResult, request_id: '' }, { ...(viaMcp.structuredContent ?? {}), request_id: '' }) &&
        httpText === textOf(viaMcp) &&
        isDeepStrictEqual(sameIdOverMcp.structuredContent, httpResult) && textOf(sameIdOverMcp) === httpText &&
        isDeepStrictEqual(sameIdOverHttp.json, viaHttp.json) &&
        viaHttp.headers.get('cache-control') === 'no-store' && sameIdOverHttp.headers.get('cache-control') === 'no-store',
      { viaHttp: viaHttp.json, viaMcp: viaMcp.structuredContent },
    );

    const renewal = 'When does the bike insurance renew?';
    const quickStarted = Date.now();
    const askNoWait = await api(relay.base, '/v1/ask', agents.A.key, { body: { question: renewal, wait: 0 } });
    const quickMs = Date.now() - quickStarted;
    const cappedStarted = Date.now();
    const capped = await api(relay.base, `/v1/answers/${askNoWait.json.request_id}?wait=50`, agents.A.key);
    const cappedMs = Date.now() - cappedStarted;
    const handedRenewal = askId(await sync(), renewal);
    const pending = api(relay.base, `/v1/answers/${askNoWait.json.request_id}?wait=50`, agents.A.key);
    await sleep(200);
    await sync({ outbox: [{ id: handedRenewal, kind: 'nothingFound' }] });
    const settledRenewal = await pending;
    const foreignHttp = await api(relay.base, `/v1/answers/${askNoWait.json.request_id}`, agents.B.key);
    const foreignMcp = await call(b, 'get_puffer_answer', { request_id: askNoWait.json.request_id });
    const { message: foreignText, ...foreignResult } = foreignHttp.json;
    check(
      'wait 0 answers at once with a pending status and its request_id; wait 50 stops at the relay budget; GET /v1/answers/<id> returns the settled status once the phone answers; another agent reads the id as expired, exactly as over MCP',
      askNoWait.status === 200 && quickMs < WAIT_MS / 2 && ['processing', 'phone_offline'].includes(askNoWait.json.status) &&
        ['processing', 'phone_offline'].includes(capped.json.status) && cappedMs >= WAIT_MS - 200 && cappedMs < WAIT_MS + 400 &&
        handedRenewal === askNoWait.json.request_id &&
        settledRenewal.status === 200 && settledRenewal.json.status === 'nothing_found' &&
        foreignHttp.status === 200 && foreignResult.status === 'expired' &&
        isDeepStrictEqual(foreignResult, foreignMcp.structuredContent) && foreignText === textOf(foreignMcp),
      { quickMs, cappedMs, asked: askNoWait.json, capped: capped.json, settled: settledRenewal.json, foreign: foreignHttp.json },
    );

    const firstChanges = call(a, 'get_puffer_changes', {});
    const changesReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'changes');
    check(
      'get_puffer_changes reaches the phone as a changes request with no cursor and the default limit',
      changesReq?.kind === 'changes' && changesReq.since === null && changesReq.limit === 50 && changesReq.agentId === agents.A.id,
      changesReq,
    );
    await sync({
      outbox: [
        {
          id: changesReq?.id,
          kind: 'answered',
          items: [],
          changes: {
            events: [
              {
                kind: 'added',
                at: '2026-10-07T11:43:31Z',
                itemKind: 'passage',
                title: 'coffee-machine-descaling.txt',
                source: 'Manuals',
                excerpt: 'Descale every three months.',
                itemID: 'photo:LEAKED-ASSET-ID',
                sourceUri: 'folder:Manuals/coffee-machine-descaling.txt',
              },
              { kind: 'removed', at: '2026-10-07T11:43:32Z', title: 'dishwasher-warranty.txt', itemKind: 'passage', source: 'Manuals', excerpt: 'gone' },
            ],
            nextCursor: '7',
            hiddenCount: 2,
          },
        },
      ],
    });
    const changes = await firstChanges;
    const events = field(changes, 'events');
    check(
      "the changes answer returns events and next_cursor, a removal carries its title only, and the phone's itemKind and hiddenCount are dropped",
      field(changes, 'status') === 'answered' &&
        field(changes, 'next_cursor') === '7' &&
        isDeepStrictEqual(Object.keys(changes.structuredContent ?? {}).sort(), ['events', 'next_cursor', 'request_id', 'status']) &&
        isDeepStrictEqual(events, [
          {
            kind: 'added',
            at: '2026-10-07T11:43:31Z',
            title: 'coffee-machine-descaling.txt',
            source: 'Manuals',
            excerpt: 'Descale every three months.',
          },
          { kind: 'removed', at: '2026-10-07T11:43:32Z', title: 'dishwasher-warranty.txt' },
        ]) &&
        !/other change|passage/.test(textOf(changes)),
      changes.structuredContent,
    );
    const nextChanges = call(a, 'get_puffer_changes', { since: '7', limit: 5 });
    const pagedReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'changes');
    await sync({ outbox: [{ id: pagedReq?.id, kind: 'answered', changes: { events: [], nextCursor: '7', hiddenCount: 0 } }] });
    const paged = await nextChanges;
    check(
      'since and limit reach the phone unchanged, and an empty page answers with the same cursor',
      pagedReq?.kind === 'changes' && pagedReq.since === '7' && pagedReq.limit === 5 &&
        field(paged, 'status') === 'answered' && isDeepStrictEqual(field(paged, 'events'), []) && field(paged, 'next_cursor') === '7',
      { handed: pagedReq, result: paged.structuredContent },
    );
    const httpChanges = api(relay.base, '/v1/changes?since=7&limit=4', agents.A.key);
    const httpChangesReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'changes');
    const tent = { kind: 'added', at: '2026-10-07T11:50:00Z', itemKind: 'passage', title: 'tent-checklist.txt', source: 'Notes', excerpt: 'Pegs, poles, mallet.' };
    if (httpChangesReq) await sync({ outbox: [{ id: httpChangesReq.id, kind: 'answered', changes: { events: [tent], nextCursor: '8', hiddenCount: 1 } }] });
    const changesOverHttp = await httpChanges;
    const { message: changesText, ...changesResult } = changesOverHttp.json;
    const changesOverMcp = await call(a, 'get_puffer_answer', { request_id: changesResult.request_id });
    check(
      'GET /v1/changes passes since and limit to the phone unchanged and returns what get_puffer_answer gives over MCP for that request',
      httpChangesReq?.kind === 'changes' && httpChangesReq.since === '7' && httpChangesReq.limit === 4 &&
        changesOverHttp.status === 200 && changesResult.next_cursor === '8' && !('hidden_count' in changesResult) &&
        changesResult.events?.[0]?.title === 'tent-checklist.txt' &&
        isDeepStrictEqual(changesResult, changesOverMcp.structuredContent) && changesText === textOf(changesOverMcp),
      { handed: httpChangesReq, http: changesOverHttp.json },
    );
    const mismatch = call(a, 'ask_puffer', { question: 'Which manuals did I add?' });
    const mismatchId = askId(await sync({ waitMs: 10_000 }), 'Which manuals did I add?');
    await sync({ outbox: [{ id: mismatchId, kind: 'answered', changes: { events: [], nextCursor: '1', hiddenCount: 0 } }] });
    check('an ask answered with a changes page settles as expired', field(await mismatch, 'status') === 'expired');
    const throttled = call(a, 'get_puffer_changes', { since: '7', limit: 3 });
    const throttledId = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'changes')?.id;
    const throttledAck = await sync({ outbox: [{ id: throttledId, kind: 'rateLimited' }] });
    const throttledRead = await throttled;
    const refusedRead = call(c, 'get_puffer_changes', { since: '7', limit: 2 });
    const refusedId = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'changes' && r.agentId === agents.C.id)?.id;
    const refusedAck = await sync({ outbox: [{ id: refusedId, kind: 'declined' }] });
    const refusedResult = await refusedRead;
    check(
      'a read the phone rate limits answers rate_limited and says to wait a minute; one it declines answers declined and claims neither a user decision nor a rate limit; each ack echoes its kind',
      field(throttledRead, 'status') === 'rate_limited' && /Wait a minute, then ask again\./.test(textOf(throttledRead)) &&
        field(refusedResult, 'status') === 'declined' && !/user declined|rate limit|minute/i.test(textOf(refusedResult)) &&
        throttledAck.acked[0]?.kind === 'rateLimited' && refusedAck.acked[0]?.kind === 'declined',
      { throttled: textOf(throttledRead), refused: textOf(refusedResult), acks: [throttledAck.acked, refusedAck.acked] },
    );

    const notesListing = call(a, 'list_puffer_recent', { source: 'Apple Notes', limit: 7, include_documents: 'text' });
    const recentReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'recent');
    const notes = Array.from({ length: 7 }, (_, i) => ({
      title: `Note ${7 - i}`,
      kind: 'passage',
      text: `Written on day ${7 - i}.`,
      date: `2026-10-0${7 - i}T09:00:00Z`,
      folder: 'Apple Notes',
      ...(i === 0 ? { document: { kind: 'text', text: 'Written on day 7. The whole note.', truncated: false } } : {}),
    }));
    await sync({ outbox: [{ id: recentReq?.id, kind: 'answered', approvedBy: 'grant', items: notes }] });
    const listed = await notesListing;
    const listedItems = field(listed, 'items') as Record<string, any>[] | undefined;
    check(
      'list_puffer_recent reaches the phone as a recent request with its source, limit and include_documents, and returns 7 items in the ask item shape, in the order the phone sent, the whole note included',
      recentReq?.kind === 'recent' && recentReq.limit === 7 && recentReq.agentId === agents.A.id &&
        isDeepStrictEqual(recentReq.filters, { source: 'Apple Notes' }) && recentReq.includeDocuments === 'text' &&
        field(listed, 'status') === 'answered' &&
        listedItems?.length === 7 && listedItems.map((item) => item.title).join() === notes.map((note) => note.title).join() &&
        listedItems[0]?.date === '2026-10-07T09:00:00Z' && listedItems[0]?.folder === 'Apple Notes' &&
        listedItems[0]?.document?.text === 'Written on day 7. The whole note.' &&
        textOf(listed).includes('1. Note 7 (modified 2026-10-07, in Apple Notes)'),
      { handed: recentReq, result: listed.structuredContent },
    );

    const httpListing = api(relay.base, '/v1/recent?source=Shared%20with%20Puffer&wait=1', agents.A.key);
    const sharedReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'recent');
    const shared = {
      title: 'boarding-pass.pdf',
      kind: 'photo',
      imageJpeg: JPEG,
      imageOriginal: { mimeType: 'image/jpeg', data: JPEG },
      originalTooLarge: false,
      albums: ['Trips'],
      text: 'Gate B12',
      date: '2026-10-06T18:00:00Z',
      folder: 'Shared with Puffer',
      fileType: 'pdf',
    };
    await sync({ outbox: [{ id: sharedReq?.id, kind: 'answered', approvedBy: 'user', photosWithheld: 2, photosUnavailable: 1, items: [shared] }] });
    const sharedListing = await httpListing;
    const tooMany = await api(relay.base, '/v1/recent?limit=21', agents.A.key);
    check(
      'GET /v1/recent sends the default limit 10 and its source; an item from a phone still sending kind photo, imageJpeg, imageOriginal, originalTooLarge and albums reaches the agent without them; limit 21 is 400',
      sharedReq?.kind === 'recent' && sharedReq.limit === 10 && isDeepStrictEqual(sharedReq.filters, { source: 'Shared with Puffer' }) &&
        sharedReq.includeDocuments === undefined &&
        sharedListing.status === 200 && sharedListing.json.status === 'answered' &&
        isDeepStrictEqual(sharedListing.json.items, [
          { title: 'boarding-pass.pdf', text: 'Gate B12', date: '2026-10-06T18:00:00Z', folder: 'Shared with Puffer', file_type: 'pdf' },
        ]) &&
        !/photo|approv|withheld|album|image|grant/i.test(JSON.stringify(sharedListing.json)) &&
        tooMany.status === 400 && tooMany.json.error === 'invalid_request',
      { handed: sharedReq, shared: sharedListing.json, tooMany: tooMany.json },
    );

    const newestAbout = call(a, 'ask_puffer', { question: 'trip', filters: { source: 'Apple Notes' }, sort: 'recent', limit: 3 });
    const sortedReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'ask' && r.question === 'trip');
    await sync({ outbox: [{ id: sortedReq?.id, kind: 'answered', approvedBy: 'grant', items: notes.slice(0, 2) }] });
    const sorted = await newestAbout;
    await api(relay.base, '/v1/ask', agents.A.key, { body: { question: 'packing list', sort: 'relevance', limit: 5, wait: 0 } });
    const relevanceReq = (await sync()).requests.find((r) => r.kind === 'ask' && r.question === 'packing list');
    if (relevanceReq) await sync({ outbox: [{ id: relevanceReq.id, kind: 'nothingFound' }] });
    check(
      'ask_puffer with sort "recent" reaches the phone with sort recent and its limit next to the filters; sort "relevance" sends neither sort nor limit',
      sortedReq?.kind === 'ask' && sortedReq.sort === 'recent' && sortedReq.limit === 3 &&
        isDeepStrictEqual(sortedReq.filters, { source: 'Apple Notes' }) &&
        field(sorted, 'status') === 'answered' && (field(sorted, 'items') as unknown[]).length === 2 &&
        relevanceReq?.kind === 'ask' && !('sort' in relevanceReq) && !('limit' in relevanceReq),
      { sorted: sortedReq, relevance: relevanceReq },
    );

    const sourcesCall = call(a, 'list_puffer_sources', {});
    const sourcesReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'sources');
    const named = [{ name: 'Apple Notes', count: 4 }, { name: 'Photos', count: 12 }];
    await sync({ outbox: [{ id: sourcesReq?.id, kind: 'answered', sources: named }] });
    const sources = await sourcesCall;
    const httpSources = api(relay.base, '/v1/sources', agents.A.key);
    const httpSourcesReq = (await sync({ waitMs: 10_000 })).requests.find((r) => r.kind === 'sources');
    await sync({ outbox: [{ id: httpSourcesReq?.id, kind: 'answered', sources: [] }] });
    const noSources = await httpSources;
    check(
      'list_puffer_sources reaches the phone as a sources request and returns names and counts only; GET /v1/sources with none says so',
      sourcesReq?.kind === 'sources' && field(sources, 'status') === 'answered' && isDeepStrictEqual(field(sources, 'sources'), named) &&
        textOf(sources).includes('1. Apple Notes (4)') &&
        noSources.status === 200 && noSources.json.status === 'answered' && isDeepStrictEqual(noSources.json.sources, []) &&
        noSources.json.message === 'Puffer lists no sources yet.' && !/access/.test(textOf(sources)),
      { mcp: sources.structuredContent, http: noSources.json },
    );

    const beforeRecent = call(a, 'list_puffer_recent', {});
    await sleep(100);
    const oldPhone = await sync({ requestKinds: null });
    const refusedListing = await beforeRecent;
    check(
      'a phone that names no request kinds receives none; the listing fails at once telling the agent to have the app updated',
      !oldPhone.requests.some((r) => r.kind === 'recent') && field(refusedListing, 'status') === 'failed' &&
        /too old for this request/.test(textOf(refusedListing)),
      { handed: oldPhone.requests, result: refusedListing.structuredContent },
    );

    const heads = await post(relay.base, '/v1/device/sync', deviceKey, {
      v: 1, waitMs: 0, outbox: [], changeHeads: [{ agentId: agents.A.id, seq: 7 }, { agentId: 'ag_nobody', seq: 3 }],
    });
    const badHeads = await post(relay.base, '/v1/device/sync', deviceKey, {
      v: 1, waitMs: 0, outbox: [], changeHeads: [{ agentId: agents.A.id, seq: -1 }],
    });
    const stateNow = readFileSync(statePath, 'utf8');
    check(
      'change heads are accepted, malformed heads get 400, and heads stay out of the state file',
      heads.status === 200 && badHeads.status === 400 && !/changeHeads|"seq"/.test(stateNow),
      { status: heads.status, bad: badHeads.status },
    );

    const hooks = await startReceiver();
    try {
      const headOfA = (seq: number) => sync({ changeHeads: [{ agentId: agents.A.id, seq }] });
      const settle = () => sleep(DEBOUNCE_MS + 400);
      const init = await post(relay.base, '/mcp', agents.A.key, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
      });
      const capabilities = JSON.parse(/^data: (.+)$/m.exec(String(init.json))?.[1] ?? '{}').result?.capabilities;
      const listed = await mcpEvents(a, 'events/list', {});
      const offered = listed.ok ? listed.result.events : null;
      check(
        'initialize advertises the events capability, and events/list offers puffer.changes by webhook with a {head} payload',
        isDeepStrictEqual(capabilities?.events, { listChanged: true }) &&
          offered?.length === 1 && offered[0].name === 'puffer.changes' &&
          isDeepStrictEqual(offered[0].delivery, ['webhook']) && isDeepStrictEqual(offered[0].payloadSchema.required, ['head']),
        { capabilities, listed },
      );

      const firstSecret = webhookSecret();
      const mainSecret = webhookSecret();
      const subscribed = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('main'), firstSecret));
      const refreshed = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('main'), mainSecret, { ttlMs: 1 }));
      const subId = subscribed.ok ? subscribed.result.id : null;
      const challenge = hooks.verifications('main')[0];
      const grantedMs = refreshed.ok ? Date.parse(refreshed.result.refreshBefore) - Date.now() : 0;
      check(
        'subscribe verifies the callback once with a signed challenge and returns a sub_ id that a refresh reproduces, cursor "7", ttl clamped to 60 s',
        subscribed.ok && refreshed.ok && /^sub_[\w-]{22}$/.test(String(subId)) && refreshed.result.id === subId &&
          subscribed.result.cursor === '7' && subscribed.result.truncated === false &&
          hooks.verifications('main').length === 1 && signedBy(challenge, firstSecret) &&
          header(challenge, 'webhook-id').startsWith('msg_verification_') && header(challenge, 'x-mcp-subscription-id') === subId &&
          grantedMs > 50_000 && grantedMs <= 60_000,
        { subscribed, refreshed, verification: challenge?.body },
      );

      const mute = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('mute'), webhookSecret()));
      const shortSecret = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('main'), 'whsec_c2hvcnQ='));
      const plainHttp = await mcpEvents(a, 'events/subscribe', subscription('http://127.0.0.2:9/hook', webhookSecret()));
      const push = await mcpEvents(a, 'events/subscribe', { ...subscription(hooks.url('main'), webhookSecret()), delivery: { mode: 'push' } });
      const unknown = await mcpEvents(a, 'events/subscribe', { ...subscription(hooks.url('main'), webhookSecret()), name: 'puffer.other' });
      check(
        'a callback that does not echo is -32015 challenge_failed; a short secret or non-loopback http is -32602; mode push -32014; an unknown event -32011',
        isDeepStrictEqual(failure(mute), { code: -32015, reason: 'challenge_failed' }) &&
          failure(shortSecret)?.code === -32602 && failure(plainHttp)?.code === -32602 &&
          isDeepStrictEqual(failure(push), { code: -32014, feature: 'delivery', value: 'push' }) &&
          isDeepStrictEqual(failure(unknown), { code: -32011, kind: 'event' }),
        [mute, shortSecret, plainHttp, push, unknown].map(failure),
      );

      await headOfA(8);
      await settle();
      const [advance] = hooks.events('main');
      check(
        'a head advance delivers exactly one signed event: eventId, name, timestamp, data {head} and cursor, nothing else',
        hooks.events('main').length === 1 &&
          isDeepStrictEqual(Object.keys(advance?.body ?? {}).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']) &&
          advance?.body.name === 'puffer.changes' && isDeepStrictEqual(advance.body.data, { head: 8 }) && advance.body.cursor === '8' &&
          header(advance, 'webhook-id') === advance.body.eventId && header(advance, 'x-mcp-subscription-id') === subId &&
          signedBy(advance, mainSecret),
        hooks.events('main').map((hit) => hit.body),
      );

      await headOfA(9);
      await headOfA(10);
      await headOfA(11);
      await settle();
      const afterBurst = hooks.events('main').map((hit) => hit.body.data.head);
      await headOfA(11);
      await settle();
      check(
        'a burst of advances inside the debounce sends one event with the last head, and the same head again sends nothing',
        isDeepStrictEqual(afterBurst, [8, 11]) && hooks.events('main').length === 2,
        { afterBurst, after: hooks.events('main').map((hit) => hit.body.data.head) },
      );

      const late = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('late'), webhookSecret(), { cursor: '8' }));
      await settle();
      check(
        'a subscription created with an older cursor gets one event with the current head, and other sinks get nothing',
        late.ok && late.result.cursor === '8' &&
          isDeepStrictEqual(hooks.events('late').map((hit) => hit.body.data.head), [11]) && hooks.events('main').length === 2,
        { late, heads: hooks.events('late').map((hit) => hit.body.data) },
      );

      const flakySecret = webhookSecret();
      hooks.script('flaky', [500]);
      const gone = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('gone'), webhookSecret()));
      const flaky = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('flaky'), flakySecret));
      await headOfA(12);
      await sleep(DEBOUNCE_MS + 1_000 + 800);
      const [failed, retried] = hooks.events('flaky');
      check(
        'a 500 is retried with the same eventId and body and a fresh timestamp and signature',
        flaky.ok && hooks.events('flaky').length === 2 && failed?.raw === retried?.raw &&
          header(failed, 'webhook-id') === header(retried, 'webhook-id') &&
          header(failed, 'webhook-timestamp') !== header(retried, 'webhook-timestamp') &&
          signedBy(failed, flakySecret) && signedBy(retried, flakySecret),
        hooks.events('flaky').map((hit) => hit.headers),
      );
      await headOfA(13);
      await settle();
      check(
        'a 410 ends that delivery after one attempt and keeps the subscription for the next head',
        gone.ok && isDeepStrictEqual(hooks.events('gone').map((hit) => hit.body.data.head), [12, 13]),
        hooks.events('gone').map((hit) => hit.body.data),
      );

      const target = { name: 'puffer.changes', arguments: {}, delivery: { url: hooks.url('main') } };
      const unsubscribed = await mcpEvents(a, 'events/unsubscribe', target);
      const again = await mcpEvents(a, 'events/unsubscribe', target);
      await headOfA(14);
      await settle();
      check(
        'unsubscribe stops delivery to that callback only, and a second unsubscribe is -32011 subscription',
        unsubscribed.ok && isDeepStrictEqual(failure(again), { code: -32011, kind: 'subscription' }) &&
          isDeepStrictEqual(hooks.events('main').map((hit) => hit.body.data.head), [8, 11, 12, 13]) &&
          hooks.events('late').at(-1)?.body.data.head === 14,
        { main: hooks.events('main').map((hit) => hit.body.data.head), again },
      );
      for (const name of ['late', 'gone', 'flaky']) {
        await mcpEvents(a, 'events/unsubscribe', { ...target, delivery: { url: hooks.url(name) } });
      }

      const caps = ['cap1', 'cap2', 'cap3', 'cap4', 'cap5', 'cap6'];
      const capReplies = [];
      for (const name of caps) capReplies.push(await mcpEvents(a, 'events/subscribe', subscription(hooks.url(name), webhookSecret())));
      const refreshCap1 = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('cap1'), webhookSecret()));
      await mcpEvents(a, 'events/unsubscribe', { ...target, delivery: { url: hooks.url('cap1') } });
      const resubscribed = await mcpEvents(a, 'events/subscribe', subscription(hooks.url('cap1'), webhookSecret()));
      check(
        'an agent holds at most 5 subscriptions: the 6th is refused before any POST to its callback; a refresh needs no verification, a subscription after unsubscribe does',
        capReplies.slice(0, 5).every((reply) => reply.ok) &&
          failure(capReplies[5] as EventsReply)?.code === -32603 &&
          hooks.verifications('cap6').length === 0 &&
          refreshCap1.ok && resubscribed.ok &&
          hooks.verifications('cap1').length === 2,
        { capReplies: capReplies.map(failure), cap1: hooks.verifications('cap1').length },
      );
      for (const name of caps) await mcpEvents(a, 'events/unsubscribe', { ...target, delivery: { url: hooks.url(name) } });
    } finally {
      await hooks.close();
    }

    const bomb = await startBomb();
    try {
      const rssBefore = rssKb(relay.pid);
      const gzipped = await mcpEvents(a, 'events/subscribe', subscription(bomb.url('gzip'), webhookSecret()));
      const endless = await mcpEvents(a, 'events/subscribe', subscription(bomb.url('huge'), webhookSecret()));
      const bombed = (notify: unknown) => ({
        revision: 1,
        agents: [{ ...wireAgent(agents.A), notify }, wireAgent(agents.B), wireAgent(agents.C), wireAgent(agents.D)],
      });
      await sync({ registry: bombed({ url: bomb.url('huge') }), changeHeads: [{ agentId: agents.A.id, seq: 14 }] });
      await sync({ changeHeads: [{ agentId: agents.A.id, seq: 15 }] });
      await sleep(DEBOUNCE_MS + 1_500);
      const rssAfter = rssKb(relay.pid);
      await sync({ registry: bombed(undefined) });
      check(
        `a gzip bomb or a 64 MB body from a callback is not read and verification fails; the phone-set webhook's body is never read, so its delivery succeeds once; all asked identity; relay RSS ${rssBefore} -> ${rssAfter} KB (< +50 MB)`,
        isDeepStrictEqual(failure(gzipped), { code: -32015, reason: 'challenge_failed' }) &&
          isDeepStrictEqual(failure(endless), { code: -32015, reason: 'challenge_failed' }) &&
          isDeepStrictEqual(bomb.hits.map((hit) => hit.path), ['/bomb/gzip', '/bomb/huge', '/bomb/huge']) &&
          bomb.hits.every((hit) => hit.acceptEncoding === 'identity') &&
          rssAfter - rssBefore < 50 * 1024,
        { gzipped, endless, hits: bomb.hits, rssBefore, rssAfter },
      );
    } finally {
      await bomb.close();
    }

    const kettle = { kind: 'added', at: '2026-10-07T12:00:00Z', itemKind: 'passage', title: 'kettle-manual.txt', source: 'Manuals', excerpt: 'Descale monthly.' };
    const bikeLight = { kind: 'added', at: '2026-10-07T12:00:01Z', itemKind: 'passage', title: 'bike-light.txt', source: 'Manuals' };
    await sync({
      changePages: [
        { agentId: agents.A.id, since: '7', page: { events: [kettle], nextCursor: '9', hiddenCount: 1 } },
        { agentId: agents.B.id, page: { events: [bikeLight], nextCursor: '3', hiddenCount: 0 } },
        { agentId: agents.D.id, page: { events: [], nextCursor: '1', hiddenCount: 0 } },
        { agentId: 'ag_nobody', page: { events: [bikeLight], nextCursor: '3', hiddenCount: 0 } },
      ],
    });
    await sleep(OFFLINE_AFTER_MS + 300);
    const cachedStarted = Date.now();
    const cached = await call(a, 'get_puffer_changes', { since: '7' });
    const cachedMs = Date.now() - cachedStarted;
    const preparedAt = String(field(cached, 'prepared_at'));
    check(
      'with the phone offline, get_puffer_changes since "7" answers at once with the page the phone sent, shaped like a live answer plus prepared_at',
      cachedMs < 1_000 && field(cached, 'status') === 'answered' &&
        isDeepStrictEqual(field(cached, 'events'), [
          { kind: 'added', at: kettle.at, title: 'kettle-manual.txt', source: 'Manuals', excerpt: 'Descale monthly.' },
        ]) &&
        field(cached, 'next_cursor') === '9' &&
        isoSeconds.test(preparedAt) && textOf(cached).includes(`The phone is offline; this page was prepared by the phone at ${preparedAt}.`) &&
        field(changes, 'prepared_at') === undefined,
      { cachedMs, cached: cached.structuredContent },
    );
    const d = await connectAgent(relay.base, agents.D.key);
    const burst = [];
    for (let i = 0; i < 21; i++) burst.push(await call(d, 'get_puffer_changes', {}));
    await d.close();
    check(
      'an agent gets 20 new requests a minute: 20 reads are answered, the 21st is an error that says to wait a minute',
      burst.slice(0, 20).every((result) => field(result, 'status') === 'answered') &&
        burst[20]?.isError === true && /Wait a minute, then try again/.test(textOf(burst[20] as CallToolResult)),
      textOf(burst[20] as CallToolResult),
    );
    const rateLimitedOverHttp = await api(relay.base, '/v1/changes', agents.D.key);
    const uncovered = await call(a, 'get_puffer_changes', { since: '5' });
    const uncoveredLink = String(field(uncovered, 'open_url'));
    const agentsPage = await (await fetch(uncoveredLink)).text();
    check(
      'since "5" is outside the page: phone_offline with an /open link that opens puffer://agents',
      field(uncovered, 'status') === 'phone_offline' && uncoveredLink === `${relay.base}/open/${String(field(uncovered, 'request_id'))}` &&
        agentsPage.includes('url=puffer://agents') && !agentsPage.includes('puffer://request/'),
      { uncovered: uncovered.structuredContent, agentsPage },
    );
    const woke = await sync();
    check(
      'the next sync reports the cursor the relay served, and only the uncovered request reaches the phone',
      isDeepStrictEqual(woke.readCursors, [{ agentId: agents.A.id, cursor: '9' }, { agentId: agents.D.id, cursor: '1' }]) &&
        isDeepStrictEqual(woke.requests.flatMap((r) => (r.kind === 'changes' ? [r.since] : [])), ['5']),
      woke,
    );

    const receipts = 'Which receipts did I keep from March?';
    const reviewStarted = Date.now();
    const reviewAsk = call(a, 'ask_puffer', { question: receipts });
    const reviewId = askId(await sync({ waitMs: 10_000 }), receipts);
    const review = await reviewAsk;
    const notFinal = ['processing', 'phone_offline'];
    check(
      'a request the phone holds without answering returns a pending status with its request_id once the wait budget ends',
      notFinal.includes(String(field(review, 'status'))) && field(review, 'request_id') === reviewId && Date.now() - reviewStarted >= WAIT_MS - 100,
      review.structuredContent,
    );

    const retry = await call(a, 'ask_puffer', { question: receipts });
    const afterRetry = await sync();
    check(
      'retrying the same question re-attaches to the open request instead of making another',
      field(retry, 'request_id') === reviewId && notFinal.includes(String(field(retry, 'status'))) &&
        isDeepStrictEqual(afterRetry.requests.flatMap((r) => (r.kind === 'ask' && r.question === receipts ? [r.id] : [])), [reviewId]),
      { retry: retry.structuredContent, handed: afterRetry.requests },
    );
    check("another agent reads someone else's request as expired", field(await call(b, 'get_puffer_answer', { request_id: reviewId }), 'status') === 'expired');

    const parked = sync({ waitMs: 20_000 }).then((reply) => ({ reply, at: Date.now() }));
    await sleep(200);
    const kickedAt = Date.now();
    const settled = await sync({
      waitMs: 20_000,
      outbox: [{ id: reviewId, kind: 'answered', items: [{ title: 'Receipt, Cafe Rosa, 12 March', kind: 'passage', text: 'Total 18.40 EUR, paid by card' }] }],
    });
    const ackedAfterMs = Date.now() - kickedAt;
    const released = await parked;
    check(
      'a sync carrying an outbox is acked at once, not held for its waitMs, and releases the parked long-poll empty',
      isDeepStrictEqual(settled.acked, [{ id: reviewId, kind: 'answered' }]) &&
        ackedAfterMs < 1_000 &&
        released.reply.requests.length === 0 &&
        released.at - kickedAt < 1_000,
      { acked: settled.acked, ackedAfterMs, releasedAfterMs: released.at - kickedAt },
    );

    const answer = await call(a, 'get_puffer_answer', { request_id: reviewId });
    check(
      'get_puffer_answer returns the settled outcome',
      field(answer, 'status') === 'answered' && textOf(answer).includes('Total 18.40 EUR, paid by card'),
      answer.structuredContent,
    );
    const late = await sync({ outbox: [{ id: reviewId, kind: 'declined' }] });
    check(
      'first terminal outcome wins: a later declined is acked as answered',
      late.acked[0]?.kind === 'answered' && field(await call(a, 'get_puffer_answer', { request_id: reviewId }), 'status') === 'answered',
      late.acked,
    );

    const parkedPhone = sync({ waitMs: 10_000 });
    const fiveStarted = Date.now();
    const five = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call(c, 'ask_puffer', { question: `Parallel question ${i + 1}` }).then((result) => ({ result, ms: Date.now() - fiveStarted })),
      ),
    );
    await parkedPhone;
    const quick = five.filter(({ ms }) => ms < WAIT_MS / 2);
    const fiveIds = five.map(({ result }) => String(field(result, 'request_id')));
    check(
      'an agent parks at most 4 calls at once: of 5 parallel asks one answers at once with its request_id, the others wait out the budget',
      quick.length === 1 && field(quick[0]?.result as CallToolResult, 'status') === 'processing' &&
        five.filter(({ ms }) => ms >= WAIT_MS - 200).length === 4 && new Set(fiveIds).size === 5 && fiveIds.every((id) => id.startsWith('rq_')),
      five.map(({ result, ms }) => ({ ms, status: field(result, 'status') })),
    );
    await sync({ outbox: fiveIds.map((id) => ({ id, kind: 'nothingFound' })) });

    const dropped = Array.from({ length: 4 }, () => new AbortController());
    const droppedAsks = dropped.map((controller, i) =>
      fetch(new URL('/v1/ask', relay.base), {
        method: 'POST',
        headers: { authorization: `Bearer ${agents.B.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ question: `Dropped question ${i + 1}` }),
        signal: controller.signal,
      }).catch(() => null),
    );
    await sleep(300);
    for (const controller of dropped) controller.abort();
    await Promise.all(droppedAsks);
    await sleep(100);
    const parkedForB = sync({ waitMs: 10_000 });
    const fourStarted = Date.now();
    const fourOverMcp = Array.from({ length: 4 }, (_, i) =>
      call(b, 'ask_puffer', { question: `Parked question ${i + 1}` }).then((result) => ({ result, ms: Date.now() - fourStarted })),
    );
    await sleep(300);
    const fifthStarted = Date.now();
    const fifthOverHttp = await api(relay.base, '/v1/ask', agents.B.key, { body: { question: 'Parked question 5' } });
    const fifthMs = Date.now() - fifthStarted;
    const four = await Promise.all(fourOverMcp);
    await parkedForB;
    check(
      'MCP and the HTTP API share the 4-wait cap: 4 HTTP waits dropped by their clients free their slots, so 4 MCP asks park the full budget, and a fifth ask over HTTP answers at once with its request_id',
      fifthOverHttp.status === 200 && fifthMs < WAIT_MS / 2 && fifthOverHttp.json.status === 'processing' &&
        String(fifthOverHttp.json.request_id).startsWith('rq_') && four.every(({ ms }) => ms >= WAIT_MS - 200),
      { fifthMs, fifth: fifthOverHttp.json, four: four.map(({ result, ms }) => ({ ms, status: field(result, 'status') })) },
    );
    const parkedIds = [...four.map(({ result }) => String(field(result, 'request_id'))), String(fifthOverHttp.json.request_id)];
    const droppedIds = (await sync()).requests.flatMap((r) => (r.kind === 'ask' && r.question.startsWith('Dropped question') ? [r.id] : []));
    await sync({ outbox: [...parkedIds, ...droppedIds].map((id) => ({ id, kind: 'nothingFound' })) });

    const ten = await Promise.all(Array.from({ length: 10 }, (_, i) => call(c, 'ask_puffer', { question: `Open question number ${i + 1}` })));
    const eleventh = await call(c, 'ask_puffer', { question: 'Open question number 11' });
    check('an agent with 10 open requests is refused', ten.every((r) => !r.isError) && eleventh.isError === true, textOf(eleventh));
    const fullOverHttp = await api(relay.base, '/v1/ask', agents.C.key, { body: { question: 'Open question number 12' } });
    check(
      'MCP and the HTTP API share the per-agent limits: after 21 MCP reads an HTTP read is 429 rate_limited with Retry-After 60, and with 10 open MCP asks an HTTP ask is 429 too_many_open_requests; each message is the MCP text',
      rateLimitedOverHttp.status === 429 && rateLimitedOverHttp.json.error === 'rate_limited' &&
        rateLimitedOverHttp.headers.get('retry-after') === '60' && rateLimitedOverHttp.json.message === textOf(burst[20] as CallToolResult) &&
        fullOverHttp.status === 429 && fullOverHttp.json.error === 'too_many_open_requests' &&
        !fullOverHttp.headers.has('retry-after') && fullOverHttp.json.message === textOf(eleventh),
      { rate: rateLimitedOverHttp.json, full: fullOverHttp.json },
    );

    const insurance = 'Where did I file the car insurance letter?';
    const bWaiting = call(b, 'ask_puffer', { question: insurance });
    let bOpenId: string | undefined;
    for (let tries = 0; tries < 5 && !bOpenId; tries++) bOpenId = askId(await sync({ waitMs: 1_000 }), insurance);
    const revoked = await sync({ registry: { revision: 2, agents: [wireAgent(agents.A), wireAgent(agents.C)] } });
    const bHeard = await bWaiting;
    check(
      'an agent the phone removes hears, on the call it is waiting on, that the user disconnected it; from then on it gets 401 at /mcp and at the HTTP API',
      revoked.registryRevision === 2 && field(bHeard, 'status') === 'disconnected' && field(bHeard, 'request_id') === bOpenId &&
        /disconnected you in Puffer/.test(textOf(bHeard)) && !/try again|minute/i.test(textOf(bHeard)) &&
        (await mcpStatus(relay.base, agents.B.key)) === 401 && (await api(relay.base, '/v1/changes', agents.B.key)).status === 401,
      { bHeard: bHeard.structuredContent, text: textOf(bHeard) },
    );
    const lateForRevoked = await sync({ outbox: [{ id: bOpenId, kind: 'answered', items: [{ title: 'Insurance', kind: 'passage', text: 'Folder 3' }] }] });
    check("the removed agent's open request is settled, so a late answer is refused (acked expired)", lateForRevoked.acked[0]?.kind === 'expired', lateForRevoked.acked);
    const stale = await sync({ registry: { revision: 1, agents: [wireAgent(agents.A), wireAgent(agents.B), wireAgent(agents.C)] } });
    check('an older registry snapshot is ignored', stale.registryRevision === 2 && (await mcpStatus(relay.base, agents.B.key)) === 401);

    const pokeHooks = await startReceiver();
    const pokeToken = `tok_${randomBytes(16).toString('base64url')}`;
    const snapshot = {
      revision: 3,
      agents: [
        { ...wireAgent(agents.A), notify: { url: 12345 } },
        { ...wireAgent(agents.B), notify: { url: pokeHooks.url('poke'), token: pokeToken } },
        { ...wireAgent(agents.C), notify: { url: 'http://127.0.0.2:9/hook' } },
      ],
    };
    const readded = await sync({ registry: snapshot });
    await sleep(OFFLINE_AFTER_MS + 300);
    const afterRevoke = await call(b, 'get_puffer_changes', {});
    check(
      "a malformed or non-https notify drops only that webhook, never the sync; a revoked agent's page is gone once it is re-added",
      readded.registryRevision === 3 && readded.wantsRegistry === false && field(afterRevoke, 'status') === 'phone_offline',
      { readded, afterRevoke: afterRevoke.structuredContent },
    );

    const headOfB = (seq: number, extra: { registry?: unknown } = {}) => sync({ changeHeads: [{ agentId: agents.B.id, seq }], ...extra });
    await headOfB(3);
    await headOfB(4);
    await sleep(DEBOUNCE_MS + 400);
    await headOfB(4, { registry: snapshot });
    await sleep(DEBOUNCE_MS + 400);
    const [ping] = pokeHooks.events('poke');
    check(
      "the phone-set webhook gets one POST per advance with the user's bearer token and the content-free body; a re-sent snapshot does not re-fire",
      pokeHooks.events('poke').length === 1 && pokeHooks.verifications('poke').length === 0 &&
        header(ping, 'authorization') === `Bearer ${pokeToken}` && header(ping, 'webhook-id') === ping?.body.eventId &&
        isDeepStrictEqual(Object.keys(ping?.body ?? {}).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']) &&
        ping?.body.name === 'puffer.changes' && isDeepStrictEqual(ping.body.data, { head: 4 }) && ping.body.cursor === '4',
      pokeHooks.events('poke').map((hit) => ({ headers: hit.headers, body: hit.body })),
    );

    await Promise.all([a.close(), b.close(), c.close()]);
    await relay.stop();
    relay = await startRelay(statePath, { PUFFER_PUBLIC_URL: 'https://relay.puffer.test' });
    const restartedSync = phone(relay.base, deviceKey);
    const restartedAt = Date.now();
    const restarted = await restartedSync({ waitMs: 10_000, changeHeads: [{ agentId: agents.B.id, seq: 4 }] });
    const restartedMs = Date.now() - restartedAt;
    const restored = await restartedSync({ registry: snapshot, changeHeads: [{ agentId: agents.B.id, seq: 4 }] });
    await restartedSync({ changeHeads: [{ agentId: agents.B.id, seq: 5 }] });
    await sleep(DEBOUNCE_MS + 400);
    check(
      'after a restart the first sync is answered at once and asks for the registry, and the same-revision snapshot restores the webhook',
      restarted.wantsRegistry === true && restartedMs < 1_000 && restored.wantsRegistry === false && restored.registryRevision === 3 &&
        isDeepStrictEqual(pokeHooks.events('poke').map((hit) => hit.body.data.head), [4, 5]) &&
        header(pokeHooks.events('poke')[1], 'authorization') === `Bearer ${pokeToken}`,
      { restarted, restartedMs, restored, heads: pokeHooks.events('poke').map((hit) => hit.body.data) },
    );
    await pokeHooks.close();
    const hsts = (await fetch(`${relay.base}/healthz`)).headers.get('strict-transport-security');
    check(
      'PUFFER_PUBLIC_URL host passes the Host guard while a foreign Host gets 403 at /mcp (JSON-RPC body) and /v1/ask ({error, message}); an https public URL sends HSTS',
      (await statusWithHost(relay.base, 'relay.puffer.test')) === 401 && (await statusWithHost(relay.base, 'attacker.test')) === 403 &&
        (await statusWithHost(relay.base, 'relay.puffer.test', '/v1/ask')) === 401 &&
        (await statusWithHost(relay.base, 'attacker.test', '/v1/ask')) === 403 &&
        JSON.parse(guardBodies.at(-3) ?? '{}').jsonrpc === '2.0' &&
        isDeepStrictEqual(JSON.parse(guardBodies.at(-1) ?? '{}'), { error: 'invalid_host', message: 'Invalid Host: attacker.test' }) &&
        hsts === 'max-age=31536000',
      { hsts, guardBodies: guardBodies.slice(-4) },
    );
    const publicDocument = await getJson(`${relay.base}/openapi.json`);
    check(
      'with PUFFER_PUBLIC_URL set, openapi.json names <public URL>/v1 as its server',
      isDeepStrictEqual(publicDocument.json.servers, [{ url: 'https://relay.puffer.test/v1' }]),
      publicDocument.json.servers,
    );

    const oauthSecrets = await oauthChecks(async (env) => {
      await relay.stop();
      relay = await startRelay(statePath, env, ['--connect-ttl-ms', String(CONNECT_TTL_MS)]);
      return relay;
    }, deviceKey);

    const state = readFileSync(statePath, 'utf8');
    const clientsPath = join(dirname(statePath), 'oauth-clients.json');
    const clients = readFileSync(clientsPath, 'utf8');
    const sessionsFile = readFileSync(join(dirname(statePath), 'oauth-sessions.json'), 'utf8');
    const seen = JSON.stringify([results, httpBodies]);
    const leaks = FORBIDDEN.filter((token) => seen.includes(token) || state.includes(token) || clients.includes(token));
    check(
      `no tool result (${results.length} checked), HTTP API result (${httpBodies.length}) or relay state file contains ${FORBIDDEN.join(', ')}`,
      leaks.length === 0,
      leaks,
    );
    const undocumented = [...new Set(httpBodies.flatMap((body) => offSchema(body, openapi.json.components.schemas.Result)))];
    check(
      `every value in the ${httpBodies.length} HTTP API results has a property and type in the Result schema of openapi.json, nested ones and nulls included`,
      httpBodies.length >= 6 && undocumented.length === 0,
      undocumented,
    );
    const stored = JSON.parse(clients) as { clients: Record<string, unknown>[] };
    check(
      `the state files hold no questions, answers, pages, notify config or OAuth secrets (${oauthSecrets.length}: access and refresh tokens, code, verifier, link secrets, poll tokens), are owner-only, and oauth-clients.json keeps clientId, name, redirectUris, registeredAt, lastUsedAt`,
      !/passport|lease|receipt|Rosa|insurance|descaling|dishwasher|kettle|bike-light|notify|hooks|127\.0\.0\.2/i.test(state) &&
        !state.includes(pokeToken) &&
        isDeepStrictEqual(Object.keys(JSON.parse(state).tenants[0]).sort(), ['agents', 'deviceKeyDigest', 'id', 'lastSyncAt', 'registeredAt', 'revision']) &&
        isDeepStrictEqual(Object.keys(JSON.parse(state).tenants[0].agents[0]).sort(), ['id', 'keyDigest', 'name']) &&
        (statSync(statePath).mode & 0o777) === 0o600 &&
        oauthSecrets.length === 16 &&
        oauthSecrets.every((secret) => !state.includes(secret) && !clients.includes(secret) && !sessionsFile.includes(secret)) &&
        isDeepStrictEqual(Object.keys(stored), ['clients']) &&
        stored.clients.length === 3 &&
        stored.clients.every((client) => isDeepStrictEqual(Object.keys(client).sort(), ['clientId', 'lastUsedAt', 'name', 'redirectUris', 'registeredAt'])) &&
        (statSync(clientsPath).mode & 0o777) === 0o600,
      { state, clients },
    );

    await relay.stop();
    relay = await startRelay(statePath);
    await linkChecks(relay.base, deviceKey, statePath);
    await memoryChecks(relay.base, deviceKey);
    await noteChecks(relay.base, deviceKey);
    await isolationChecks(
      async () => {
        await relay.stop();
        relay = await startRelay(statePath);
        return relay;
      },
      relay.base,
      deviceKey,
      statePath,
    );

    await relay.stop();
    relay = await startRelay(statePath);
    const registrations: number[] = [];
    for (let i = 0; i < 11; i++) registrations.push((await post(relay.base, '/register', null, {})).status);
    check(
      '/register answers 429 once a caller has spent its 10 registrations for the hour',
      registrations.slice(0, 10).every((status) => status === 400) && registrations[10] === 429,
      registrations,
    );
  } finally {
    await relay.stop();
  }
}

const dir = mkdtempSync(join(tmpdir(), 'puffer-relay-e2e-'));
try {
  await run(join(dir, 'registry.json'));
  await addressChecks(join(dir, 'strict', 'registry.json'));
  await lifecycleChecks(join(dir, 'lifecycle', 'registry.json'));
} catch (error) {
  failed++;
  console.log(`FAIL  e2e aborted: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
