// The HTTP API: the MCP tools as JSON over plain HTTP, for agents that cannot speak MCP. Same ak_ keys, same
// mailbox and limits, and operations.ts words every answer, so an agent hears the same thing either way. Errors are
// {error, message}. The key goes only in the Authorization header, because a key in a URL ends up in logs.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { z } from 'zod';

import { NOTE_OPERATIONS, NOTES_INTRO } from './notes';
import { LINK_INTERVAL_S } from './oauth';
import {
  ASK_DESCRIPTION,
  ASK_FILTERS,
  ASK_QUERIES,
  CHANGES_DESCRIPTION,
  GET_ANSWER_DESCRIPTION,
  RECENCY,
  RECENT_DESCRIPTION,
  SOURCES_DESCRIPTION,
  type Operations,
  type Reply,
  type Structured,
} from './operations';
import { AskArgs, GetAnswerArgs, GetChangesArgs, RecentArgs, SourcesArgs, type AgentId } from './protocol';

/** Many HTTP tool runners give up near 30 s, so the default stays below that with room for the network. */
const DEFAULT_WAIT_S = 25;
const MAX_WAIT_S = 50;
const MAX_ASK_BODY_BYTES = 8 * 1024;
/** A note body of 200,000 UTF-16 units is at most 600 KB of UTF-8, plus JSON escaping. */
const MAX_NOTE_BODY_BYTES = 1024 * 1024;
/** The per-agent limit is new requests per fixed minute; a refused caller waits at most this long. */
const RETRY_AFTER_S = 60;
const NO_STORE = { 'cache-control': 'no-store' };

const Wait = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_S)
  .default(DEFAULT_WAIT_S)
  .describe(
    `Seconds to wait for the phone before returning the current status, 0 to ${MAX_WAIT_S}, default ${DEFAULT_WAIT_S}. ` +
      'The relay may cap it lower. A status that is not final yet comes with a request_id for get_puffer_answer.',
  );

type Endpoint = ReturnType<typeof endpoint>;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
/** Methods whose input is a JSON body; the others take the query string. Path parameters join either. */
const hasBody = (method: Method) => method === 'POST' || method === 'PATCH';

function endpoint<S extends z.ZodType<{ wait: number }>>(spec: {
  method: Method;
  /** OpenAPI form, below the /v1 server URL. */
  path: string;
  description: string;
  input: S;
  maxBodyBytes?: number;
  run: (operations: Operations, agentId: AgentId, args: z.output<S>, waitMs: number, signal: AbortSignal) => Promise<Reply>;
}) {
  const { method, path, description, input, run, maxBodyBytes = MAX_ASK_BODY_BYTES } = spec;
  return {
    method,
    path,
    description,
    maxBodyBytes,
    input: input as z.ZodType,
    /** Parses the raw input, or returns why it is invalid. The wait never exceeds the relay's budget. */
    call(
      operations: Operations,
      agentId: AgentId,
      raw: unknown,
      budgetMs: number,
      signal: AbortSignal,
    ): Promise<Reply> | z.ZodError {
      const parsed = input.safeParse(raw);
      if (!parsed.success) return parsed.error;
      return run(operations, agentId, parsed.data, Math.min(parsed.data.wait * 1000, budgetMs), signal);
    },
  };
}

