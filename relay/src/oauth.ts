// Connection requests: the OAuth 2.1 authorization server for MCP clients that only speak OAuth, and connect by message
// for agents that cannot do OAuth. Every request has an approve link: the OAuth page shows it as a QR code, an agent
// sends it to the user. The user approves on the phone either way, after opening that link: a connection belongs to no
// tenant until a phone presents its link secret, then to that phone's tenant only. That phone adds an agent with the
// connection's key digest to its registry, so the phone stays the only authority and removing the agent revokes it.
// A link agent gets that agent's ak_ key; an OAuth client gets a session (sessions.ts) for it. Connections and keys
// live in memory. Dynamically registered clients persist to oauth-clients.json beside the registry (0600). Single
// writer: this module.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { AuthMetadataOptions } from '@modelcontextprotocol/server';
import QRCode from 'qrcode';
import { z } from 'zod';

import { send } from './egress';
import { RateLimit } from './limits';
import { deliverEvent, signed } from './notify';
import {
  ConnectId,
  LOOPBACK_HOSTS,
  parseCallbackUrl,
  wireTime,
  type CallbackUrl,
  type ConfirmReply,
  type KeyDigest,
  type WireConnect,
} from './protocol';
import { digestKey, writeStateFile, type AgentClaim, type TenantId } from './registry';
import { REVOKED_RETENTION_MS, Sessions } from './sessions';

export const DEFAULT_CONNECT_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const ENDED_RETENTION_MS = 10 * 60_000;
export const MAX_LINK_ATTEMPTS = 3;
/** A link agent whose reply with its key got lost may collect it again with the same poll token this long. */
const KEY_RECOLLECT_MS = 60_000;
/** Connections the phone still has to act on: per caller, so one caller cannot crowd out the others, and overall. */
const MAX_WAITING = { perCaller: 3, total: 100 };
const MAX_CLIENTS = 200;
const METADATA_DOCUMENT = { timeoutMs: 5_000, maxBytes: 5 * 1024 };
const POLL_EVERY_MS = 1_500;
/** RFC 8628 interval: an agent collecting its key starts a poll at most this often, unless the poll waited it out. */
export const LINK_INTERVAL_S = 5;
const LINK_NAME_MAX = 60;
const LINK_WAIT_MAX_S = 25;
const LinkRequest = z.object({ name: z.string(), callback_url: z.string().optional() });
const LinkPoll = z.object({ wait: z.number().int().min(0).max(LINK_WAIT_MAX_S).default(0) });

const isRedirectUri = (raw: string): boolean => {
  const url = raw.length <= 2048 && !raw.includes('#') && URL.canParse(raw) ? new URL(raw) : null;
  if (!url || url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
};
const RedirectUri = z.string().refine(isRedirectUri, 'a redirect URI must be https, or http on localhost, without a fragment').brand<'RedirectUri'>();
type RedirectUri = z.infer<typeof RedirectUri>;

/** Head plus rest: a client always has a first redirect URI to name it by. */
const RedirectUris = z.tuple([RedirectUri], RedirectUri).refine((uris) => uris.length <= 10, 'at most 10 redirect URIs');

const ClientId = z.string().regex(/^cl_[A-Za-z0-9_-]{22}$/).brand<'ClientId'>();
type ClientId = z.infer<typeof ClientId>;

const DcrClient = z.object({
  clientId: ClientId,
  name: z.string(),
  redirectUris: RedirectUris,
  registeredAt: z.iso.datetime(),
  /** Bumped by every /authorize that names it. The client used longest ago is dropped first. */
  lastUsedAt: z.iso.datetime(),
});
type DcrClient = z.infer<typeof DcrClient>;
// Files written before lastUsedAt existed count each client as last used when it registered.
const StoredClient = DcrClient.extend({ lastUsedAt: z.iso.datetime().optional() }).transform(
  (client): DcrClient => ({ ...client, lastUsedAt: client.lastUsedAt ?? client.registeredAt }),
);
const ClientsFile = z.object({ clients: z.array(StoredClient).max(MAX_CLIENTS) });

const RegistrationRequest = z.object({ client_name: z.string().optional(), redirect_uris: z.unknown() });

const MetadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.string().optional(),
});

type AgentKey = `ak_${string}`;

/** Who asked. `host` is the host of a metadata document URL; a dynamically registered client has none. */
type ClientRef = { id: string; name: string; host: string | null };
type Client = ClientRef & { redirectUris: readonly RedirectUri[] };

/**
 * Where a connection came from, which decides how the key leaves. `oauth`: at /token for the authorization code.
 * `link`: at the agent's poll.
 */
type Origin =
  | {
      readonly kind: 'oauth';
      readonly client: ClientRef;
      /** Shown to the phone as clientHost; see WireConnect. */
      readonly verifiedHost: string | null;
      readonly codeChallenge: string;
      /** Exactly as the client sent it; the token request must repeat it byte for byte. */
      readonly redirectUri: RedirectUri;
      readonly state: string | null;
    }
  | {
      readonly kind: 'link';
      /** Chosen by the agent, cleaned like a client name. Nothing verifies it. */
      readonly name: string;
      /** When the next poll may start; earlier, or while one waits, gets slow_down. */
      nextPollAt: number;
      polling: boolean;
      /** Where the outcome is POSTed, signed with the poll token. Null once sent, so it fires at most once. */
      callback: CallbackUrl | null;
    };
