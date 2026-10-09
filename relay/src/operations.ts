// What an agent can do, whatever it speaks: ask, list the newest items, list sources, collect an answer, read changes,
// and the note operations (notes.ts). The MCP tools (mcp.ts) and the HTTP API (http.ts) both call these and only change
// the envelope, so the two cannot tell an agent different things.

import type { z } from 'zod';

import { MailboxFull, TooManyRequests, type Mailbox, type ToolOutcome } from './mailbox';
import {
  RECENT_LIMIT_DEFAULT,
  wireTime,
  type AgentId,
  type AskArgs,
  type GetAnswerArgs,
  type GetChangesArgs,
  type NoteQuery,
  type NoteSummary,
  type RecentArgs,
  type RequestId,
  type RequestQuery,
  type SingleNoteKind,
  type WholeDocument,
  type WireChange,
  type WireNote,
  type WireSource,
} from './protocol';

/** How to phrase asks. Shared by the ask_puffer description (MCP and OpenAPI) and GET /start. */
export const ASK_QUERIES =
  'Puffer matches short descriptions, not sentences. Before you ask, turn the user\'s request into 1 to 3 queries ' +
  'of 2 to 6 words each: the thing itself, a synonym, or the kind of document (for example "lease deposit", ' +
  '"rental contract", "vet appointment", or "banana bread recipe", "recipes"). Ask once per query, merge the answers ' +
  'and cite the titles. Never pass the user\'s sentence through as it is, and leave out words such as "my files", ' +
  '"my notes" or "do I have". If every query comes back nothing_found, say that Puffer found nothing. Keep to few ' +
  'queries.';

/** How to narrow an ask. Shared by the ask_puffer description and GET /start. */
export const ASK_FILTERS =
  'Put dates and places in filters, not in the query: "invoices from last June" is the query "invoice" with ' +
  'filters {"after": "2026-06-01", "before": "2026-07-01"}. after (inclusive) and before (exclusive) are YYYY-MM-DD ' +
  'dates, compared with when a file was last modified; source is a folder name or "Shared with Puffer". Shared items ' +
  'carry date, folder and file_type when the phone knows them.';

/** Which call answers "latest" requests. Shared by the ask_puffer description, the OpenAPI document and GET /start. */
export const RECENCY =
  'ask_puffer ranks by meaning, not by date. For "latest", "recent" or "newest" documents without a topic, call ' +
  'list_puffer_recent. With a topic, such as "my newest documents about the trip", call ask_puffer with the topic as ' +
  'question ("trip") and sort "recent". list_puffer_sources names the sources you can use. For the user\'s own notes ' +
  'in Puffer, use search_notes and list_notes.';

export const ASK_DESCRIPTION = [
  "Ask the user's phone-local library (documents and notes) through the Puffer app.",
  ASK_QUERIES,
  ASK_FILTERS,
  RECENCY,
  'Documents come as the matching passage; pass include_documents "text" for each whole document\'s text or "file" for its original file.',
  "Once connected, you can read and write the user's notes and documents, and the phone answers at once.",
  'Statuses processing and phone_offline come with a request_id: call get_puffer_answer with it later. Treat Puffer as a mailbox, not a database.',
].join(' ');

export const RECENT_DESCRIPTION =
  "List the newest documents in the user's Puffer library, newest modified first. Use it for \"latest\", \"recent\" " +
  'or "newest" requests without a topic. source is a name from list_puffer_sources, limit is 1 to 20 (default ' +
  `${RECENT_LIMIT_DEFAULT}). ` +
  'Items come as in ask_puffer answers (title, excerpt, date, folder), and include_documents works the same. ' +
  'Statuses processing and phone_offline come with a request_id for get_puffer_answer. For the newest items about a ' +
  'topic, call ask_puffer with sort "recent" instead.';

export const SOURCES_DESCRIPTION =
  "List the sources in the user's Puffer library that you can name as source in list_puffer_recent and in ask_puffer " +
  'filters, such as a folder like "On My iPhone", or "Shared with Puffer", each with how ' +
  'many items it holds. No content. Like ask_puffer it can return phone_offline with a request_id: call ' +
  'get_puffer_answer with it later.';