/** Keyed by operationId, which is also the MCP tool name, so the descriptions and answers read right on both. */
const ENDPOINTS = {
  ask_puffer: endpoint({
    method: 'POST',
    path: '/ask',
    description: ASK_DESCRIPTION,
    input: AskArgs.extend({ wait: Wait }),
    run: (operations, agentId, args, waitMs, signal) => operations.ask(agentId, args, waitMs, signal),
  }),
  get_puffer_answer: endpoint({
    method: 'GET',
    path: '/answers/{request_id}',
    description: GET_ANSWER_DESCRIPTION,
    input: GetAnswerArgs.extend({ wait: Wait }),
    run: (operations, agentId, args, waitMs, signal) => operations.answer(agentId, args, waitMs, signal),
  }),
  list_puffer_recent: endpoint({
    method: 'GET',
    path: '/recent',
    description: RECENT_DESCRIPTION,
    input: RecentArgs.extend({ wait: Wait }),
    run: (operations, agentId, args, waitMs, signal) => operations.recent(agentId, args, waitMs, signal),
  }),
  list_puffer_sources: endpoint({
    method: 'GET',
    path: '/sources',
    description: SOURCES_DESCRIPTION,
    input: SourcesArgs.extend({ wait: Wait }),
    run: (operations, agentId, _args, waitMs, signal) => operations.sources(agentId, waitMs, signal),
  }),
  get_puffer_changes: endpoint({
    method: 'GET',
    path: '/changes',
    description: CHANGES_DESCRIPTION,
    input: GetChangesArgs.extend({ wait: Wait }),
    run: (operations, agentId, args, waitMs, signal) => operations.changes(agentId, args, waitMs, signal),
  }),
  ...Object.fromEntries(
    NOTE_OPERATIONS.map((note) => [
      note.name,
      endpoint({
        method: note.method,
        path: note.path,
        description: note.description,
        // The table erases each operation's shape; note.query re-parses the arguments with it.
        input: note.input.extend({ wait: Wait }) as unknown as z.ZodType<{ wait: number }>,
        maxBodyBytes: MAX_NOTE_BODY_BYTES,
        run: (operations, agentId, args, waitMs, signal) => operations.note(agentId, note.query(args), waitMs, signal),
      }),
    ]),
  ),
} satisfies Record<string, Endpoint>;

const ROUTES = Object.values(ENDPOINTS).map((endpoint) => ({
  endpoint,
  literal: !endpoint.path.includes('{'),
  pattern: new RegExp(`^/v1${endpoint.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]*)')}$`),
}));

/**
 * The route for this path and method, or the methods the path takes. Null when no route has the path. A literal path
 * such as /v1/notes/search owns that path: DELETE on it is a 405, never delete_note with note_id "search".
 */
function match(path: string, method: string): { endpoint: Endpoint; params: Record<string, string> } | { allow: Method[] } | null {
  const matching = ROUTES.flatMap((route) => {
    const found = route.pattern.exec(path);
    return found ? [{ ...route, params: { ...found.groups } }] : [];
  });
  const owners = matching.some((route) => route.literal) ? matching.filter((route) => route.literal) : matching;
  const hit = owners.find((route) => route.endpoint.method === method);
  if (hit) return { endpoint: hit.endpoint, params: hit.params };
  return owners.length ? { allow: [...new Set(owners.map((route) => route.endpoint.method))] } : null;
}

/**
 * Query values arrive as strings. Numbers and booleans are converted so zod reports the real rule (an integer, at
 * most 50) instead of a type mismatch. A cursor stays a string even when it looks like a number.
 */
function queryValue(key: string, value: string): unknown {
  if ((key === 'wait' || key === 'limit') && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...NO_STORE, ...headers });
  res.end(JSON.stringify(body));
}

function refuse(res: ServerResponse, status: number, error: string, message: string, headers: Record<string, string> = {}): void {
  send(res, status, { error, message }, headers);
}

export type AgentApiDeps = {
  /** The relay's wait budget; no call waits longer, whatever it asks for. */
  waitMs: number;
  /** The agent an Authorization header names and its tenant's operations, or null for a missing, unknown or revoked key. */
  authenticate: (authorization: string | undefined) => { agentId: AgentId; operations: Operations } | null;
  /** The WWW-Authenticate value /mcp sends, so OAuth clients find the same resource metadata. */
  challenge: () => string;
  /** Reads and parses a JSON body of at most maxBytes; throws the relay's 400 or 413 otherwise. */
  readJson: (req: IncomingMessage, maxBytes: number) => Promise<unknown>;
};

