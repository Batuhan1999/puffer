// Parked requests, the device long-poll and the change pages the phone sends ahead. In memory only: a restart
// drops parked requests (agents then see `expired`) and pages. No content decisions happen here; the phone
// decides, the mailbox carries.

import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { RateLimit } from './limits';
import {
  RequestId,
  answerPayloads,
  wireTime,
  type AgentId,
  type AnswerPayload,
  type ChangePageEntry,
  type ChangesPage,
  type Cursor,
  type NoteFolder,
  type NoteSummary,
  type Outcome,
  type OutcomeKind,
  type SingleNoteKind,
  type ReadCursor,
  type RequestQuery,
  type SharedItem,
  type SyncBody,
  type WireAck,
  type WireNote,
  type WireRequest,
  type WireSource,
} from './protocol';

/**
 * `preparedAt` is set when the relay answered from the page the phone sent ahead: when that page arrived.
 * `disconnected`: the phone dropped the agent while the request was open; the relay settles it, never the phone.
 */
export type Settlement =
  | { kind: 'answered'; items: SharedItem[] }
  | { kind: 'changes'; page: ChangesPage; preparedAt: number | null }
  | { kind: 'sources'; sources: WireSource[] }
  | { kind: 'notes'; notes: NoteSummary[] }
  | { kind: 'noteFolders'; folders: NoteFolder[] }
  | { kind: 'note'; note: WireNote }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'nothingFound' }
  | { kind: 'declined' }
  | { kind: 'rateLimited' }
  | { kind: 'disconnected' }
  | { kind: 'expired' }
  | { kind: 'failed'; reason: string };

/** What the ack names for a request already settled, whatever the phone sent this time. */
const ACK_KIND: Record<Settlement['kind'], OutcomeKind> = {
  answered: 'answered',
  changes: 'answered',
  sources: 'answered',
  notes: 'answered',
  noteFolders: 'answered',
  note: 'answered',
  conflict: 'conflict',
  nothingFound: 'nothingFound',
  declined: 'declined',
  rateLimited: 'rateLimited',
  disconnected: 'expired',
  expired: 'expired',
  failed: 'failed',
};

export type RequestState =
  | { kind: 'queued' } // not yet handed to the phone
  | { kind: 'withPhone'; since: number } // handed over, no status back yet
  /** `bytes`: what the outcome holds in memory, counted against settledBytesMax. */
  | { kind: 'settled'; at: number; outcome: Settlement; bytes: number };

export type RelayRequest = {
  readonly id: RequestId;
  readonly agentId: AgentId;
  readonly query: RequestQuery;
  readonly askedAt: number;
  readonly expiresAt: number;
  state: RequestState;
};

export type DevicePresence = { online: boolean; lastSeenAt: number | null };

/** What an agent's call resolves to, over MCP or HTTP. Derived only by toolStatus; worded by operations.render. */
export type ToolOutcome = { requestId: RequestId } & (
  | { status: 'answered'; items: SharedItem[] }
  | { status: 'changes'; page: ChangesPage; preparedAt: number | null }
  | { status: 'sources'; sources: WireSource[] }
  | { status: 'notes'; notes: NoteSummary[] }
  | { status: 'noteFolders'; folders: NoteFolder[] }
  | { status: 'note'; note: WireNote; of: SingleNoteKind }
  | { status: 'conflict'; currentVersion: number; baseVersion: number | null }
  | { status: 'nothing_found'; of: RequestQuery['kind'] }
  | { status: 'declined' }
  | { status: 'rate_limited' }
  | { status: 'disconnected' }
  | { status: 'expired' }
  | { status: 'failed'; reason: string }
  | { status: 'processing' }
  | { status: 'phone_offline'; lastSeenAt: number | null }
);