export const GET_ANSWER_DESCRIPTION =
  'Get the answer to an earlier ask_puffer, list_puffer_recent, list_puffer_sources, get_puffer_changes or note ' +
  'request (search_notes, get_note, create_note and the others) by its request_id. If the request is still open, waits up to the relay wait budget and then returns the current status.';

export const CHANGES_DESCRIPTION =
  "List what changed in the user's Puffer library (documents and notes): files added, updated or removed, oldest " +
  'first. Omit `since` on your first call to get the most recent changes and a next_cursor; ' +
  'after that pass the next_cursor from your previous call as `since` to get only what changed after it. The ' +
  'cursor is opaque. Each change has title, kind, time, source and, for documents, a short excerpt; a removed item ' +
  'shows its title only. Like ask_puffer it can return phone_offline with a request_id: call get_puffer_answer with ' +
  'it later.';

const DEFAULT_CHANGES_LIMIT = 50;

/** The relay's /open/<id> link: a content-free page that opens Puffer on the phone. */
type OpenUrl = (id: RequestId) => string;

/** A document's original file. The HTTP API sends it in its item; MCP sends it as an embedded resource. */
export type DocumentFile = { name: string; mimeType: string; data: string };

/** Whether the agent's call asked for whole documents, not only the matching passages. */
const wantsDocuments = (args: { include_documents?: string | undefined }) => args.include_documents !== undefined;

/** The JSON result: MCP's structuredContent and the HTTP API's body. A changes page, a sources list and note payloads report status `answered`. */
export type Structured = {
  status: Exclude<ToolOutcome['status'], 'changes' | 'sources' | 'notes' | 'noteFolders' | 'note'>;
  request_id: RequestId;
} & Record<string, unknown>;

/** `message` says the same as `structured` in words, for an agent that reads text. */
export type Reply =
  | { kind: 'result'; structured: Structured; message: string; files: DocumentFile[] }
  | { kind: 'refused'; reason: 'too_many_open_requests' | 'rate_limited'; message: string };

export type Operations = ReturnType<typeof operations>;

export function operations(mailbox: Mailbox, openUrl: OpenUrl) {
  return {
    ask: (agentId: AgentId, args: z.infer<typeof AskArgs>, waitMs: number, signal: AbortSignal) =>
      parked(
        () =>
          mailbox.ask(
            agentId,
            {
              kind: 'ask',
              question: args.question,
              ...(args.filters ? { filters: args.filters } : {}),
              ...(args.sort === 'recent' ? { sort: 'recent' as const, limit: args.limit ?? RECENT_LIMIT_DEFAULT } : {}),
              ...(args.include_documents ? { includeDocuments: args.include_documents } : {}),
            },
            waitMs,
            signal,
          ),
        openUrl,
        wantsDocuments(args),
      ),
    recent: (agentId: AgentId, args: z.infer<typeof RecentArgs>, waitMs: number, signal: AbortSignal) => {
      const { source } = args;
      const query: RequestQuery = {
        kind: 'recent',
        limit: args.limit ?? RECENT_LIMIT_DEFAULT,
        ...(source ? { filters: { source } } : {}),
        ...(args.include_documents ? { includeDocuments: args.include_documents } : {}),
      };
      return parked(() => mailbox.ask(agentId, query, waitMs, signal), openUrl, wantsDocuments(args));
    },
    sources: (agentId: AgentId, waitMs: number, signal: AbortSignal) =>
      parked(() => mailbox.ask(agentId, { kind: 'sources' }, waitMs, signal), openUrl),
    changes: (agentId: AgentId, args: z.infer<typeof GetChangesArgs>, waitMs: number, signal: AbortSignal) =>
      parked(
        () => mailbox.ask(agentId, { kind: 'changes', since: args.since ?? null, limit: args.limit ?? DEFAULT_CHANGES_LIMIT }, waitMs, signal),
        openUrl,
      ),
    answer: async (agentId: AgentId, args: z.infer<typeof GetAnswerArgs>, waitMs: number, signal: AbortSignal): Promise<Reply> =>
      render(await mailbox.check(agentId, args.request_id, waitMs, signal), openUrl, wantsDocuments(args)),
    /** A note operation, already turned into its request by notes.ts. */
    note: (agentId: AgentId, query: NoteQuery, waitMs: number, signal: AbortSignal) =>
      parked(() => mailbox.ask(agentId, query, waitMs, signal), openUrl),
  };
}