/** Serves /v1/ask, /v1/answers/<id>, /v1/recent, /v1/sources, /v1/changes and /v1/notes/... Returns false for any other path. */
export async function serveAgentApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: AgentApiDeps): Promise<boolean> {
  const route = match(url.pathname, req.method ?? '');
  if (!route) return false;
  if ('allow' in route) {
    refuse(res, 405, 'method_not_allowed', `Use ${route.allow.join(' or ')} for this path.`, { allow: route.allow.join(', ') });
    return true;
  }
  const { endpoint } = route;
  const agent = deps.authenticate(req.headers.authorization);
  if (!agent) {
    refuse(res, 401, 'invalid_token', 'Send the agent key Puffer showed you in the header Authorization: Bearer ak_...', {
      'www-authenticate': deps.challenge(),
    });
    return true;
  }

  let raw: unknown;
  if (hasBody(endpoint.method)) {
    const body = await deps.readJson(req, endpoint.maxBodyBytes);
    raw = typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...body, ...route.params } : body;
  } else {
    const repeated = [...new Set(url.searchParams.keys())].find((key) => url.searchParams.getAll(key).length > 1);
    if (repeated) {
      refuse(res, 400, 'invalid_request', `The query parameter ${repeated} appears more than once.`);
      return true;
    }
    raw = { ...Object.fromEntries([...url.searchParams].map(([key, value]) => [key, queryValue(key, value)])), ...route.params };
  }

  const stopped = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stopped.abort();
  });
  const called = endpoint.call(agent.operations, agent.agentId, raw, deps.waitMs, stopped.signal);
  if (called instanceof z.ZodError) {
    const problems = called.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
    refuse(res, 400, 'invalid_request', problems.join('; '));
    return true;
  }
  const reply = await called;
  if (reply.kind === 'refused') {
    refuse(res, 429, reply.reason, reply.message, reply.reason === 'rate_limited' ? { 'retry-after': String(RETRY_AFTER_S) } : {});
    return true;
  }
  send(res, 200, { ...reply.structured, message: reply.message });
  return true;
}

const STATUS_MEANING: Record<Structured['status'], string> = {
  answered:
    'Settled. An ask or a recent listing carries items; a changes read carries events; a sources read carries sources; a note call carries notes, folders or a note.',
  nothing_found: "Settled. Nothing in the user's library matches.",
  declined: 'Settled. Puffer on the phone did not run it. Ask again later only if you still need it.',
  rate_limited: 'Settled. Puffer on the phone limits how often an agent can read and did not run it. Wait a minute, then ask again.',
  disconnected: 'Settled. The user disconnected you in Puffer, so it was not run. Further calls answer 401.',
  conflict: 'Settled. update_note only: the note changed since base_version and nothing was written. current_version is its version now: get_note, reapply, retry.',
  expired: 'Settled. The request expired or is unknown; ask again if you still need it.',
  failed: 'Settled. The phone could not check the request; reason says why. Ask again later if you still need it.',
  processing: 'Not final. The phone has it; call get_puffer_answer shortly.',
  phone_offline: 'Not final. Queued until Puffer runs; call get_puffer_answer later and ask the user to open open_url.',
};

const text = (description: string) => ({ type: 'string', description });
const integer = (description: string) => ({ type: 'integer', description });

