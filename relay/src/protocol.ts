// Authoritative schema for the phone <-> relay wire (v1) and the MCP tool arguments. Swift mirrors the
// wire in modules/puffer-native/ios/Relay.swift. Everything from the network is parsed here; the rest of
// the relay trusts these types.

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const AgentId = z.string().min(1).max(100).brand<'AgentId'>();
export type AgentId = z.infer<typeof AgentId>;

export const RequestId = z.string().regex(/^rq_[A-Za-z0-9_-]{8,64}$/).brand<'RequestId'>();
export type RequestId = z.infer<typeof RequestId>;

export const KeyDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/).brand<'KeyDigest'>();
export type KeyDigest = z.infer<typeof KeyDigest>;

/** A connection request waiting for the phone (oauth.ts): from an OAuth client, or from an agent's link. */
export const ConnectId = z.string().regex(/^cn_[A-Za-z0-9_-]{16,64}$/).brand<'ConnectId'>();
export type ConnectId = z.infer<typeof ConnectId>;

// Swift's synthesized Codable omits nil optionals instead of writing null, so absent and null mean the same.
const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? null);

/** 15 MB of original file as base64. */
const ORIGINAL_BASE64_MAX = Math.ceil((15 * 1024 * 1024) / 3) * 4;

/** UTF-16 units of one document's full text. The phone cuts there, and at twice that per answer. */
const DOCUMENT_TEXT_MAX = 200_000;

/**
 * The whole of a shared document, only when the ask had include_documents. Its full text, or its original file. When
 * the file was asked for but could not go, the text comes with `fileMissing`: over 15 MB, unreadable on the phone
 * (for example an iCloud file not downloaded), or past 15 MB of files in one answer, which keeps a sync body under the
 * relay's 24 MB limit.
 */
export const WholeDocument = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string().max(DOCUMENT_TEXT_MAX),
    truncated: z.boolean(),
    fileMissing: nullable(z.enum(['tooLarge', 'unavailable', 'answerLimit'])),
  }),
  z.object({
    kind: z.literal('file'),
    name: z.string().min(1).max(300),
    mimeType: z.string().regex(/^[a-z]+\/[A-Za-z0-9.+_-]{1,100}$/),
    data: z.base64().max(ORIGINAL_BASE64_MAX),
  }),
]);
export type WholeDocument = z.infer<typeof WholeDocument>;

/** One passage the phone shared. A phone may still send `kind`, `imageJpeg`, `imageOriginal`, `originalTooLarge` and `albums`; they are dropped. */
export const SharedItem = z.object({
  title: z.string().max(300),
  text: nullable(z.string().max(1000)),
  document: nullable(WholeDocument),
  /** When the file was last modified. */
  date: nullable(z.iso.datetime()),
  /** The file's folder, starting with its source's name. */
  folder: nullable(z.string().max(1000)),
  fileType: nullable(z.string().max(20)),
});
export type SharedItem = z.infer<typeof SharedItem>;

/** A change-log position, opaque to the relay and the agent. The phone mints it. */
export const Cursor = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).brand<'Cursor'>();
export type Cursor = z.infer<typeof Cursor>;

const present = {
  at: z.iso.datetime(),
  title: z.string().max(300),
  source: z.string().max(200),
  // The phone cuts excerpts at 200 characters; zod counts UTF-16 units, and one character can take several.
  excerpt: nullable(z.string().max(1000)),
};
/** One change in the library. A removal names the title only; the phone never sends ids or paths. A sent `itemKind` is dropped. */
export const WireChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added'), ...present }),
  z.object({ kind: z.literal('updated'), ...present }),
  z.object({ kind: z.literal('removed'), at: z.iso.datetime(), title: z.string().max(300) }),
]);
export type WireChange = z.infer<typeof WireChange>;

/** A sent `hiddenCount` is dropped. */
export const ChangesPage = z.object({
  events: z.array(WireChange).max(200),
  nextCursor: Cursor,
});
export type ChangesPage = z.infer<typeof ChangesPage>;

/** A source the agent may name in filters, with how many items it holds. */
export const WireSource = z.object({ name: z.string().min(1).max(200), count: z.number().int().min(1) });
export type WireSource = z.infer<typeof WireSource>;

/** Items in one answer: 6 for a relevance ask, up to RECENT_LIMIT_MAX for a recency listing or an ask sorted by date. */
const ANSWER_ITEMS_MAX = 20;