export type MailboxOptions = {
  ttlMs: number; // queued and unanswered requests expire after this
  settledRetentionMs: number; // answers are dropped this long after settling
  offlineAfterMs: number; // no sync for this long means offline; longer than one 25 s long-poll
  offlineGraceMs: number; // an ask waits this long for an offline phone before answering phone_offline
  maxOpenPerAgent: number; // so one agent cannot flood the phone
  newPerMinute: number; // new requests per agent per minute; a re-attach does not count
  maxWaitsPerAgent: number; // tool calls of one agent parked at once; another is answered with its status at once
  dedupeWindowMs: number; // an identical open query from the same agent within this re-attaches
  pageTtlMs: number; // a page the phone sent ahead is dropped this long after it arrived
  settledBytesMax: number; // answer text and files a tenant keeps for collection; the oldest settled answers go first
};

export const DEFAULT_MAILBOX_OPTIONS: MailboxOptions = {
  ttlMs: 24 * 60 * 60_000,
  settledRetentionMs: 60 * 60_000,
  offlineAfterMs: 35_000,
  offlineGraceMs: 2_000,
  maxOpenPerAgent: 10,
  newPerMinute: 20,
  maxWaitsPerAgent: 4,
  dedupeWindowMs: 10 * 60_000,
  pageTtlMs: 24 * 60 * 60_000,
  settledBytesMax: 32 * 1024 * 1024,
};

export class MailboxFull extends Error {
  constructor(readonly open: number) {
    super(`agent has ${open} open requests`);
  }
}

export class TooManyRequests extends Error {
  constructor(readonly perMinute: number) {
    super(`agent made more than ${perMinute} new requests in a minute`);
  }
}

/** Told to the agent when its phone runs a Puffer that cannot read the request. */
export const PHONE_TOO_OLD = 'Puffer on the iPhone is too old for this request. Ask the user to update the app.';

/** Pure. The single mapping from relay state and presence to what the agent is told. */
export function toolStatus(request: RelayRequest, presence: DevicePresence): ToolOutcome {
  const requestId = request.id;
  const { state } = request;
  switch (state.kind) {
    case 'settled': {
      const { outcome } = state;
      switch (outcome.kind) {
        case 'answered':
          return { requestId, status: 'answered', items: outcome.items };
        case 'changes':
          return { requestId, status: 'changes', page: outcome.page, preparedAt: outcome.preparedAt };
        case 'sources':
          return { requestId, status: 'sources', sources: outcome.sources };
        case 'notes':
          return { requestId, status: 'notes', notes: outcome.notes };
        case 'noteFolders':
          return { requestId, status: 'noteFolders', folders: outcome.folders };
        case 'note':
          return { requestId, status: 'note', note: outcome.note, of: request.query.kind as SingleNoteKind };
        case 'conflict':
          return {
            requestId,
            status: 'conflict',
            currentVersion: outcome.currentVersion,
            baseVersion: request.query.kind === 'updateNote' ? request.query.baseVersion : null,
          };
        case 'nothingFound':
          return { requestId, status: 'nothing_found', of: request.query.kind };
        case 'declined':
          return { requestId, status: 'declined' };
        case 'rateLimited':
          return { requestId, status: 'rate_limited' };
        case 'disconnected':
          return { requestId, status: 'disconnected' };
        case 'failed':
          return { requestId, status: 'failed', reason: outcome.reason };
        case 'expired':
          return { requestId, status: 'expired' };
      }
    }
    case 'queued':
    case 'withPhone':
      return presence.online
        ? { requestId, status: 'processing' }
        : { requestId, status: 'phone_offline', lastSeenAt: presence.lastSeenAt };
  }
}

/** The one payload an answer to each request kind carries. */
const EXPECTED_PAYLOAD: Record<RequestQuery['kind'], AnswerPayload> = {
  ask: 'items',
  recent: 'items',
  changes: 'changes',
  sources: 'sources',
  searchNotes: 'notes',
  listNotes: 'notes',
  listNoteFolders: 'folders',
  getNote: 'note',
  createNote: 'note',
  appendToNote: 'note',
  updateNote: 'note',
  deleteNote: 'note',
};

/**
 * An answer must carry exactly the payload its request kind expects (EXPECTED_PAYLOAD), and a conflict fits only an
 * update. A mismatch is a phone bug; it settles as expired so the agent asks again instead of waiting forever.
 */
