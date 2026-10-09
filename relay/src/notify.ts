// Content-free pings when an agent's change head advances, the Gmail way: the agent then calls
// get_puffer_changes. Two kinds of sink: MCP Events webhook subscriptions (experimental triggers-events
// extension) and the per-agent webhook the user set on the phone. Memory only: after a restart the phone
// re-sends heads and its registry, and subscribers refresh.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ProtocolError } from '@modelcontextprotocol/server';

import { send, type EgressFailure } from './egress';
import {
  PUFFER_CHANGES,
  parseCallbackUrl,
  wireTime,
  type AgentId,
  type CallbackUrl,
  type ChangeHead,
  type EventsSubscribeParams,
  type EventsUnsubscribeParams,
} from './protocol';

type SubscriptionId = `sub_${string}`;

/** `notified` is the head this sink last heard. Null until the agent's head is known: it then becomes the baseline, unsent. */
export type Sink =
  | { kind: 'mcpEvents'; id: SubscriptionId; agentId: AgentId; url: CallbackUrl; secret: Buffer; refreshBefore: number; notified: number | null }
  | { kind: 'webhook'; agentId: AgentId; url: CallbackUrl; token: string | null; notified: number | null };
type Subscription = Extract<Sink, { kind: 'mcpEvents' }>;
type Webhook = Extract<Sink, { kind: 'webhook' }>;

export type NotifyConfig = { url: string; token: string | null };

export type NotifierOptions = {
  debounceMs: number; // a burst of head advances within this window sends one event with the last head
  allowLoopback: boolean; // --dev-callbacks: http and loopback addresses on this machine
};

// limit mirrors the SDK's own subscription limit error.
export const EVENTS_ERROR = { invalidParams: -32602, notFound: -32011, unsupported: -32014, callbackEndpoint: -32015, limit: -32603 } as const;

const TTL = { defaultMs: 60 * 60_000, minMs: 60_000, maxMs: 24 * 60 * 60_000 };
const RETRY = { attempts: 5, firstDelayMs: 1_000, maxDelayMs: 30_000 };
const RECEIVER = { timeoutMs: 5_000, maxVerificationBytes: 4 * 1024 };
const MAX_SUBSCRIPTIONS_PER_AGENT = 5;

type CallbackFailure = EgressFailure | 'http_status' | 'challenge_failed';

export class Notifier {
  private readonly heads = new Map<AgentId, number>();
  private readonly subscriptions = new Map<SubscriptionId, Subscription>();
  private readonly webhooks = new Map<AgentId, Webhook>();
  private readonly pending = new Map<AgentId, NodeJS.Timeout>();

  constructor(private readonly options: NotifierOptions) {}

  /** The phone sends every head on every sync; only a head above what a sink heard sends anything. */
  recordHeads(heads: readonly ChangeHead[]): void {
    for (const { agentId, seq } of heads) {
      this.heads.set(agentId, seq);
      for (const sink of this.sinks(agentId)) sink.notified ??= seq;
      this.poke(agentId);
    }
  }

  /** Full replace from an accepted registry snapshot. An unchanged (agent, url) keeps its sink, so a re-sent snapshot does not re-fire. */
  setWebhooks(agents: readonly { id: AgentId; notify: NotifyConfig | null }[]): void {
    const previous = new Map(this.webhooks);
    this.webhooks.clear();
    for (const { id: agentId, notify } of agents) {
      if (!notify) continue;
      const url = parseCallbackUrl(notify.url, this.options.allowLoopback);
      if (!url) {
        console.warn(`notify: dropped the webhook of ${agentId}: the URL is not https (plain http needs --dev-callbacks and a loopback host)`);
        continue;
      }
      const kept = previous.get(agentId);
      const sink: Webhook =
        kept?.url === url ? kept : { kind: 'webhook', agentId, url, token: null, notified: this.heads.get(agentId) ?? null };
      sink.token = notify.token;
      this.webhooks.set(agentId, sink);
    }
  }

  /**
   * events/subscribe. A callback without a live subscription is verified first, then the subscription is upserted by
   * identity. Throws ProtocolError.
   */
  async subscribe(agentId: AgentId, params: EventsSubscribeParams) {
    const { url, secret, ttlMs, cursor } = parseSubscription(params, this.options.allowLoopback);
    const id = subscriptionId(agentId, url);
    this.sweep();
    if (!this.subscriptions.has(id)) {
      this.ensureRoom(agentId);
      await verify(agentId, url, secret, id, this.options.allowLoopback);
      this.sweep();
      if (!this.subscriptions.has(id)) this.ensureRoom(agentId);
    }
    const head = this.heads.get(agentId) ?? null;
    const existing = this.subscriptions.get(id);
    const sink: Subscription = existing ?? { kind: 'mcpEvents', id, agentId, url, secret, refreshBefore: 0, notified: null };
    // In place, so a delivery already retrying for this subscription signs with the new secret.
    Object.assign(sink, { secret, refreshBefore: Date.now() + ttlMs, notified: cursor ?? sink.notified ?? head });
    this.subscriptions.set(id, sink);
    this.poke(agentId);
    return {
      id,
      refreshBefore: new Date(sink.refreshBefore).toISOString(),
      cursor: params.cursor ?? (head === null ? null : String(head)),
      truncated: false,
    };
  }