type OAuthOrigin = Extract<Origin, { kind: 'oauth' }>;
type OAuthConnection = Connection & { readonly origin: OAuthOrigin };
type LinkConnection = Connection & { readonly origin: Extract<Origin, { kind: 'link' }> };

/**
 * The key exists only while the phase can still hand it out, so it cannot outlive the connection's use.
 * awaitingPhone -> confirmed (the link secret matched) -> approved (the registry holds the digest) -> ended. A link
 * connection passes through collected: its key left, and a repeat poll within KEY_RECOLLECT_MS gets it again.
 * `abandoned` ends a confirmed or approved connection that never got redeemed: the phone may hold its agent.
 * A redeemed OAuth connection keeps its authorization code's hash, so a second presentation of the code can revoke the
 * session it bought. A link connection never has an authorization code: approved, its key leaves at the agent's next
 * poll. An OAuth connection's key never leaves; its digest names the session's agent.
 */
type Phase =
  | { kind: 'awaitingPhone'; key: AgentKey; attemptsLeft: number }
  | { kind: 'confirmed'; key: AgentKey }
  | { kind: 'approved'; key: AgentKey; code: { value: string; hash: string; expiresAt: number } | null }
  | { kind: 'collected'; key: AgentKey; at: number }
  | { kind: 'ended'; outcome: 'redeemed'; at: number; codeHash: string | null }
  | { kind: 'ended'; outcome: 'declined' | 'expired' | 'abandoned'; at: number };

type ConnectEvent = 'connect.approved' | 'connect.declined' | 'connect.expired';

/** The outcome a link connection's callback announces, once its phase reaches one the agent acts on. */
function connectEvent(phase: Phase): ConnectEvent | null {
  if (phase.kind === 'approved') return 'connect.approved';
  if (phase.kind !== 'ended') return null;
  switch (phase.outcome) {
    case 'declined':
      return 'connect.declined';
    case 'expired':
    case 'abandoned':
      return 'connect.expired';
    case 'redeemed':
      return null;
  }
}

/** The phone should remove this connection's agent, and /mcp refuses its key. */
const revokes = (phase: Phase) => phase.kind === 'ended' && phase.outcome === 'abandoned';

type Connection = {
  readonly id: ConnectId;
  /** The OAuth page's or the agent's handle on this connection. Never sent to the phone. */
  readonly pollToken: string;
  /** callerKey of whoever opened /authorize or POST /v1/connect. */
  readonly caller: string;
  readonly origin: Origin;
  /**
   * The path of the approve URL, /c/<secret>. Only the OAuth page and the user's messages carry it, so presenting it
   * proves Puffer was opened through the link.
   */
  readonly linkSecret: string;
  readonly keyDigest: KeyDigest;
  readonly requestedAt: number;
  readonly expiresAt: number;
  /** The tenant whose phone presented the link secret. Set from `confirmed` on; only its registry approves the key. */
  claimedBy: TenantId | null;
  phase: Phase;
};

export type AuthServerOptions = {
  /** The relay's public base, no trailing slash. A function because the port is known only after listen. */
  issuer: () => string;
  clientsPath: string;
  /** OAuth sessions and the key that signs their access tokens (sessions.ts). */
  sessionsPath: string;
  sessionKeyPath: string;
  connectTtlMs: number;
  /** --dev-callbacks: a metadata document may be served over http, and from a loopback address. */
  allowLoopback: boolean;
  /** Whether this tenant's registry holds an agent with this digest. */
  knowsKey: (tenant: TenantId, digest: KeyDigest) => boolean;
};

const isWaiting = (connection: Connection) => connection.phase.kind === 'awaitingPhone' || connection.phase.kind === 'confirmed';