function settlement(query: RequestQuery, outcome: Outcome): Settlement {
  if (outcome.kind === 'failed') return { kind: 'failed', reason: outcome.reason };
  if (outcome.kind === 'conflict') {
    return query.kind === 'updateNote' ? { kind: 'conflict', currentVersion: outcome.currentVersion } : { kind: 'expired' };
  }
  if (outcome.kind !== 'answered') return { kind: outcome.kind };
  const carried = answerPayloads(outcome);
  const expected = EXPECTED_PAYLOAD[query.kind];
  if (carried.length !== 1 || carried[0] !== expected) return { kind: 'expired' };
  switch (expected) {
    case 'items':
      return { kind: 'answered', items: outcome.items };
    case 'changes':
      return outcome.changes ? { kind: 'changes', page: outcome.changes, preparedAt: null } : { kind: 'expired' };
    case 'sources':
      return outcome.sources ? { kind: 'sources', sources: outcome.sources } : { kind: 'expired' };
    case 'notes':
      return outcome.notes ? { kind: 'notes', notes: outcome.notes } : { kind: 'expired' };
    case 'folders':
      return outcome.folders ? { kind: 'noteFolders', folders: outcome.folders } : { kind: 'expired' };
    case 'note':
      return outcome.note ? { kind: 'note', note: outcome.note } : { kind: 'expired' };
  }
}

/** UTF-16 units of the text and file data an outcome keeps alive: passages, whole documents, a note body. */
function heldBytes(outcome: Settlement): number {
  switch (outcome.kind) {
    case 'answered':
      return outcome.items.reduce((sum, { text, document }) => {
        const whole = document === null ? 0 : document.kind === 'text' ? document.text.length : document.data.length;
        return sum + (text?.length ?? 0) + whole;
      }, 0);
    case 'note':
      return outcome.note.body?.length ?? 0;
    default:
      return 0;
  }
}

type PreparedPage = { since: Cursor | null; page: ChangesPage; receivedAt: number };

/** The relay serves the phone's page only for exactly the span the phone computed it for. */
function covers(prepared: PreparedPage, query: RequestQuery): boolean {
  return query.kind === 'changes' && query.since === prepared.since && query.limit >= prepared.page.events.length;
}

export class Mailbox {
  private readonly requests = new Map<RequestId, RelayRequest>();
  private readonly listeners = new Set<() => void>();
  private readonly pages = new Map<AgentId, PreparedPage>();
  private readonly readCursors = new Map<AgentId, Cursor>();
  private readonly waits = new Map<AgentId, number>();
  private readonly newRequests: RateLimit<AgentId>;
  private lastSeenAt: number | null = null;
  /** What the last syncing phone said it reads. A request of another kind settles as failed instead of reaching it. */
  private phoneKinds: ReadonlySet<string> = new Set();
  private syncTurn = 0;
  private parkedTurn: number | null = null;

  constructor(private readonly options: MailboxOptions) {
    this.newRequests = new RateLimit(options.newPerMinute, 60_000);
  }

  /**
   * Creates the request, or re-attaches to an identical open one, and waits until it settles, the
   * wait budget ends, or the phone stays offline past the grace period. Aborting stops waiting but keeps
   * the request. Throws MailboxFull when the agent already has maxOpenPerAgent open requests, and
   * TooManyRequests past newPerMinute new requests.
   */
  ask(agentId: AgentId, query: RequestQuery, waitMs: number, signal: AbortSignal): Promise<ToolOutcome> {
    this.sweep();
    const now = Date.now();
    const open = [...this.requests.values()].filter((r) => r.agentId === agentId && r.state.kind !== 'settled');
    const retry = open.find((r) => isDeepStrictEqual(r.query, query) && now - r.askedAt < this.options.dedupeWindowMs);
    if (retry) return this.wait(retry, waitMs, signal);
    if (open.length >= this.options.maxOpenPerAgent) throw new MailboxFull(open.length);
    if (!this.newRequests.take(agentId)) throw new TooManyRequests(this.options.newPerMinute);

    const request: RelayRequest = {
      id: RequestId.parse(`rq_${randomBytes(12).toString('base64url')}`),
      agentId,
      query,
      askedAt: now,
      expiresAt: now + this.options.ttlMs,
      state: { kind: 'queued' },
    };
    this.requests.set(request.id, request);
    this.changed();
    return this.wait(request, waitMs, signal);
  }