/** Waits on the mailbox. An agent with too many open or too many new requests is refused, not parked. */
async function parked(wait: () => Promise<ToolOutcome>, openUrl: OpenUrl, documents = false): Promise<Reply> {
  try {
    return render(await wait(), openUrl, documents);
  } catch (error) {
    if (error instanceof MailboxFull) {
      return {
        kind: 'refused',
        reason: 'too_many_open_requests',
        message: `You already have ${error.open} open Puffer requests. Collect them with get_puffer_answer before asking more.`,
      };
    }
    if (error instanceof TooManyRequests) {
      return {
        kind: 'refused',
        reason: 'rate_limited',
        message: `You made more than ${error.perMinute} new Puffer requests in the last minute. Wait a minute, then try again.`,
      };
    }
    throw error;
  }
}

/** Pure. Structured mirrors ToolOutcome in snake_case; items carry title, text and, when asked, the whole document. */
function render(outcome: ToolOutcome, openUrl: OpenUrl, documents: boolean): Reply {
  const id = outcome.requestId;
  switch (outcome.status) {
    case 'answered': {
      const items = outcome.items.map((item) => ({ ...item, document: documents ? item.document : null }));
      const lines = items.map((item, i) => {
        const facts = [item.date && `modified ${item.date.slice(0, 10)}`, item.folder && `in ${item.folder}`].filter(Boolean);
        const header = `${i + 1}. ${item.title}${facts.length ? ` (${facts.join(', ')})` : ''}`;
        const passage = item.text ? `${header}\n   "${item.text}"` : header;
        return item.document ? `${passage}\n${documentNote(item.document)}` : passage;
      });
      return {
        kind: 'result',
        structured: {
          status: 'answered',
          request_id: id,
          items: items.map(({ title, text, date, folder, fileType, document }) => ({
            title,
            text,
            ...(date ? { date } : {}),
            ...(folder ? { folder } : {}),
            ...(fileType ? { file_type: fileType } : {}),
            ...(document ? { document: documentView(document) } : {}),
          })),
        },
        message: `From the user's Puffer library:\n${lines.join('\n')}`,
        files: items.flatMap(({ document }): DocumentFile[] =>
          document?.kind === 'file' ? [{ name: document.name, mimeType: document.mimeType, data: document.data }] : [],
        ),
      };
    }
    case 'changes': {
      const { events, nextCursor } = outcome.page;
      const preparedAt = outcome.preparedAt === null ? null : wireTime(outcome.preparedAt);
      const lines = [
        ...(preparedAt ? [`The phone is offline; this page was prepared by the phone at ${preparedAt}.`] : []),
        events.length ? "Changes in the user's Puffer library, oldest first:" : 'No changes since your cursor.',
        ...events.map((event, i) => `${i + 1}. ${changeLine(event)}`),
      ];
      lines.push(`Pass since: "${nextCursor}" next time to get only newer changes.`);
      return {
        kind: 'result',
        structured: {
          status: 'answered',
          request_id: id,
          events: events.map((event) =>
            event.kind === 'removed'
              ? { kind: event.kind, at: event.at, title: event.title }
              : { kind: event.kind, at: event.at, title: event.title, source: event.source, excerpt: event.excerpt },
          ),
          next_cursor: nextCursor,
          ...(preparedAt ? { prepared_at: preparedAt } : {}),
        },
        message: lines.join('\n'),
        files: [],
      };
    }
    case 'sources':
      return sourcesReply(id, outcome.sources);
    case 'notes':
      return notesReply(id, outcome.notes);
    case 'noteFolders': {
      const folders = outcome.folders.map(({ name, count }) => ({ name, count }));
      return {
        kind: 'result',
        structured: { status: 'answered', request_id: id, folders },
        message: folders.length
          ? ["Note folders in the user's Puffer:", ...folders.map((f, i) => `${i + 1}. ${f.name} (${f.count})`)].join('\n')
          : 'Puffer has no note folders.',
        files: [],
      };
    }
    case 'note':
      return {
        kind: 'result',
        structured: { status: 'answered', request_id: id, note: noteView(outcome.note) },
        message:
          `${NOTE_HEADER[outcome.of]}\n${noteLine(outcome.note)}${outcome.note.body === null ? '' : `\n\n${outcome.note.body}`}` +
          (outcome.note.truncated ? `\n\n${TRUNCATED}` : ''),
        files: [],
      };
    case 'conflict': {
      const since = outcome.baseVersion === null ? '' : ` since version ${outcome.baseVersion}`;
      return text(
        outcome,
        `The note changed${since}; it is now at version ${outcome.currentVersion}. Nothing was written. Call get_note, ` +
          `apply your edit to the current body, then call update_note with base_version ${outcome.currentVersion}.`,
        { current_version: outcome.currentVersion },
      );
    }
    case 'nothing_found':
      return text(outcome, NOTHING_FOUND[outcome.of]);
    case 'declined':
      return text(outcome, `Puffer on the phone did not run request ${id}. Ask again later only if you still need it.`);
    case 'rate_limited':
      return text(outcome, `Puffer on the phone limits how often an agent can read, so it did not run request ${id}. Wait a minute, then ask again.`);
    case 'disconnected':
      return text(outcome, `The user disconnected you in Puffer, so request ${id} was not run. Connect again only if the user asks you to.`);
    case 'expired':
      return text(outcome, `Request ${id} expired or is unknown. Ask again with ask_puffer if you still need it.`);
    case 'failed':
      return text(outcome, `Puffer could not check this request: ${outcome.reason}`, { reason: outcome.reason });
    case 'processing':
      return text(outcome, `The phone has request ${id} and is still working on it. Call get_puffer_answer with this request_id shortly.`);
    case 'phone_offline': {
      const lastSeen = outcome.lastSeenAt === null ? null : wireTime(outcome.lastSeenAt);
      return text(
        outcome,
        `The phone is offline (${lastSeen ? `last seen ${lastSeen}` : 'not seen since the relay started'}). ` +
          `Request ${id} is queued and will be answered the next time Puffer runs. Call get_puffer_answer with this ` +
          `request_id later. Ask the user to open Puffer on their iPhone; this link opens the app: ${openUrl(id)}`,
        { last_seen_at: lastSeen, open_url: openUrl(id) },
      );
    }
  }
}