export class AuthServer {
  private readonly clients: Map<ClientId, DcrClient>;
  private readonly sessions: Sessions;
  private readonly connections = new Map<ConnectId, Connection>();
  /** Keyed by callerKey. Only an /authorize whose client and redirect_uri check out counts toward `authorize`. */
  private readonly limits = {
    register: new RateLimit<string>(10, 60 * 60_000),
    authorize: new RateLimit<string>(10, 60_000),
    document: new RateLimit<string>(20, 60_000),
  };
  /** Waiting link polls, woken whenever a connection leaves the waiting phases. */
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: AuthServerOptions) {
    this.clients = loadClients(options.clientsPath);
    this.sessions = new Sessions({ path: options.sessionsPath, keyPath: options.sessionKeyPath, knowsKey: options.knowsKey });
  }

  /** What the SDK's well-known handlers serve: RFC 9728 resource metadata and RFC 8414 server metadata. */
  metadata(): AuthMetadataOptions {
    const issuer = this.options.issuer();
    return {
      oauthMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      },
      resourceServerUrl: new URL(`${issuer}/mcp`),
      resourceName: 'Puffer',
    };
  }

  /** POST /register (RFC 7591). Public clients only: whatever auth method was asked for, the answer is `none`. */
  register(body: string, caller: string): Response {
    if (!this.limits.register.take(caller)) return oauthError(429, 'too_many_requests', 'Too many registrations. Try again in an hour.');
    const request = RegistrationRequest.safeParse(parseJson(body));
    if (!request.success) return oauthError(400, 'invalid_client_metadata', 'The body must be a JSON object with an optional string client_name.');
    const redirectUris = RedirectUris.safeParse(request.data.redirect_uris);
    if (!redirectUris.success) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must hold 1 to 10 URIs, each https or http on localhost, without a fragment or userinfo.');
    }
    const now = Date.now();
    const client: DcrClient = {
      clientId: ClientId.parse(`cl_${randomBytes(16).toString('base64url')}`),
      name: displayName(request.data.client_name, redirectUris.data[0]),
      redirectUris: redirectUris.data,
      registeredAt: wireTime(now),
      lastUsedAt: new Date(now).toISOString(),
    };
    this.clients.set(client.clientId, client);
    if (this.clients.size > MAX_CLIENTS) {
      const stalest = [...this.clients.values()].reduce((a, b) => (Date.parse(b.lastUsedAt) < Date.parse(a.lastUsedAt) ? b : a));
      this.clients.delete(stalest.clientId);
    }
    this.saveClients();
    return json(201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  /**
   * GET /authorize. Every refusal is a page, never a redirect: anyone can register a client with any https redirect,
   * so a redirect from here would be an open redirect on the relay's domain. Success creates a connection and renders
   * the page; from then on the page's poll carries outcomes back to the client.
   */
  async authorize(query: URLSearchParams, caller: string): Promise<Response> {
    const params = singleValued(query);
    if (!params) return errorPage(400, 'A parameter appears more than once.');
    const client = await this.resolveClient(params.client_id, caller);
    if (typeof client === 'string') return errorPage(400, client);
    const redirectUri = registeredRedirect(client.redirectUris, params.redirect_uri);
    if (!redirectUri) return errorPage(400, `This redirect_uri is not registered for ${client.name}.`);
    if (!this.limits.authorize.take(caller)) return errorPage(429, 'Too many connection attempts. Try again in a minute.');
    this.touchClient(client.id);

    const state = params.state ?? null;
    if (state !== null && state.length > 2048) return errorPage(400, 'state is longer than 2048 characters.');
    if (params.response_type !== 'code') return errorPage(400, 'Only response_type=code is supported.');
    if (params.code_challenge_method !== 'S256') return errorPage(400, 'PKCE with code_challenge_method=S256 is required.');
    const codeChallenge = params.code_challenge ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return errorPage(400, 'code_challenge must be a base64url SHA-256.');
    if (params.resource !== undefined && !this.isThisResource(params.resource)) {
      return errorPage(400, `resource must be ${this.options.issuer()}/mcp.`);
    }
    const crowded = this.crowded(caller);
    if (crowded === 'caller') {
      return errorPage(429, 'Too many connection requests from your network are waiting for Puffer. Approve or decline them in Puffer first.');
    }
    if (crowded === 'total') return errorPage(503, 'Too many connection requests are waiting for Puffer. Try again later.');
    const connection = this.open(caller, {
      kind: 'oauth',
      client: { id: client.id, name: client.name, host: client.host },
      verifiedHost: LOOPBACK_HOSTS.has(new URL(redirectUri).hostname) ? null : client.host,
      codeChallenge,
      redirectUri,
      state,
    });
    const approveUrl = this.approveUrl(connection);
    const qr = await QRCode.toString(approveUrl, { type: 'svg', margin: 2, width: 240, errorCorrectionLevel: 'M' });
    return connectPage(connection as OAuthConnection, qr);
  }

  /**
   * POST /v1/connect, for an agent that cannot do OAuth. Nothing reaches the user until the agent sends them
   * approve_url.
   */
  linkConnect(body: string, caller: string): Response {
    const request = LinkRequest.safeParse(parseJson(body));
    const name = request.success ? cleanName(request.data.name) : '';
    const length = Array.from(name).length;
    if (length < 1 || length > LINK_NAME_MAX) {
      return apiError(400, 'invalid_request', `The body must be {"name": "..."}, a name of 1 to ${LINK_NAME_MAX} characters.`);
    }
    const rawCallback = request.data?.callback_url;
    const callback = rawCallback === undefined ? null : parseCallbackUrl(rawCallback, this.options.allowLoopback);
    if (rawCallback !== undefined && !callback) return apiError(400, 'invalid_request', 'callback_url must be an https URL.');
    const crowded = this.crowded(caller);
    if (crowded === 'caller') {
      return apiError(429, 'too_many_requests', 'Three connection requests from your network are already waiting for the user. Try again once they are answered or expired.');
    }
    if (crowded === 'total') return apiError(503, 'too_many_requests', 'Too many connection requests are waiting for Puffer. Try again later.');
    const connection = this.open(caller, { kind: 'link', name, nextPollAt: 0, polling: false, callback });
    return json(200, {
      connect_id: connection.id,
      approve_url: this.approveUrl(connection),
      poll_token: connection.pollToken,
      expires_in: Math.round((connection.expiresAt - connection.requestedAt) / 1000),
      interval: LINK_INTERVAL_S,
    });
  }

  /** GET /c/<secret>: the connection this approve link opens in Puffer, while it still waits for the phone. */
  linkTarget(secret: string): ConnectId | null {
    this.sweep();
    for (const connection of this.connections.values()) {
      if (isWaiting(connection) && sameSecret(connection.linkSecret, secret)) return connection.id;
    }
    return null;
  }

  private approveUrl(connection: Connection): string {
    return `${this.options.issuer()}/c/${connection.linkSecret}`;
  }

  /**
   * POST /v1/connect/<id>/token with the poll token as Bearer (RFC 8628 error names). `wait` holds a pending poll up to
   * `budgetMs`. The key leaves exactly once; the connection then ends redeemed and the relay keeps no copy.
   */
  async linkToken(id: string, authorization: string | undefined, body: string, budgetMs: number, signal: AbortSignal): Promise<Response> {
    const pollToken = bearerToken(authorization);
    if (!pollToken) return apiError(401, 'invalid_client', 'Send the poll_token from POST /v1/connect as Authorization: Bearer <poll_token>.');
    const poll = LinkPoll.safeParse(body.trim() ? parseJson(body) : {});
    if (!poll.success) return apiError(400, 'invalid_request', `The body must be empty or {"wait": <seconds, 0 to ${LINK_WAIT_MAX_S}>}.`);
    this.sweep();
    const connection = this.connections.get(id as ConnectId);
    if (!connection || connection.origin.kind !== 'link' || !sameSecret(connection.pollToken, pollToken)) {
      return apiError(400, 'expired_token', 'This connection request is unknown or over. Start again with POST /v1/connect if the user still wants to connect.');
    }
    const link = connection as LinkConnection;
    if (isWaiting(link)) {
      const startedAt = Date.now();
      if (link.origin.polling || startedAt < link.origin.nextPollAt) {
        return apiError(400, 'slow_down', `Poll at most every ${LINK_INTERVAL_S} seconds, or pass "wait" so the relay holds the poll.`);
      }
      link.origin.polling = true;
      link.origin.nextPollAt = startedAt + Math.min(LINK_INTERVAL_S * 1000, budgetMs);
      try {
        await this.whileWaiting(link, Math.min(poll.data.wait * 1000, budgetMs), signal);
      } finally {
        link.origin.polling = false;
      }
      this.sweep();
    }
    // The reply would go nowhere, so nothing is collected for a caller that left.
    if (signal.aborted) return apiError(400, 'authorization_pending', 'The request ended before the relay answered.');
    return this.collect(link);
  }

  /** What a link poll gets for the connection's phase now. */
  private collect(connection: LinkConnection): Response {
    const { phase } = connection;
    switch (phase.kind) {
      case 'awaitingPhone':
      case 'confirmed':
        return apiError(400, 'authorization_pending', 'The user has not approved in Puffer yet. Poll again.');
      case 'approved':
      case 'collected': {
        if (!this.held(connection)) {
          connection.phase = { kind: 'ended', outcome: 'declined', at: Date.now() };
          return apiError(400, 'access_denied', 'The user removed this agent in Puffer.');
        }
        if (phase.kind === 'approved') connection.phase = { kind: 'collected', key: phase.key, at: Date.now() };
        const base = this.options.issuer();
        return json(200, { key: phase.key, base_url: `${base}/v1`, openapi_url: `${base}/openapi.json` });
      }
      case 'ended':
        return phase.outcome === 'declined'
          ? apiError(400, 'access_denied', 'The user declined in Puffer. Do not ask again unless the user asks you to.')
          : apiError(400, 'expired_token', 'This connection request is over. Start again with POST /v1/connect if the user still wants to connect.');
    }
  }

  /** Resolves once the connection leaves the waiting phases, the wait or the connection runs out, or the caller leaves. */
  private whileWaiting(connection: Connection, waitMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Math.min(waitMs, connection.expiresAt - Date.now());
    if (deadline <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal.removeEventListener('abort', finish);
        done();
      };
      const check = () => {
        if (!isWaiting(connection)) finish();
      };
      const timer = setTimeout(finish, deadline);
      this.waiters.add(check);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  /** Every phase change out of the waiting phases ends here: callbacks go out, then waiting polls wake. */
  private moved(): void {
    this.announce();
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * POSTs each link callback whose connection reached an outcome, Standard Webhooks style with the poll token as the
   * key. Never the key itself; on connect.approved the agent collects it at the token endpoint. A failed callback
   * changes nothing: polling still works.
   */
  private announce(): void {
    for (const { id, origin, phase, pollToken } of this.connections.values()) {
      if (origin.kind !== 'link' || !origin.callback) continue;
      const event = connectEvent(phase);
      if (!event) continue;
      const url = origin.callback;
      origin.callback = null;
      const webhookId = `msg_${id}_${event}`;
      const body = JSON.stringify({ event, connect_id: id, timestamp: wireTime(Date.now()) });
      void deliverEvent(
        { url, body, headers: () => signed(Buffer.from(pollToken), webhookId, body), label: `connect callback for ${id}` },
        this.options.allowLoopback,
      );
    }
  }

  /** Which limit a new connection from this caller would break: its own 3 waiting, or the 100 overall. */
  private crowded(caller: string): 'caller' | 'total' | null {
    this.sweep();
    const waiting = [...this.connections.values()].filter(isWaiting);
    if (waiting.filter((c) => c.caller === caller).length >= MAX_WAITING.perCaller) return 'caller';
    return waiting.length >= MAX_WAITING.total ? 'total' : null;
  }

  /** Mints the key the connection will hand out. No phone hears of it until one is opened through its link. */
  private open(caller: string, origin: Origin): Connection {
    const key: AgentKey = `ak_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const connection: Connection = {
      id: ConnectId.parse(`cn_${randomBytes(12).toString('base64url')}`),
      pollToken: randomBytes(24).toString('base64url'),
      caller,
      origin,
      linkSecret: randomBytes(24).toString('base64url'),
      keyDigest: digestKey(key),
      requestedAt: now,
      expiresAt: now + this.options.connectTtlMs,
      claimedBy: null,
      phase: { kind: 'awaitingPhone', key, attemptsLeft: MAX_LINK_ATTEMPTS },
    };
    this.connections.set(connection.id, connection);
    return connection;
  }

  /** GET /authorize/poll/<pollToken>. The code is minted at the first poll that sees the approval, so its clock starts when the browser can use it. */
  poll(pollToken: string): Response {
    this.sweep();
    const connection = [...this.connections.values()].find((c): c is OAuthConnection => c.origin.kind === 'oauth' && c.pollToken === pollToken);
    if (!connection) return json(404, { status: 'gone' });
    const { phase } = connection;
    switch (phase.kind) {
      case 'awaitingPhone':
      case 'confirmed':
        return json(200, { status: 'waiting' });
      case 'approved': {
        const code = phase.code ?? mintCode();
        connection.phase = { ...phase, code };
        return json(200, { status: 'approved', redirect: this.callback(connection, { code: code.value }) });
      }
      case 'collected':
        return json(200, { status: 'redeemed' });
      case 'ended':
        switch (phase.outcome) {
          case 'redeemed':
            return json(200, { status: 'redeemed' });
          case 'declined':
            return json(200, {
              status: 'declined',
              redirect: this.callback(connection, { error: 'access_denied', error_description: 'The user declined in Puffer.' }),
            });
          case 'expired':
          case 'abandoned':
            return json(200, {
              status: 'expired',
              redirect: this.callback(connection, {
                error: 'access_denied',
                error_description: 'The request expired before the user approved it in Puffer.',
              }),
            });
        }
    }
  }

  /** POST /token: authorization_code, or refresh_token for the session a code bought. Public clients, no secret. */
  token(contentType: string | undefined, body: string): Response {
    if (!/^application\/x-www-form-urlencoded\b/i.test(contentType ?? '')) {
      return oauthError(400, 'invalid_request', 'The body must be application/x-www-form-urlencoded.');
    }
    const form = singleValued(new URLSearchParams(body));
    if (!form) return oauthError(400, 'invalid_request', 'A parameter appears more than once.');
    switch (form.grant_type) {
      case undefined:
        return oauthError(400, 'invalid_request', 'grant_type is missing.');
      case 'authorization_code':
        return this.redeem(form);
      case 'refresh_token': {
        const { refresh_token: refreshToken, client_id: clientId } = form;
        if (!refreshToken || !clientId) return oauthError(400, 'invalid_request', 'refresh_token and client_id are required.');
        if (form.resource !== undefined && !this.isThisResource(form.resource)) return this.invalidTarget();
        this.sweep();
        const reply = this.sessions.refresh(refreshToken, clientId);
        return typeof reply === 'string' ? oauthError(400, 'invalid_grant', reply) : json(200, reply, { pragma: 'no-cache' });
      }
      default:
        return oauthError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
    }
  }

  /**
   * A wrong verifier leaves the code usable; success ends the connection, drops the key and starts a session. A code
   * presented after it was redeemed revokes that session (OAuth 2.1 section 4.1.3).
   */
  private redeem(form: Partial<Record<string, string>>): Response {
    const { code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier } = form;
    if (!code || !clientId || !redirectUri || !verifier) {
      return oauthError(400, 'invalid_request', 'code, client_id, redirect_uri and code_verifier are required.');
    }
    this.sweep();
    const presented = s256(code);
    const invalidGrant = (description: string) => oauthError(400, 'invalid_grant', description);
    for (const { phase, keyDigest } of this.connections.values()) {
      if (phase.kind === 'ended' && phase.outcome === 'redeemed' && phase.codeHash === presented) {
        this.sessions.revokeAgent(keyDigest);
        return invalidGrant('The code is unknown, used or expired.');
      }
    }
    if (!this.isKnownClient(clientId)) return oauthError(400, 'invalid_client', 'This client is not registered.');
    const connection = [...this.connections.values()].find((c) => c.phase.kind === 'approved' && c.phase.code?.hash === presented);
    if (!connection || connection.phase.kind !== 'approved' || connection.origin.kind !== 'oauth') return invalidGrant('The code is unknown, used or expired.');
    const { origin } = connection;
    if (origin.client.id !== clientId || origin.redirectUri !== redirectUri) {
      return invalidGrant('client_id or redirect_uri differs from the authorization request.');
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== origin.codeChallenge) {
      return invalidGrant('code_verifier does not match the code_challenge.');
    }
    if (form.resource !== undefined && !this.isThisResource(form.resource)) return this.invalidTarget();
    const tenant = connection.claimedBy;
    if (tenant === null || !this.options.knowsKey(tenant, connection.keyDigest)) return invalidGrant('The agent was removed in Puffer.');
    connection.phase = { kind: 'ended', outcome: 'redeemed', at: Date.now(), codeHash: presented };
    return json(200, this.sessions.start({ clientId, tenant, agent: connection.keyDigest }), { pragma: 'no-cache' });
  }

  /**
   * Ids the user declined on this tenant's phone. Only a connection still waiting, and unclaimed or claimed by this
   * tenant, ends; any other id is ignored.
   */
  decline(tenant: TenantId, ids: readonly ConnectId[]): void {
    this.sweep();
    for (const id of ids) {
      const connection = this.connections.get(id);
      if (!connection || !isWaiting(connection) || (connection.claimedBy !== null && connection.claimedBy !== tenant)) continue;
      connection.phase = { kind: 'ended', outcome: 'declined', at: Date.now() };
    }
    this.moved();
  }

  /**
   * The phone's proof that the user saw this request: the secret of the link Puffer was opened with. A match claims the
   * connection for the tenant. Another tenant's connection reads as gone. The third wrong secret declines.
   */
  confirm(tenant: TenantId, id: ConnectId, linkSecret: string): ConfirmReply {
    this.sweep();
    const connection = this.connections.get(id);
    const { phase } = connection ?? {};
    if (!connection || !phase || phase.kind === 'ended') return { status: 'gone' };
    if (connection.claimedBy !== null && connection.claimedBy !== tenant) return { status: 'gone' };
    const matches = sameSecret(linkSecret, connection.linkSecret);
    if (phase.kind !== 'awaitingPhone') return matches ? { status: 'confirmed' } : { status: 'gone' };
    if (matches) {
      connection.claimedBy = tenant;
      connection.phase = { kind: 'confirmed', key: phase.key };
      this.approve();
      return { status: 'confirmed' };
    }
    if (phase.attemptsLeft <= 1) {
      connection.phase = { kind: 'ended', outcome: 'declined', at: Date.now() };
      this.moved();
      return { status: 'declined' };
    }
    connection.phase = { ...phase, attemptsLeft: phase.attemptsLeft - 1 };
    return { status: 'wrongCode', attemptsLeft: phase.attemptsLeft - 1 };
  }

  /**
   * Approval is a confirmed link plus the claiming tenant's registry holding the digest, so an authorization code never
   * exists before the relay knows the key. A digest in a registry without a confirmed link approves nothing.
   */
  approve(): void {
    this.sweep();
    let approved = false;
    for (const connection of this.connections.values()) {
      const { phase } = connection;
      if (phase.kind === 'confirmed' && this.held(connection)) {
        connection.phase = { kind: 'approved', key: phase.key, code: null };
        approved = true;
      }
    }
    if (approved) this.moved();
  }

  /**
   * GET /v1/device/connects/by-link/<secret>: the record a phone opened through this link needs for its approval screen,
   * while the connection waits and no other tenant claimed it. The only way a phone learns of a connection.
   */
  byLink(tenant: TenantId, secret: string): WireConnect | null {
    this.sweep();
    const connection = [...this.connections.values()].find((c) => isWaiting(c) && sameSecret(c.linkSecret, secret));
    if (!connection || (connection.claimedBy !== null && connection.claimedBy !== tenant)) return null;
    const { origin } = connection;
    const listed = {
      id: connection.id,
      keyDigest: connection.keyDigest,
      requestedAt: wireTime(connection.requestedAt),
      expiresAt: wireTime(connection.expiresAt),
    };
    return origin.kind === 'oauth'
      ? { ...listed, origin: 'oauth', clientName: origin.client.name, clientHost: origin.verifiedHost, redirectHost: new URL(origin.redirectUri).hostname }
      : { ...listed, origin: 'link', clientName: origin.name };
  }

  /** Digests this tenant's phone should remove, on every sync response while its registry still holds them. */
  revokedKeys(tenant: TenantId): KeyDigest[] {
    this.sweep();
    const digests = [
      ...[...this.connections.values()].filter((c) => c.claimedBy === tenant && revokes(c.phase)).map((c) => c.keyDigest),
      ...this.sessions.revokedAgents(tenant),
    ];
    return [...new Set(digests.filter((digest) => this.options.knowsKey(tenant, digest)))];
  }

  /**
   * The one check behind /mcp and /v1, before the registry is asked: the agent a bearer credential names. An ak_ key
   * names it by digest; an at_ access token by its signed claim, which also names the tenant. Null for anything else,
   * an expired token, or an agent revoked here, from the moment it is revoked, before the phone hears of it.
   */
  claim(authorization: string | undefined): AgentClaim | null {
    const token = bearerToken(authorization) ?? '';
    const claim = token.startsWith('ak_') ? { tenant: null, agent: digestKey(token) } : this.sessions.verify(token);
    return claim && !this.isRevoked(claim.agent) ? claim : null;
  }

  private isRevoked(digest: KeyDigest): boolean {
    this.sweep();
    for (const connection of this.connections.values()) if (connection.keyDigest === digest && revokes(connection.phase)) return true;
    return this.sessions.isRevoked(digest);
  }

  /** Expires open connections, and forgets ended ones once the page has had time to read the outcome. */
  sweep(): void {
    this.sessions.sweep();
    const now = Date.now();
    let ended = false;
    for (const [id, connection] of this.connections) {
      const { phase } = connection;
      if (phase.kind === 'ended') {
        if (now - phase.at >= (revokes(phase) ? REVOKED_RETENTION_MS : ENDED_RETENTION_MS)) this.connections.delete(id);
        continue;
      }
      if (phase.kind === 'collected') {
        if (now - phase.at >= KEY_RECOLLECT_MS) connection.phase = { kind: 'ended', outcome: 'redeemed', at: phase.at, codeHash: null };
        continue;
      }
      // A minted code keeps its own 60 s, even past the connection's deadline.
      const deadline = phase.kind === 'approved' && phase.code ? phase.code.expiresAt : connection.expiresAt;
      if (now >= deadline) {
        connection.phase = { kind: 'ended', outcome: phase.kind === 'awaitingPhone' ? 'expired' : 'abandoned', at: now };
        ended = true;
      }
    }
    if (ended) this.moved();
  }

  /** A `cl_` id this relay registered, or a metadata document URL, fetched now; no caching. Returns why on failure. */
  private async resolveClient(raw: string | undefined, caller: string): Promise<Client | string> {
    if (raw === undefined) return 'client_id is missing.';
    const registered = ClientId.safeParse(raw);
    if (registered.success) {
      const client = this.clients.get(registered.data);
      return client ? { id: client.clientId, name: client.name, host: null, redirectUris: client.redirectUris } : 'This client is not registered with Puffer.';
    }
    const url = metadataDocumentUrl(raw, this.options.allowLoopback);
    if (!url) return 'This client is not registered with Puffer.';
    if (!this.limits.document.take(caller)) return 'Too many connection attempts. Try again in a minute.';
    return fetchClientMetadata(url, this.options.allowLoopback);
  }

  private touchClient(id: string): void {
    const client = this.clients.get(id as ClientId);
    if (!client) return;
    client.lastUsedAt = new Date().toISOString();
    this.saveClients();
  }

  private saveClients(): void {
    writeStateFile(this.options.clientsPath, { clients: [...this.clients.values()] });
  }

  private isKnownClient(raw: string): boolean {
    const registered = ClientId.safeParse(raw);
    return registered.success ? this.clients.has(registered.data) : metadataDocumentUrl(raw, this.options.allowLoopback) !== null;
  }

  /** RFC 8707: the relay's own /mcp. URL parsing lowercases scheme and host; one trailing slash is ignored. */
  private isThisResource(raw: string): boolean {
    const url = !raw.includes('#') && URL.canParse(raw) ? new URL(raw) : null;
    if (!url || url.search || url.username || url.password) return false;
    const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    return `${url.origin}${path}` === `${this.options.issuer()}/mcp`;
  }

  private invalidTarget(): Response {
    return oauthError(400, 'invalid_target', `resource must be ${this.options.issuer()}/mcp.`);
  }

  /** The claiming tenant's registry holds this connection's key. */
  private held(connection: Connection): boolean {
    return connection.claimedBy !== null && this.options.knowsKey(connection.claimedBy, connection.keyDigest);
  }

  private callback({ origin }: OAuthConnection, params: Record<string, string>): string {
    return withQuery(origin.redirectUri, { ...params, state: origin.state, iss: this.options.issuer() });
  }
}

function loadClients(path: string): Map<ClientId, DcrClient> {
  if (!existsSync(path)) return new Map();
  const file = ClientsFile.parse(JSON.parse(readFileSync(path, 'utf8')));
  return new Map(file.clients.map((client) => [client.clientId, client]));
}

function bearerToken(authorization: string | undefined): string | null {
  return /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1] ?? null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** OAuth forbids repeating a parameter; null when one repeats. */
function singleValued(params: URLSearchParams): Partial<Record<string, string>> | null {
  const values: Partial<Record<string, string>> = {};
  for (const [name, value] of params) {
    if (Object.hasOwn(values, name)) return null;
    values[name] = value;
  }
  return values;
}

/**
 * Control and format characters (bidi overrides among them), line and paragraph separators, whitespace runs and
 * stacked combining marks could disguise a name or fake a second line on the page and the phone.
 */
function cleanName(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .trim();
}

function displayName(raw: string | undefined, fallback: RedirectUri): string {
  return Array.from(cleanName(raw ?? '')).slice(0, 100).join('').trim() || new URL(fallback).hostname;
}

/** Constant time whatever the lengths: both sides are hashed first. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Exact match, except that an http loopback redirect may use any port (RFC 8252 section 7.3). Returns the URI as presented. */
function registeredRedirect(registered: readonly RedirectUri[], raw: string | undefined): RedirectUri | null {
  const presented = RedirectUri.safeParse(raw);
  if (!presented.success) return null;
  const portless = (uri: string) => {
    const url = new URL(uri);
    url.port = '';
    return url.href;
  };
  const matches = (uri: RedirectUri) =>
    uri === presented.data || (new URL(uri).protocol === 'http:' && portless(uri) === portless(presented.data));
  return registered.some(matches) ? presented.data : null;
}

/** A client_id that names its own metadata document: https with a path, or http on this machine with --dev-callbacks. */
function metadataDocumentUrl(raw: string, allowLoopbackHttp: boolean): URL | null {
  const url = raw.length <= 2048 && !raw.includes('#') && URL.canParse(raw) ? new URL(raw) : null;
  if (!url || url.href !== raw || url.username || url.password || url.pathname === '/') return null;
  const allowed = url.protocol === 'https:' || (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  return allowed ? url : null;
}

/**
 * Public addresses only (egress.ts), no redirects, 5 s, 5 KB. One message for every way the fetch can fail, so the
 * page cannot tell anyone which hosts answer; the relay logs the specific reason.
 */
async function fetchClientMetadata(url: URL, allowLoopback: boolean): Promise<Client | string> {
  const exchange = { method: 'GET', headers: { accept: 'application/json' }, ...METADATA_DOCUMENT } as const;
  const reply = await send(url, exchange, allowLoopback);
  if (reply.kind === 'failed' || reply.status < 200 || reply.status >= 300) {
    console.warn(`oauth: the metadata document at ${url.hostname} could not be fetched: ${reply.kind === 'failed' ? reply.why : `HTTP ${reply.status}`}`);
    return "The client's metadata document could not be fetched.";
  }
  const document = MetadataDocument.safeParse(parseJson(reply.body));
  if (!document.success) return "The client's metadata document lacks client_id, client_name or redirect_uris.";
  if (document.data.client_id !== url.href) return "The client's metadata document names a different client_id.";
  const method = document.data.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') return `Puffer supports public clients only, not ${method}.`;
  const redirectUris = RedirectUris.safeParse(document.data.redirect_uris);
  if (!redirectUris.success) return "The client's metadata document lists a redirect URI that is not https or localhost.";
  const name = displayName(document.data.client_name, redirectUris.data[0]);
  return { id: url.href, name, host: url.hostname, redirectUris: redirectUris.data };
}

function mintCode(): { value: string; hash: string; expiresAt: number } {
  const value = randomBytes(32).toString('base64url');
  return { value, hash: s256(value), expiresAt: Date.now() + CODE_TTL_MS };
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function withQuery(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) if (value !== null) url.searchParams.set(name, value);
  return url.href;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function oauthError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

/** The /v1 error shape, {error, message}, which the HTTP API uses too. */
function apiError(status: number, error: string, message: string): Response {
  return json(status, { error, message });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; padding: 48px 16px; line-height: 1.45; }
main { max-width: 420px; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
.client { margin: 0 0 24px; opacity: .75; }
.qr { margin: 8px 0 4px; line-height: 0; }
.qr svg { width: 240px; height: 240px; border-radius: 8px; }
.small { font-size: .9rem; opacity: .75; }
#status { margin-top: 28px; font-weight: 600; }`;

/** Strict CSP: inline style and script by nonce only, fetch to this origin only, no framing, no forms. */
function htmlPage(status: number, title: string, main: string, script: string | null): Response {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style></head>` +
    `<body><main>${main}</main>${script === null ? '' : `<script nonce="${nonce}">${script}</script>`}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

function errorPage(status: number, message: string): Response {
  return htmlPage(status, 'Puffer', `<h1>Puffer cannot connect this app</h1><p>${escapeHtml(message)}</p>`, null);
}

/**
 * Names the client and shows the approve URL as a QR code (`qr`, SVG markup from the qrcode library, inline so the CSP
 * holds) and as a link into Puffer for a page open on the iPhone itself. Never shows library content.
 */
function connectPage(connection: OAuthConnection, qr: string): Response {
  const { origin } = connection;
  const verified = origin.verifiedHost === null ? '' : ` <span class="small">(${escapeHtml(origin.verifiedHost)})</span>`;
  const openInPuffer = `puffer://connect/${connection.id}?link=${connection.linkSecret}`;
  const main =
    `<h1>Approve in Puffer</h1>` +
    `<p class="client">${escapeHtml(origin.client.name)}${verified} wants to use your Puffer library.</p>` +
    `<div class="qr">${qr}</div>` +
    `<p>Scan with the iPhone that has Puffer, then approve there.</p>` +
    `<p class="small">On that iPhone already? <a href="${escapeHtml(openInPuffer)}">Open in Puffer</a></p>` +
    `<p class="small">Returns to ${escapeHtml(new URL(origin.redirectUri).hostname)}</p>` +
    `<p id="status" role="status">Waiting for approval in Puffer…</p>`;
  const pollUrl = JSON.stringify(`/authorize/poll/${connection.pollToken}`).replace(/</g, '\\u003c');
  const script = `
const said = {
  approved: 'Approved. Returning to the app…',
  declined: 'Declined in Puffer. Returning to the app…',
  expired: 'This request expired. Returning to the app…',
  redeemed: 'Connected. You can close this tab.',
  gone: 'Puffer no longer knows this request. Start again from the app.',
};
const status = document.getElementById('status');
async function tick() {
  let reply = null;
  try { reply = await (await fetch(${pollUrl}, { cache: 'no-store' })).json(); } catch {}
  if (reply && Object.hasOwn(said, reply.status)) {
    status.textContent = said[reply.status];
    if (typeof reply.redirect === 'string') location.replace(reply.redirect);
    return;
  }
  setTimeout(tick, ${POLL_EVERY_MS});
}
setTimeout(tick, ${POLL_EVERY_MS});`;
  return htmlPage(200, 'Connect to Puffer', main, script);
}