  /** Same wait for an existing request. Another agent's id or an unknown id reads as `expired`. */
  check(agentId: AgentId, requestId: RequestId, waitMs: number, signal: AbortSignal): Promise<ToolOutcome> {
    this.sweep();
    const request = this.requests.get(requestId);
    if (!request || request.agentId !== agentId) return Promise.resolve({ requestId, status: 'expired' });
    return this.wait(request, waitMs, signal);
  }

  /**
   * The device side. Applies the outbox (first terminal outcome per id wins), then returns every request
   * in `queued` or `withPhone`, moving queued ones to `withPhone`. Answers at once when the body carried
   * outcomes or a queued request is ready; otherwise parks until one is or waitMs passes.
   * A newer sync replaces a parked one, which is answered empty. Every reply carries the current read cursors.
   */
  async sync(body: SyncBody, signal: AbortSignal): Promise<{ requests: WireRequest[]; acked: WireAck[]; readCursors: ReadCursor[] }> {
    const turn = ++this.syncTurn;
    this.lastSeenAt = Date.now();
    this.phoneKinds = new Set(body.requestKinds);
    this.sweep();
    const acked = body.outbox.map((outcome) => this.apply(outcome));
    this.changed();

    if (acked.length === 0) {
      const until = Date.now() + body.waitMs;
      this.parkedTurn = turn;
      while (turn === this.syncTurn && !signal.aborted && !this.hasQueued() && Date.now() < until) {
        await this.nextChange(until - Date.now(), signal);
      }
      if (this.parkedTurn === turn) this.parkedTurn = null;
      if (turn !== this.syncTurn || signal.aborted) return { requests: [], acked: [], readCursors: this.cursors() };
    }
    return { requests: this.handOver(), acked, readCursors: this.cursors() };
  }

  /** Full replace. The caller passes only agents the registry knows. Memory only, never on disk. */
  replacePages(entries: readonly ChangePageEntry[]): void {
    const receivedAt = Date.now();
    this.pages.clear();
    for (const { agentId, since, page } of entries) this.pages.set(agentId, { since, page, receivedAt });
  }

  /** Called when the phone drops agents: their open requests settle as `disconnected`; their pages and read cursors go. */
  revoke(agentIds: readonly AgentId[]): void {
    if (agentIds.length === 0) return;
    const revoked = new Set(agentIds);
    for (const id of revoked) {
      this.pages.delete(id);
      this.readCursors.delete(id);
    }
    for (const request of this.requests.values()) {
      if (revoked.has(request.agentId) && request.state.kind !== 'settled') this.settle(request, { kind: 'disconnected' });
    }
    this.changed();
  }

  presence(): DevicePresence {
    const recent = this.lastSeenAt !== null && Date.now() - this.lastSeenAt < this.options.offlineAfterMs;
    return { online: this.parkedTurn !== null || recent, lastSeenAt: this.lastSeenAt };
  }

  /** Expiry and retention sweep, run on a timer and before every read. */
  sweep(): void {
    const now = Date.now();
    for (const [agentId, prepared] of this.pages) if (now - prepared.receivedAt >= this.options.pageTtlMs) this.pages.delete(agentId);
    let expired = false;
    for (const [id, request] of this.requests) {
      if (request.state.kind === 'settled') {
        if (now - request.state.at >= this.options.settledRetentionMs) this.requests.delete(id);
      } else if (now >= request.expiresAt) {
        this.settle(request, { kind: 'expired' });
        expired = true;
      }
    }
    if (expired) this.changed();
  }

  private apply(outcome: Outcome): WireAck {
    const request = this.requests.get(outcome.id);
    // A forgotten id (relay restart, retention sweep) is acked as sent so the phone stops re-sending it.
    if (!request) return { id: outcome.id, kind: outcome.kind };
    if (request.state.kind === 'settled') return { id: request.id, kind: ACK_KIND[request.state.outcome.kind] };
    this.settle(request, settlement(request.query, outcome));
    return { id: request.id, kind: outcome.kind };
  }