const NO_SUCH_NOTE = 'Puffer has no note with this note_id; it may have been deleted. search_notes or list_notes give current ids.';

const NOTHING_FOUND: Record<RequestQuery['kind'], string> = {
  ask: "Puffer found nothing in the user's library that matches this question.",
  recent: "Puffer found no items of this source in the user's library. list_puffer_sources names the sources.",
  changes: 'Puffer found nothing for this read.',
  sources: 'Puffer found nothing for this read.',
  searchNotes: 'Puffer found no note that matches this query.',
  listNotes: 'Puffer found no notes here.',
  listNoteFolders: 'Puffer has no note folders.',
  getNote: NO_SUCH_NOTE,
  createNote: 'Puffer did not create the note.',
  appendToNote: NO_SUCH_NOTE,
  updateNote: NO_SUCH_NOTE,
  deleteNote: NO_SUCH_NOTE,
};

const NOTE_HEADER: Record<SingleNoteKind, string> = {
  getNote: "Note from the user's Puffer:",
  createNote: "Created this note in the user's Puffer:",
  appendToNote: 'Appended to this note:',
  updateNote: 'Updated this note:',
  deleteNote: 'Moved this note to Recently Deleted in Puffer, where the user can restore it:',
};

const TRUNCATED =
  'Puffer cut this body at 200,000 characters; the note is longer. Do not pass it to update_note, which would drop the ' +
  'rest. append_to_note adds to the end.';