const RESULT_SCHEMA = {
  type: 'object',
  required: ['status', 'request_id', 'message'],
  properties: {
    status: {
      type: 'string',
      enum: Object.keys(STATUS_MEANING),
      description: Object.entries(STATUS_MEANING)
        .map(([status, meaning]) => `${status}: ${meaning}`)
        .join(' '),
    },
    request_id: text('Pass it to get_puffer_answer while the status is not final.'),
    message: text('The same result in words, written for you to read.'),
    items: {
      type: 'array',
      description: 'answered ask or recent listing: what the phone shared, newest first for a listing or sort recent.',
      items: {
        type: 'object',
        properties: {
          title: text('Title.'),
          text: { type: ['string', 'null'], description: 'The matching passage.' },
          date: { type: 'string', format: 'date-time', description: 'When the file was last modified.' },
          folder: text('The file\'s folder, starting with its source.'),
          file_type: text('The file extension, such as pdf or md.'),
          document: {
            type: 'object',
            description: 'include_documents: the whole document, once per document per answer. Its text, or its original file.',
            properties: {
              text: text('The full text, built from the document as Puffer indexed it.'),
              truncated: { type: 'boolean', description: 'The text was cut: about 200,000 characters per document, 400,000 per answer.' },
              file: {
                type: 'object',
                description: 'include_documents file: the original file.',
                properties: { name: text('The file name.'), mime_type: text('Such as application/pdf or text/markdown.'), data: text('Base64 file bytes.') },
              },
              file_too_large: { type: 'boolean', description: 'include_documents file: the file is over 15 MB, so its text came instead.' },
              file_unavailable: { type: 'boolean', description: 'include_documents file: the phone could not read the file (for example not downloaded from iCloud), so its text came instead.' },
              file_limit_reached: { type: 'boolean', description: 'include_documents file: the answer already carries 15 MB of files, so its text came instead.' },
            },
          },
        },
      },
    },
    events: {
      type: 'array',
      description: 'answered changes read: the changes, oldest first. A removed item has kind, at and title only.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['added', 'updated', 'removed'] },
          at: { type: 'string', format: 'date-time' },
          title: text('Title.'),
          source: text('Where it came from, such as a folder.'),
          excerpt: { type: ['string', 'null'], description: 'A short excerpt of the document.' },
        },
      },
    },
    sources: {
      type: 'array',
      description: 'answered sources read: the sources, by name.',
      items: {
        type: 'object',
        properties: {
          name: text('The source name to pass as source, such as a folder name.'),
          count: integer('Items in this source.'),
        },
      },
    },
    next_cursor: text('answered changes read: pass it as since next time.'),
    prepared_at: { type: 'string', format: 'date-time', description: 'Set when the phone was offline and prepared this page earlier.' },
    open_url: { type: 'string', format: 'uri', description: 'A link that opens Puffer on the phone. Give it to the user.' },
    last_seen_at: { type: ['string', 'null'], format: 'date-time', description: 'phone_offline: when the phone last synced.' },
    reason: text('failed: why the phone could not check the request, safe to show the user.'),
    notes: {
      type: 'array',
      description: 'answered search_notes or list_notes: the notes, with a snippet and no body.',
      items: { $ref: '#/components/schemas/Note' },
    },
    folders: {
      type: 'array',
      description: 'answered list_note_folders.',
      items: { type: 'object', properties: { name: text('The folder name.'), count: integer('Notes in it.') } },
    },
    note: { $ref: '#/components/schemas/Note' },
    current_version: integer('conflict: the version the note has now.'),
  },
};

const NOTE_SCHEMA = {
  type: 'object',
  description: 'A note. get_note, create_note, append_to_note and update_note carry body; delete_note does not.',
  properties: {
    note_id: text('Pass it to get_note, update_note, append_to_note or delete_note.'),
    title: text('Title.'),
    folder: text('Folder name.'),
    created: { type: 'string', format: 'date-time' },
    modified: { type: 'string', format: 'date-time' },
    version: integer('Bumped by every change. Pass it to update_note as base_version.'),
    pinned: { type: 'boolean' },
    snippet: text('search_notes or list_notes: the matching passage or the opening.'),
    body: text('The full note in Markdown.'),
    truncated: { type: 'boolean', description: 'The body was cut at 200,000 characters. Do not update_note with it, which would drop the rest; append_to_note adds to the end.' },
  },
};

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error', 'message'],
  properties: { error: text('A machine-readable code.'), message: text('What went wrong, in words.') },
};

/** JSON Schema of a zod schema's input, without the $schema key OpenAPI does not need. */
type ObjectSchema = { properties?: Record<string, { description?: string } & Record<string, unknown>>; required?: string[] };

function jsonSchema(schema: z.ZodType): ObjectSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as ObjectSchema & { $schema?: string };
  return rest;
}