  private settle(request: RelayRequest, outcome: Settlement): void {
    const bytes = heldBytes(outcome);
    request.state = { kind: 'settled', at: Date.now(), outcome, bytes };
    if (outcome.kind === 'changes') this.readCursors.set(request.agentId, outcome.page.nextCursor);
    if (bytes > 0) this.trimSettled(request);
  }

  /**
   * Past settledBytesMax, the answers that settled first are forgotten (a later get_puffer_answer reads `expired`). A
   * call already waiting on one holds the request itself, so it still gets its answer. `kept` is never dropped.
   */
  private trimSettled(kept: RelayRequest): void {
    const held: { id: RequestId; at: number; bytes: number }[] = [];
    let total = 0;
    for (const { id, state } of this.requests.values()) {
      if (state.kind !== 'settled' || state.bytes === 0) continue;
      total += state.bytes;
      if (id !== kept.id) held.push({ id, at: state.at, bytes: state.bytes });
    }
    held.sort((a, b) => a.at - b.at);
    for (const { id, bytes } of held) {
      if (total <= this.options.settledBytesMax) break;
      this.requests.delete(id);
      total -= bytes;
    }
  }

  /** Answers an open changes request from the page the phone sent ahead, unchanged, when it covers the request. */
  private answerFromPage(request: RelayRequest): void {
    const prepared = this.pages.get(request.agentId);
    if (request.state.kind === 'settled' || !prepared || !covers(prepared, request.query)) return;
    this.settle(request, { kind: 'changes', page: prepared.page, preparedAt: prepared.receivedAt });
    this.changed();
  }

  private cursors(): ReadCursor[] {
    return [...this.readCursors].map(([agentId, cursor]) => ({ agentId, cursor }));
  }

  /** A request this phone cannot read never reaches it: an unknown kind would fail its whole sync. */
  private handOver(): WireRequest[] {
    const now = Date.now();
    const handed: WireRequest[] = [];
    let refused = false;
    for (const request of this.requests.values()) {
      const open = request.state.kind === 'queued' || request.state.kind === 'withPhone';
      if (open && !this.phoneKinds.has(request.query.kind)) {
        this.settle(request, { kind: 'failed', reason: PHONE_TOO_OLD });
        refused = true;
        continue;
      }
      if (request.state.kind === 'queued') request.state = { kind: 'withPhone', since: now };
      if (request.state.kind !== 'withPhone') continue;
      handed.push({
        id: request.id,
        agentId: request.agentId,
        askedAt: wireTime(request.askedAt),
        expiresAt: wireTime(request.expiresAt),
        ...request.query,
      });
    }
    if (refused) this.changed();
    return handed;
  }

  private hasQueued(): boolean {
    for (const request of this.requests.values()) if (request.state.kind === 'queued') return true;
    return false;
  }

  /**
   * An offline phone shortens the budget to the grace period, so the agent hears phone_offline quickly. A changes
   * request the phone's page covers is answered from it instead, and never reaches the phone. Past maxWaitsPerAgent
   * parked calls the budget is zero: the call answers with the current status and its request_id.
   */
  private async wait(request: RelayRequest, waitMs: number, signal: AbortSignal): Promise<ToolOutcome> {
    const { agentId } = request;
    const held = this.waits.get(agentId) ?? 0;
    const parks = held < this.options.maxWaitsPerAgent;
    if (parks) this.waits.set(agentId, held + 1);
    try {
      const start = Date.now();
      for (;;) {
        this.sweep();
        const presence = this.presence();
        if (!presence.online) this.answerFromPage(request);
        const status = toolStatus(request, presence);
        const budget = !parks ? 0 : status.status === 'phone_offline' ? Math.min(waitMs, this.options.offlineGraceMs) : waitMs;
        const elapsed = Date.now() - start;
        if (request.state.kind === 'settled' || signal.aborted || elapsed >= budget) return status;
        await this.nextChange(budget - elapsed, signal);
      }
    } finally {
      if (parks) {
        const left = (this.waits.get(agentId) ?? 1) - 1;
        if (left > 0) this.waits.set(agentId, left);
        else this.waits.delete(agentId);
      }
    }
  }

  private nextChange(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(done);
      signal.addEventListener('abort', done);
    });
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