/** The agent-facing shape of a note: snake_case, the snippet or body only when the phone sent one. */
function noteView(note: NoteSummary | WireNote): Record<string, unknown> {
  const { id, title, folder, created, modified, version, pinned } = note;
  const text = 'body' in note ? (note.body === null ? {} : { body: note.body }) : note.snippet === null ? {} : { snippet: note.snippet };
  const cut = 'truncated' in note && note.truncated ? { truncated: true } : {};
  return { note_id: id, title, folder, created, modified, version, pinned, ...text, ...cut };
}

function noteLine(note: NoteSummary | WireNote): string {
  const facts = [`in ${note.folder}`, `modified ${note.modified.slice(0, 10)}`, `version ${note.version}`, note.pinned && 'pinned'].filter(Boolean);
  return `${note.title || 'Untitled'} (${facts.join(', ')}) note_id: ${note.id}`;
}

function notesReply(id: RequestId, notes: NoteSummary[]): Reply {
  const lines = notes.map((note, i) => `${i + 1}. ${noteLine(note)}${note.snippet ? `\n   "${note.snippet}"` : ''}`);
  return {
    kind: 'result',
    structured: { status: 'answered', request_id: id, notes: notes.map(noteView) },
    message: notes.length ? ["Notes in the user's Puffer:", ...lines, 'Call get_note with a note_id for the full body.'].join('\n') : 'Puffer found no notes.',
    files: [],
  };
}

/** Names and counts only. */
function sourcesReply(id: RequestId, sources: WireSource[]): Reply {
  const message = sources.length
    ? [
        "Sources in the user's Puffer library, with item counts:",
        ...sources.map((source, i) => `${i + 1}. ${source.name} (${source.count})`),
        'Name one as source in list_puffer_recent or in ask_puffer filters.',
      ].join('\n')
    : 'Puffer lists no sources yet.';
  return {
    kind: 'result',
    structured: { status: 'answered', request_id: id, sources: sources.map(({ name, count }) => ({ name, count })) },
    message,
    files: [],
  };
}

const FILE_MISSING = {
  tooLarge: { flag: 'file_too_large', why: 'the file is over 15 MB' },
  unavailable: { flag: 'file_unavailable', why: 'the phone could not read the file (it may not be downloaded from iCloud)' },
  answerLimit: { flag: 'file_limit_reached', why: 'an answer carries at most 15 MB of files' },
} as const;

/** The agent-facing shape of a whole document. */
function documentView(document: WholeDocument): Record<string, unknown> {
  if (document.kind === 'file') return { file: { name: document.name, mime_type: document.mimeType, data: document.data } };
  return {
    text: document.text,
    ...(document.truncated ? { truncated: true } : {}),
    ...(document.fileMissing ? { [FILE_MISSING[document.fileMissing].flag]: true } : {}),
  };
}

function documentNote(document: WholeDocument): string {
  if (document.kind === 'file') {
    const kb = Math.round((document.data.length * 3) / 4 / 1024);
    return `   The whole document is attached as the original file ${document.name} (${document.mimeType}, ${kb} KB).`;
  }
  const notes = [
    document.fileMissing && `text instead of the file, because ${FILE_MISSING[document.fileMissing].why}`,
    document.truncated && 'cut short',
  ].filter(Boolean);
  return `   The whole document${notes.length ? ` (${notes.join('; ')})` : ''}:\n${document.text}`;
}

const CHANGE_VERB = { added: 'Added', updated: 'Updated', removed: 'Removed' } as const;

function changeLine(event: WireChange): string {
  if (event.kind === 'removed') return `Removed: ${event.title} (${event.at})`;
  const line = `${CHANGE_VERB[event.kind]}: ${event.title} (${event.source}, ${event.at})`;
  return event.excerpt ? `${line}\n   "${event.excerpt}"` : line;
}

function text(
  outcome: Exclude<ToolOutcome, { status: 'answered' | 'changes' | 'sources' | 'notes' | 'noteFolders' | 'note' }>,
  message: string,
  extra: Record<string, unknown> = {},
): Reply {
  return { kind: 'result', structured: { status: outcome.status, request_id: outcome.requestId, ...extra }, message, files: [] };
}