function operation(operationId: keyof typeof ENDPOINTS) {
  const { method, path, description, input } = ENDPOINTS[operationId];
  const schema = jsonSchema(input);
  const inPath = (name: string) => path.includes(`{${name}}`);
  const parameter = ([name, { description: about, ...property }]: [string, { description?: string } & Record<string, unknown>]) => ({
    name,
    in: inPath(name) ? 'path' : 'query',
    required: inPath(name) || (schema.required?.includes(name) ?? false),
    description: about,
    schema: property,
  });
  const properties = Object.entries(schema.properties ?? {});
  const errors = { $ref: '#/components/responses/Error' };
  const body = {
    ...schema,
    properties: Object.fromEntries(properties.filter(([name]) => !inPath(name))),
    ...(schema.required ? { required: schema.required.filter((name) => !inPath(name)) } : {}),
  };
  return {
    operationId,
    summary: operationId.replaceAll('_', ' '),
    description,
    ...(hasBody(method)
      ? {
          parameters: properties.filter(([name]) => inPath(name)).map(parameter),
          requestBody: { required: true, content: { 'application/json': { schema: body } } },
        }
      : { parameters: properties.map(parameter) }),
    responses: {
      '200': { description: 'The result.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } } },
      '400': errors,
      '401': errors,
      ...(hasBody(method) ? { '413': errors } : {}),
      '429': errors,
    },
  };
}

/** OpenAPI 3.1 for every operation. `serverUrl` is the relay's public base plus /v1. */
export function openApiDocument(serverUrl: string): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]) {
    const { path, method } = ENDPOINTS[id];
    paths[path] = { ...paths[path], [method.toLowerCase()]: operation(id) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Puffer',
      version: '1',
      description:
        "Read and write the user's notes, and ask their phone-local library (documents and notes), through the " +
        `Puffer app on their iPhone. ${NOTES_INTRO} ` +
        'Calls can wait up to `wait` seconds; a status that is not final comes with a request_id to collect later ' +
        'with get_puffer_answer. Authenticate with the agent key Puffer showed when the user connected you, as ' +
        'Authorization: Bearer ak_... ' +
        RECENCY,
    },
    servers: [{ url: serverUrl }],
    security: [{ agentKey: [] }],
    paths,
    components: {
      securitySchemes: {
        agentKey: { type: 'http', scheme: 'bearer', description: 'The ak_ key Puffer showed once when the user connected this agent.' },
      },
      schemas: { Result: RESULT_SCHEMA, Error: ERROR_SCHEMA, Note: NOTE_SCHEMA },
      responses: {
        Error: { description: 'Bad input (400), unknown key (401), body too large (413) or too many requests (429).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  };
}

/**
 * GET /start: what an agent that has only this URL needs, as Markdown. It holds no secret: the user can paste
 * "Connect to my Puffer: <base>/start" into any chat. `base` is the relay's public base.
 */
export function startDocument(base: string): string {
  return `# Connect to Puffer

${NOTES_INTRO} It also searches the user's documents on the phone.

You do not have a key yet. Get one with the three steps below. Do not ask the user for a key.

## 1. Ask to connect

    POST ${base}/v1/connect
    Content-Type: application/json

    {"name": "<your name as the user knows you, 1 to 60 characters>"}

The reply:

    {"connect_id": "cn_...", "approve_url": "${base}/c/...", "poll_token": "...", "expires_in": 600, "interval": ${LINK_INTERVAL_S}}

## 2. Send the user the approve_url

Send approve_url to the user, for example: "Open this on your iPhone to let me use Puffer: <approve_url>". The link opens Puffer, where the user approves or declines connecting you. That is the only approval: once connected, you can read and write the user's notes and documents. Keep poll_token to yourself.

## 3. Collect your key

    POST ${base}/v1/connect/<connect_id>/token
    Authorization: Bearer <poll_token>
    Content-Type: application/json

    {"wait": 25}

With wait, the relay holds the call up to that many seconds (at most 25) until the user decides. Repeat the call until you get the key or a final error. Errors are JSON with error and message:

- 400 authorization_pending: The user has not decided yet. Call again.
- 400 slow_down: You called too soon. Leave interval seconds between calls, or pass wait.
- 400 access_denied: The user declined. Do not ask to connect again unless the user asks you to.
- 400 expired_token: The request ended after expires_in seconds, or its key was already collected. Start again at step 1 only if the user still wants to connect.

Success is 200 with {"key": "ak_...", "base_url": "${base}/v1", "openapi_url": "${base}/openapi.json"}. Puffer sends the key only once, so store it.

### Instead of polling: a callback

If you can receive webhooks, add "callback_url": "https://..." to the body of step 1. When the user decides or the request expires, the relay POSTs once to that URL:

    {"event": "connect.approved", "connect_id": "cn_...", "timestamp": "2026-01-01T12:00:00Z"}

event is connect.approved, connect.declined or connect.expired. The body never holds your key. Verify the headers webhook-id, webhook-timestamp and webhook-signature before you trust it: webhook-signature is "v1," plus the base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<raw body>", keyed with the UTF-8 bytes of your poll_token. On connect.approved, call the step 3 endpoint once, without wait, to collect the key. If no callback arrives, poll as in step 3.

Send the key only to ${base}, in the header Authorization: Bearer <key>. Never send it anywhere else, and never show it to anyone, the user included.

## Use Puffer

Send Authorization: Bearer <key> with every call. Each call takes an optional wait, 0 to ${MAX_WAIT_S} seconds, default ${DEFAULT_WAIT_S}. The full schema is at ${base}/openapi.json.

Ask:

    POST ${base}/v1/ask
    Content-Type: application/json

    {"question": "banana bread recipe"}

${ASK_QUERIES}

    {"question": "invoice", "filters": {"after": "2026-06-01", "before": "2026-07-01"}}

${ASK_FILTERS}

Documents come as the matching passage. Add "include_documents": "text" to the /ask body (and ?include_documents=text on /answers) to get each matching document's full text in its item's document.text, or "file" to get the original file as base64 in document.file (at most 15 MB of files per answer, otherwise the text with file_too_large, file_unavailable or file_limit_reached).

List the newest documents, newest modified first:

    GET ${base}/v1/recent?source=Apple%20Notes&limit=10

${RECENCY} Over HTTP, sort recent is "sort": "recent" in the /ask body, with an optional "limit" (1 to 20, default 10). /recent takes source, limit (1 to 20, default 10) and include_documents.

List the source names you can use, with item counts and no content:

    GET ${base}/v1/sources

Collect an answer later:

    GET ${base}/v1/answers/<request_id>?wait=25

Read what changed in the library:

    GET ${base}/v1/changes?since=<next_cursor>

Omit since on the first call. Remember next_cursor from every changes answer and pass it as since next time, so you get only newer changes.

## Notes

Puffer keeps the user's notes as Markdown in folders. Read and write them:

    GET    ${base}/v1/notes/search?query=packing%20list&limit=10    search (sort=relevance or recent, folder=...)
    GET    ${base}/v1/notes?folder=Recipes&limit=20                  newest first
    GET    ${base}/v1/notes/folders                                  folder names and counts
    GET    ${base}/v1/notes/<note_id>                                the full body and version
    POST   ${base}/v1/notes                                          {"title": "...", "body": "<Markdown>", "folder": "..."}
    POST   ${base}/v1/notes/<note_id>/append                         {"text": "<Markdown>"}
    PATCH  ${base}/v1/notes/<note_id>                                {"body": "<Markdown>", "base_version": <version>}
    DELETE ${base}/v1/notes/<note_id>                                moves it to Recently Deleted

Searches and listings return note_id, title, folder, dates, version and a snippet; get the body with GET /v1/notes/<note_id>. To edit, get the note, change its body and PATCH it with the version you read. If the note changed in between, the status is conflict with current_version: get it again, reapply your edit and retry. To add to the end, append needs no version.

## What each status means

Every answer has status, request_id and message.

- answered: Quote the excerpts in items and name each item's title. Add nothing the items do not say.
- nothing_found: Nothing matched this query. If every query found nothing, tell the user Puffer found nothing. Do not guess.
- processing: The phone is working on it. Fetch the answer shortly with GET /v1/answers/<request_id>.
- phone_offline: Ask the user to open Puffer with the open_url link, then fetch the answer later with GET /v1/answers/<request_id>.
- declined: Puffer on the phone did not run the request. Ask again later only if you still need it.
- rate_limited: Puffer on the phone limits how often you can read. Wait a minute, then ask again.
- disconnected: The user disconnected you in Puffer. Connect again only if the user asks you to.
- conflict: update only. The note changed since your base_version and nothing was written; current_version is its version now.
- expired: The request ran out. Ask again only if you still need the answer.
- failed: Puffer could not check the request on the phone; reason says why. Tell the user, and ask again later only if you still need the answer.

A 401 means the user removed you in Puffer. Connect again only if the user asks you to. A 429 means too many requests: wait as long as Retry-After says, or collect your open requests first.
`;
}