  /** events/unsubscribe, resolved by the same identity as subscribe. */
  unsubscribe(agentId: AgentId, params: EventsUnsubscribeParams): Record<string, never> {
    const url = parseCallbackUrl(params.delivery.url, this.options.allowLoopback);
    const id = url && params.name === PUFFER_CHANGES && isEmpty(params.arguments) ? subscriptionId(agentId, url) : null;
    if (!id || !this.subscriptions.delete(id)) {
      throw new ProtocolError(EVENTS_ERROR.notFound, 'no such subscription', { kind: 'subscription' });
    }
    return {};
  }

  /** The phone dropped these agents: their heads and sinks go. */
  revoke(agentIds: readonly AgentId[]): void {
    for (const agentId of agentIds) {
      this.heads.delete(agentId);
      this.webhooks.delete(agentId);
      clearTimeout(this.pending.get(agentId));
      this.pending.delete(agentId);
      for (const [id, sink] of this.subscriptions) if (sink.agentId === agentId) this.subscriptions.delete(id);
    }
  }

  /** Subscriptions are soft state: one not refreshed by refreshBefore is gone. */
  sweep(): void {
    const now = Date.now();
    for (const [id, sink] of this.subscriptions) if (sink.refreshBefore <= now) this.subscriptions.delete(id);
  }

  private ensureRoom(agentId: AgentId): void {
    let count = 0;
    for (const sink of this.subscriptions.values()) if (sink.agentId === agentId) count++;
    if (count >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      fail(EVENTS_ERROR.limit, `Subscription limit reached: at most ${MAX_SUBSCRIPTIONS_PER_AGENT} per agent. Unsubscribe one first.`);
    }
  }

  private sinks(agentId: AgentId): Sink[] {
    this.sweep();
    const sinks: Sink[] = [...this.subscriptions.values()].filter((sink) => sink.agentId === agentId);
    const webhook = this.webhooks.get(agentId);
    return webhook ? [...sinks, webhook] : sinks;
  }

  /** The first advance opens the agent's window; when it closes, every sink behind gets the head as it is then. */
  private poke(agentId: AgentId): void {
    const head = this.heads.get(agentId);
    if (head === undefined || this.pending.has(agentId) || !this.sinks(agentId).some((sink) => behind(sink, head))) return;
    const timer = setTimeout(() => {
      this.pending.delete(agentId);
      const current = this.heads.get(agentId);
      if (current === undefined) return;
      for (const sink of this.sinks(agentId)) {
        if (!behind(sink, current)) continue;
        sink.notified = current;
        void this.deliver(sink, current);
      }
    }, this.options.debounceMs);
    this.pending.set(agentId, timer.unref());
  }

  private deliver(sink: Sink, head: number): Promise<void> {
    const eventId = `evt_${digest(`${sink.agentId}\n${head}`)}`;
    const body = JSON.stringify({ eventId, name: PUFFER_CHANGES, timestamp: wireTime(Date.now()), data: { head }, cursor: String(head) });
    return deliverEvent(
      {
        url: sink.url,
        body,
        headers: () => headersFor(sink, eventId, body),
        label: `${sink.kind} delivery for ${sink.agentId}`,
        live: () => this.sinks(sink.agentId).includes(sink),
      },
      this.options.allowLoopback,
    );
  }
}

/** One event body for one receiver. `headers` runs per attempt, so each retry carries a fresh signature. */
export type EventDelivery = { url: CallbackUrl; body: string; headers: () => Record<string, string>; label: string; live?: () => boolean };

/**
 * Retries reuse the body. 410, 413 and other 4xx end the delivery, and so does a refused address. Only the status is
 * read, never the body.
 */
export async function deliverEvent(delivery: EventDelivery, allowLoopback: boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (delivery.live && !delivery.live()) return;
    const reply = await post(delivery.url, delivery.headers(), delivery.body, 0, allowLoopback);
    if (reply.kind === 'response' && reply.status >= 200 && reply.status < 300) return;
    const transient = reply.kind === 'failed' ? reply.why !== 'blocked_address' : [408, 429].includes(reply.status) || reply.status >= 500;
    if (!transient || attempt === RETRY.attempts) {
      const why = reply.kind === 'failed' ? reply.why : `HTTP ${reply.status}`;
      return console.warn(`notify: ${delivery.label} gave up after ${attempt} attempt(s): ${why}`);
    }
    await new Promise((done) => setTimeout(done, Math.min(RETRY.firstDelayMs * 2 ** (attempt - 1), RETRY.maxDelayMs)));
  }
}