/** Minted by the phone (a UUID string fits). */
export const NoteId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).brand<'NoteId'>();
export type NoteId = z.infer<typeof NoteId>;

/** UTF-16 units of one note's Markdown body, both ways. */
export const NOTE_BODY_MAX = 200_000;
export const NOTE_APPEND_MAX = 50_000;

const noteMeta = {
  id: NoteId,
  title: z.string().max(300),
  folder: z.string().min(1).max(200),
  created: z.iso.datetime(),
  modified: z.iso.datetime(),
  /** Bumped by every change to the note; update_note names the version it edited. */
  version: z.number().int().min(0),
  pinned: z.boolean(),
};
/** A note in a search or listing: metadata and a snippet, never the body. */
export const NoteSummary = z.object({ ...noteMeta, snippet: nullable(z.string().max(1000)) });
export type NoteSummary = z.infer<typeof NoteSummary>;
/** One note after a read or write. A deleted note comes without its body; a longer one than NOTE_BODY_MAX comes cut, `truncated`. */
export const WireNote = z.object({
  ...noteMeta,
  body: nullable(z.string().max(NOTE_BODY_MAX)),
  truncated: z.boolean().nullish().transform((value) => value ?? false),
});
export type WireNote = z.infer<typeof WireNote>;
export const NoteFolder = z.object({ name: z.string().min(1).max(200), count: z.number().int().min(0) });
export type NoteFolder = z.infer<typeof NoteFolder>;

export const Outcome = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('answered'),
      id: RequestId,
      // A phone may still send photosWithheld, photosUnavailable and approvedBy; they are dropped.
      items: z.array(SharedItem).max(ANSWER_ITEMS_MAX).default([]),
      /** Present exactly when the request was a `changes` request. */
      changes: nullable(ChangesPage),
      /** Present exactly when the request was a `sources` request. */
      sources: nullable(z.array(WireSource).max(200)),
      /** searchNotes and listNotes. */
      notes: nullable(z.array(NoteSummary).max(100)),
      /** listNoteFolders. */
      folders: nullable(z.array(NoteFolder).max(200)),
      /** getNote, createNote, appendToNote, updateNote and deleteNote. */
      note: nullable(WireNote),
    })
    .refine((answer) => answerPayloads(answer).length > 0, 'an answer carries items, changes, sources, notes, folders or a note'),
  z.object({ kind: z.literal('nothingFound'), id: RequestId }),
  /** The phone did not run the request, for example for an agent it no longer has. */
  z.object({ kind: z.literal('declined'), id: RequestId }),
  /** The phone limits how often an agent may read, and did not run this one. */
  z.object({ kind: z.literal('rateLimited'), id: RequestId }),
  z.object({ kind: z.literal('expired'), id: RequestId }),
  /** The phone could not check the request (for example its search model would not load). `reason` is user-safe. */
  z.object({ kind: z.literal('failed'), id: RequestId, reason: z.string().min(1).max(200) }),
  /** updateNote only: baseVersion was stale. */
  z.object({ kind: z.literal('conflict'), id: RequestId, currentVersion: z.number().int().min(0) }),
]);
export type Outcome = z.infer<typeof Outcome>;
export type OutcomeKind = Outcome['kind'];
export type Answered = Extract<Outcome, { kind: 'answered' }>;

/** What an answer can carry. Each request kind expects exactly one (mailbox.ts). */
export type AnswerPayload = 'items' | 'changes' | 'sources' | 'notes' | 'folders' | 'note';

type Payloads = { items: readonly unknown[] } & Record<Exclude<AnswerPayload, 'items'>, unknown>;

export function answerPayloads(answer: Payloads): AnswerPayload[] {
  const carried: [AnswerPayload, boolean][] = [
    ['items', answer.items.length > 0],
    ['changes', answer.changes !== null],
    ['sources', answer.sources !== null],
    ['notes', answer.notes !== null],
    ['folders', answer.folders !== null],
    ['note', answer.note !== null],
  ];
  return carried.filter(([, present]) => present).map(([payload]) => payload);
}

export const WireAgent = z.object({ id: AgentId, name: z.string().min(1).max(80), keyDigest: KeyDigest });
export type WireAgent = z.infer<typeof WireAgent>;

export const WireRegistry = z.object({
  revision: z.number().int().nonnegative(),
  agents: z.array(WireAgent).max(100),
});
export type WireRegistry = z.infer<typeof WireRegistry>;

const NotifyConfig = z.object({ url: z.string().max(2048), token: nullable(z.string().max(512)) });

/** The registry as the phone sends it. `notify` is a webhook the user set; malformed reads as none, since a 400 stops the sync loop. */
export const PhoneRegistry = z.object({
  revision: z.number().int().nonnegative(),
  agents: z
    .array(WireAgent.extend({ notify: z.unknown().optional().transform((raw) => NotifyConfig.safeParse(raw).data ?? null) }))
    .max(100),
});
export type PhoneRegistry = z.infer<typeof PhoneRegistry>;

/** The newest change-log seq per agent. No titles, no counts. */
export const ChangeHead = z.object({ agentId: AgentId, seq: z.number().int().nonnegative() });
export type ChangeHead = z.infer<typeof ChangeHead>;

/** A page the phone computed ahead, since the agent's read cursor, for the relay to serve while the phone sleeps. */
export const ChangePageEntry = z.object({ agentId: AgentId, since: nullable(Cursor), page: ChangesPage });
export type ChangePageEntry = z.infer<typeof ChangePageEntry>;

/**
 * One malformed outcome must not fail the whole sync, which would stop the phone's loop. One that names a request id
 * settles that request as expired, as an answer that does not fit its request does, and is acked so the phone stops
 * re-sending it; one without a request id is dropped.
 */
const OutboxEntry = z.unknown().transform((raw): Outcome | null => {
  const parsed = Outcome.safeParse(raw);
  if (parsed.success) return parsed.data;
  const id = RequestId.safeParse(typeof raw === 'object' && raw !== null && 'id' in raw ? raw.id : undefined);
  console.warn(`sync: a malformed outcome ${id.success ? `for ${id.data} settles as expired` : 'without a request id is dropped'}: ${z.prettifyError(parsed.error)}`);
  return id.success ? { kind: 'expired', id: id.data } : null;
});

export const SyncBody = z.object({
  v: z.literal(PROTOCOL_VERSION),
  waitMs: z.number().int().min(0).max(25_000),
  outbox: z
    .array(OutboxEntry)
    .max(100)
    .transform((entries) => entries.filter((entry) => entry !== null)),
  registry: nullable(PhoneRegistry),
  /** Every agent's head, on every sync. The relay pings only when one advances. */
  changeHeads: nullable(z.array(ChangeHead).max(100)),
  /** Present: replaces every page the relay holds. Absent: keeps them (a phone from before pages). */
  changePages: nullable(z.array(ChangePageEntry).max(100)),
  /** Connections the user declined, by id. */
  connectDeclines: nullable(z.array(ConnectId).max(100)),
  /** The request kinds this phone can read. Absent: none, so every request fails as too old. */
  requestKinds: nullable(z.array(z.string().max(20)).max(20)),
});
export type SyncBody = z.infer<typeof SyncBody>;

/**
 * What an agent asked for. `ask` searches, by relevance or with `sort: 'recent'` by date; `recent` lists the newest
 * items without a topic; `changes` reads the change log after a cursor; `sources` lists the source names.
 */
export type RequestQuery =
  | ({ kind: 'ask'; question: string; filters?: AskFilters; includeDocuments?: IncludeDocuments } & (
      | {}
      | { sort: 'recent'; limit: number }
    ))
  | { kind: 'recent'; limit: number; filters?: RecentFilters; includeDocuments?: IncludeDocuments }
  | { kind: 'changes'; since: Cursor | null; limit: number }
  | { kind: 'sources' }
  | NoteQuery;

/** The note operations (design/notes/CONTRACT.md). The phone runs them for any connected agent; the relay carries them. */
export type NoteQuery =
  | { kind: 'searchNotes'; query: string; folder?: string; sort: 'relevance' | 'recent'; limit: number }
  | { kind: 'listNotes'; folder?: string; limit: number }
  | { kind: 'listNoteFolders' }
  | { kind: 'getNote'; noteId: NoteId }
  | { kind: 'createNote'; title?: string; body: string; folder?: string }
  | { kind: 'appendToNote'; noteId: NoteId; text: string }
  | { kind: 'updateNote'; noteId: NoteId; body: string; baseVersion: number }
  | { kind: 'deleteNote'; noteId: NoteId };

/** Note requests answered with one note. */
export type SingleNoteKind = Extract<NoteQuery['kind'], 'getNote' | 'createNote' | 'appendToNote' | 'updateNote' | 'deleteNote'>;