function behind(sink: Sink, head: number): boolean {
  return sink.notified !== null && sink.notified < head;
}

function fail(code: number, message: string, data?: Record<string, unknown>): never {
  throw new ProtocolError(code, message, data);
}

function isEmpty(record: Record<string, unknown>): boolean {
  return Object.keys(record).length === 0;
}

/** Pure. Checks in the order the error codes rank: unknown event, unsupported mode, then bad values. */
function parseSubscription(params: EventsSubscribeParams, allowLoopbackHttp: boolean) {
  if (params.name !== PUFFER_CHANGES) fail(EVENTS_ERROR.notFound, `unknown event ${params.name}`, { kind: 'event' });
  const { mode } = params.delivery;
  if (mode !== 'webhook') fail(EVENTS_ERROR.unsupported, `delivery mode ${mode} is not supported`, { feature: 'delivery', value: mode });
  if (!isEmpty(params.arguments)) fail(EVENTS_ERROR.invalidParams, `${PUFFER_CHANGES} takes no arguments`);
  const url =
    parseCallbackUrl(params.delivery.url ?? '', allowLoopbackHttp) ?? fail(EVENTS_ERROR.invalidParams, 'delivery.url must be an https URL');
  const secret =
    webhookSecret(params.delivery.secret ?? '') ??
    fail(EVENTS_ERROR.invalidParams, 'delivery.secret must be whsec_ followed by the base64 of 24 to 64 bytes');
  const cursor =
    params.cursor == null ? null : /^\d{1,15}$/.test(params.cursor) ? Number(params.cursor) : fail(EVENTS_ERROR.invalidParams, 'unknown cursor');
  const ttlMs = params.ttlMs === undefined ? TTL.defaultMs : Math.min(Math.max(params.ttlMs ?? TTL.maxMs, TTL.minMs), TTL.maxMs);
  return { url, secret, ttlMs, cursor };
}

function webhookSecret(raw: string): Buffer | null {
  const encoded = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(raw)?.[1];
  const bytes = encoded ? Buffer.from(encoded, 'base64') : null;
  return bytes && bytes.toString('base64') === encoded && bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 22);
}

/** Identity is (principal, url, event name, canonical arguments); puffer.changes takes no arguments. */
function subscriptionId(agentId: AgentId, url: CallbackUrl): SubscriptionId {
  return `sub_${digest(JSON.stringify([agentId, url, PUFFER_CHANGES, {}]))}`;
}

/** Standard Webhooks signing: v1 is base64 HMAC-SHA256 over "<id>.<unix seconds>.<body>". */
export function signed(secret: Buffer, webhookId: string, body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${webhookId}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
}

function headersFor(sink: Sink, eventId: string, body: string): Record<string, string> {
  switch (sink.kind) {
    case 'mcpEvents':
      return { ...signed(sink.secret, eventId, body), 'x-mcp-subscription-id': sink.id };
    case 'webhook':
      return { 'webhook-id': eventId, ...(sink.token ? { authorization: `Bearer ${sink.token}` } : {}) };
  }
}

/**
 * One reason on the wire whatever went wrong, so the error cannot tell an agent which hosts and ports answer
 * (refused, TLS, timeout); the relay logs the specific one.
 */
async function verify(agentId: AgentId, url: CallbackUrl, secret: Buffer, id: SubscriptionId, allowLoopback: boolean): Promise<void> {
  const challenge = randomBytes(24).toString('base64url');
  const body = JSON.stringify({ type: 'verification', challenge });
  const webhookId = `msg_verification_${randomBytes(12).toString('base64url')}`;
  const headers = { ...signed(secret, webhookId, body), 'x-mcp-subscription-id': id };
  const why = verificationFailure(await post(url, headers, body, RECEIVER.maxVerificationBytes, allowLoopback), challenge);
  if (why === null) return;
  console.warn(`notify: callback verification for ${agentId} failed: ${why}`);
  fail(EVENTS_ERROR.callbackEndpoint, 'the callback did not pass verification', { reason: 'challenge_failed' });
}

function verificationFailure(reply: Awaited<ReturnType<typeof post>>, challenge: string): CallbackFailure | null {
  if (reply.kind === 'failed') return reply.why;
  if (reply.status < 200 || reply.status >= 300) return 'http_status';
  let echoed: unknown;
  try {
    echoed = (JSON.parse(reply.body) as { challenge?: unknown }).challenge;
  } catch {
    return 'challenge_failed';
  }
  const ok = typeof echoed === 'string' && echoed.length === challenge.length && timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
  return ok ? null : 'challenge_failed';
}

function post(url: CallbackUrl, headers: Record<string, string>, body: string, maxBytes: number, allowLoopback: boolean) {
  const exchange = { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, timeoutMs: RECEIVER.timeoutMs, maxBytes } as const;
  return send(new URL(url), exchange, allowLoopback);
}