/**
 * The offline write changelog (mailbox.ts) rides on the existing request path rather than a pull/ack of its own: a note
 * write asked while the phone was offline is held as an ordinary request and handed over on the phone's next sync like
 * any other, in the order it was asked, with `queued: true` and `queuedAt` (when the relay queued it). A queued
 * createNote also carries `noteId`, the id the relay already told the agent: a lowercase UUID, the phone's own format
 * (NoteBook.newID), which the phone keeps for the note. The phone applies queued writes in this order, idempotent by
 * request id, and answers each in its outbox as usual; the relay acks it by request id and drops its content then. A
 * phone that does not know the flags runs it as a live write (a create then gets its own id, which its answer names).
 * Reads never see queued writes until the phone ran them.
 *
 * TODO: queued writes are note content held on the relay in plain memory while the phone is away. Before more users,
 * encrypt each one to a public key the phone registers, so only that phone can read it, and persist the ciphertext so
 * a restart does not lose writes.
 */
export type QueuedFlags = { queued?: true; queuedAt?: string; noteId?: NoteId };

export type WireRequest = { id: RequestId; agentId: AgentId; askedAt: string; expiresAt: string } & RequestQuery & QueuedFlags;

export type WireAck = { id: RequestId; kind: OutcomeKind };

export type ReadCursor = { agentId: AgentId; cursor: Cursor };

type WireConnectBase = {
  id: ConnectId;
  /** The client's or the agent's own claim, unless an OAuth connection has a clientHost. */
  clientName: string;
  keyDigest: KeyDigest;
  requestedAt: string;
  expiresAt: string;
};

/**
 * A request to connect. Every one has an approve link: the OAuth client's browser page shows it as a QR code (`oauth`),
 * or an agent sent it to the user (`link`). Puffer opened through it presents the link's secret to the confirm
 * endpoint, and on `confirmed` approves by adding an agent with this keyDigest to its registry. The phone neither
 * notifies about nor lists a connection until it was opened through its link.
 */
export type WireConnect =
  | (WireConnectBase & {
      origin: 'oauth';
      /**
       * Host of the client's metadata document URL, only when this connection's redirect is not loopback, because
       * anyone can present a client_id whose redirect lands on their own machine. Null for a dynamically registered
       * client.
       */
      clientHost: string | null;
      redirectHost: string;
    })
  | (WireConnectBase & { origin: 'link' });

/** POST /v1/device/connects/<id>/confirm with the secret of the link Puffer was opened with. Any string is a proof. */
export const ConfirmBody = z.object({ v: z.literal(PROTOCOL_VERSION), link: z.string() });

export type ConfirmReply =
  | { status: 'confirmed' }
  /** The link secret does not match. The name predates link proofs. */
  | { status: 'wrongCode'; attemptsLeft: number }
  | { status: 'declined' }
  | { status: 'gone' };

export type SyncResponse = {
  v: typeof PROTOCOL_VERSION;
  requests: WireRequest[];
  acked: WireAck[];
  registryRevision: number;
  /** Per agent, the next_cursor of the last changes answer the relay returned. The phone computes the next page from it. */
  readCursors: ReadCursor[];
  /** True until this relay process accepts a snapshot: notify config lives in memory, so a restart needs it again. */
  wantsRegistry: boolean;
  /**
   * Agents the phone should remove, as a user revoke would: an OAuth connection the phone approved that was never
   * redeemed, or one whose authorization code was presented twice. Listed while the registry holds the digest.
   */
  revokedKeys: KeyDigest[];
};

/** 426 when the body names another protocol version, 400 on any other schema failure. */
export function parseSyncBody(raw: unknown): { ok: true; body: SyncBody } | { ok: false; status: 400 | 426; error: string } {
  if (typeof raw === 'object' && raw !== null && 'v' in raw && raw.v !== PROTOCOL_VERSION) {
    return { ok: false, status: 426, error: `protocol v${String(raw.v)} is not supported; this relay speaks v${PROTOCOL_VERSION}` };
  }
  const parsed = SyncBody.safeParse(raw);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, status: 400, error: z.prettifyError(parsed.error) };
}

/** Swift's .iso8601 date strategy rejects fractional seconds, so wire timestamps stop at whole seconds. */
export function wireTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const DayOrTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const SourceName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('Only items from this source, as list_puffer_sources names it: a folder such as "On My iPhone", or "Shared with Puffer".');

/** Passed to the phone as they are; the phone applies them before ranking. */
export const AskFilters = z.strictObject({
  after: DayOrTime.optional().describe('On or after this date, YYYY-MM-DD or ISO 8601, by last modified.'),
  before: DayOrTime.optional().describe('Before this date (exclusive), YYYY-MM-DD or ISO 8601.'),
  source: SourceName.optional(),
});
export type AskFilters = z.infer<typeof AskFilters>;

export const RecentFilters = z.strictObject({ source: SourceName.optional() });
export type RecentFilters = z.infer<typeof RecentFilters>;

export const RECENT_LIMIT_DEFAULT = 10;
const RECENT_LIMIT_MAX = 20;
const RecentLimit = z.number().int().min(1).max(RECENT_LIMIT_MAX);

export const IncludeDocuments = z
  .enum(['text', 'file'])
  .optional()
  .describe(
    'Also share each matching document whole, not only the matching passage. text: its full text, at most about ' +
      '200,000 characters per document and 400,000 per answer. file: the original file (PDF, text or Markdown) as ' +
      'base64, at most 15 MB of files per answer, otherwise its text. Pass it on get_puffer_answer too to collect them.',
  );
export type IncludeDocuments = NonNullable<z.infer<typeof IncludeDocuments>>;

export const AskArgs = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'A short description of what to find, 2 to 6 words, such as "lease deposit" or "banana bread recipe". Not the user\'s sentence.',
    ),
  filters: AskFilters.optional().describe('Narrow the search by date or source. Put dates and places here, not in the question.'),
  sort: z
    .enum(['relevance', 'recent'])
    .optional()
    .describe(
      'relevance (default): the closest matches. recent: every confident match, newest modified first, at most `limit`. ' +
        'Use recent for "latest" or "newest" X about Y.',
    ),
  limit: RecentLimit.optional().describe(`With sort recent: at most this many items, 1 to ${RECENT_LIMIT_MAX}, default ${RECENT_LIMIT_DEFAULT}.`),
  include_documents: IncludeDocuments,
});

export const RecentArgs = z.object({
  source: SourceName.optional(),
  limit: RecentLimit.optional().describe(`At most this many items, 1 to ${RECENT_LIMIT_MAX}, default ${RECENT_LIMIT_DEFAULT}.`),
  include_documents: IncludeDocuments,
});

export const SourcesArgs = z.object({});

export const GetChangesArgs = z.object({
  since: Cursor.optional().describe('The next_cursor from your previous get_puffer_changes call. Omit it on the first call.'),
  limit: z.number().int().min(1).max(200).optional().describe('At most this many changes per call. Default 50.'),
});

export const GetAnswerArgs = z.object({
  request_id: RequestId.describe('The request_id an earlier ask_puffer call returned.'),
  include_documents: IncludeDocuments,
});

export const CallbackUrl = z.string().brand<'CallbackUrl'>();
export type CallbackUrl = z.infer<typeof CallbackUrl>;

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where the relay may POST: https anywhere, plain http only to this machine and only with --dev-callbacks. */
export function parseCallbackUrl(raw: string, allowLoopbackHttp: boolean): CallbackUrl | null {
  const url = raw.length <= 2048 && URL.canParse(raw) ? new URL(raw) : null;
  if (!url || url.username || url.password) return null;
  const allowed = url.protocol === 'https:' || (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  return allowed ? CallbackUrl.parse(url.href) : null;
}

/** The one event this relay offers (MCP Events, experimental triggers-events extension). */
export const PUFFER_CHANGES = 'puffer.changes';

const EventArguments = z.record(z.string(), z.unknown()).default({});

// Loose on purpose: an unknown name, another delivery mode and bad values each have their own error code.
export const EventsSubscribeParams = z.object({
  name: z.string(),
  arguments: EventArguments,
  delivery: z.object({ mode: z.string(), url: z.string().optional(), secret: z.string().optional() }),
  cursor: z.string().nullish(),
  maxAgeMs: z.number().nullish(),
  ttlMs: z.number().nullable().optional(),
});
export type EventsSubscribeParams = z.infer<typeof EventsSubscribeParams>;

export const EventsUnsubscribeParams = z.object({
  name: z.string(),
  arguments: EventArguments,
  delivery: z.object({ url: z.string() }),
});
export type EventsUnsubscribeParams = z.infer<typeof EventsUnsubscribeParams>;
