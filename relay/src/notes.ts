// The note operations agents call. One table drives the MCP tools (mcp.ts), the HTTP endpoints and OpenAPI (http.ts).
// The phone runs every one for any connected agent; the relay only carries it (design/notes/CONTRACT.md).

import { z } from 'zod';

import { NOTE_APPEND_MAX, NOTE_BODY_MAX, NoteId, type NoteQuery } from './protocol';

export type NoteOperation = {
  /** MCP tool name and OpenAPI operationId. */
  name: string;
  description: string;
  input: z.ZodObject;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** OpenAPI form, below the /v1 server URL. */
  path: string;
  /** Parses the agent's arguments into the request the phone gets; keys it does not know, such as wait, are dropped. */
  query: (args: unknown) => NoteQuery;
};

function operation<S extends z.ZodObject>(spec: Omit<NoteOperation, 'input' | 'query'> & { input: S; query: (args: z.output<S>) => NoteQuery }): NoteOperation {
  return { ...spec, query: (args) => spec.query(spec.input.parse(args)) };
}

const NoteIdArg = NoteId.describe('The note_id from search_notes, list_notes or get_note.');
const Folder = z.string().trim().min(1).max(200).describe('A folder name, as list_note_folders names it.');
const LATER = ' Like ask_puffer it can return processing or phone_offline with a request_id: call get_puffer_answer with it later.';

/** How writes behave while the phone is offline. Shared by the write tools and GET /start. */
export const QUEUED_WRITES =
  'While the phone is offline, a write is queued on the relay instead (status queued, with a request_id) and applied ' +
  'when the phone comes back, in the order you wrote, if that is within 7 days. Reads do not see a queued write until then.';
const WRITE_LATER =
  ' It can return processing with a request_id: call get_puffer_answer with it later. ' + QUEUED_WRITES;

/** Shared by GET /start and the OpenAPI description. */
export const NOTES_INTRO =
  "Puffer is a notes app on the user's iPhone. Once connected, you can read and write the user's notes and documents; " +
  'the phone runs each call at once while Puffer is running.';

const SEARCH_LIMIT = { default: 10, max: 50 };
const LIST_LIMIT = { default: 20, max: 100 };

export const NOTE_OPERATIONS: readonly NoteOperation[] = [
  operation({
    name: 'search_notes',
    method: 'GET',
    path: '/notes/search',
    description:
      "Search the user's notes in Puffer by meaning and keywords. query is a short description of 2 to 6 words, not " +
      'the user\'s sentence. folder narrows to one folder. sort relevance (default) ranks by match; recent puts the ' +
      `newest modified first. limit 1 to ${SEARCH_LIMIT.max}, default ${SEARCH_LIMIT.default}. Each note comes with ` +
      'note_id, title, folder, dates, version and a snippet; call get_note for the full body.' +
      LATER,
    input: z.object({
      query: z.string().trim().min(1).max(500).describe('What to find, 2 to 6 words, such as "packing list" or "dentist".'),
      folder: Folder.optional(),
      sort: z.enum(['relevance', 'recent']).optional().describe('relevance (default) or recent: newest modified first.'),
      limit: z.number().int().min(1).max(SEARCH_LIMIT.max).optional().describe(`1 to ${SEARCH_LIMIT.max}, default ${SEARCH_LIMIT.default}.`),
    }),
    query: ({ query, folder, sort, limit }) => ({
      kind: 'searchNotes',
      query,
      ...(folder ? { folder } : {}),
      sort: sort ?? 'relevance',
      limit: limit ?? SEARCH_LIMIT.default,
    }),
  }),
  operation({
    name: 'list_note_folders',
    method: 'GET',
    path: '/notes/folders',
    description: "List the user's note folders in Puffer, with how many notes each holds." + LATER,
    input: z.object({}),
    query: () => ({ kind: 'listNoteFolders' }),
  }),
  operation({
    name: 'list_notes',
    method: 'GET',
    path: '/notes',
    description:
      "List the user's notes in Puffer, newest modified first, optionally in one folder. limit 1 to " +
      `${LIST_LIMIT.max}, default ${LIST_LIMIT.default}. Each note comes with metadata and its opening; call get_note for ` +
      'the full body.' +
      LATER,
    input: z.object({
      folder: Folder.optional(),
      limit: z.number().int().min(1).max(LIST_LIMIT.max).optional().describe(`1 to ${LIST_LIMIT.max}, default ${LIST_LIMIT.default}.`),
    }),
    query: ({ folder, limit }) => ({ kind: 'listNotes', ...(folder ? { folder } : {}), limit: limit ?? LIST_LIMIT.default }),
  }),
  operation({
    name: 'create_note',
    method: 'POST',
    path: '/notes',
    description:
      'Create a note in Puffer. body is Markdown. Without a title, the first line of the body becomes the title; ' +
      'without a folder, the note goes to the default folder. Returns the new note with its note_id and version. ' +
      'Queued while the phone is offline, it returns the note_id the note will have.' +
      WRITE_LATER,
    input: z.object({
      title: z.string().trim().min(1).max(300).optional().describe('The title. Omit it to take the first line of the body.'),
      body: z.string().max(NOTE_BODY_MAX).describe('The note in Markdown.'),
      folder: Folder.optional(),
    }),
    query: ({ title, body, folder }) => ({ kind: 'createNote', ...(title ? { title } : {}), body, ...(folder ? { folder } : {}) }),
  }),
  operation({
    name: 'get_note',
    method: 'GET',
    path: '/notes/{note_id}',
    description:
      'Get one note from Puffer: its full Markdown body and note_id, title, folder, created, modified, version and ' +
      'pinned. Keep version: update_note needs it.' +
      LATER,
    input: z.object({ note_id: NoteIdArg }),
    query: ({ note_id }) => ({ kind: 'getNote', noteId: note_id }),
  }),
  operation({
    name: 'update_note',
    method: 'PATCH',
    path: '/notes/{note_id}',
    description:
      "Replace a note's whole body with new Markdown. Pass base_version, the version your last get_note returned. If " +
      'the note changed since, the status is conflict with current_version: call get_note again, reapply your edit to ' +
      'the current body and retry with that version. To add to the end, append_to_note needs no version. A queued ' +
      'update to a note the user edited since base_version is merged line by line with their edits instead.' +
      WRITE_LATER,
    input: z.object({
      note_id: NoteIdArg,
      body: z.string().max(NOTE_BODY_MAX).describe('The whole new body in Markdown.'),
      base_version: z.number().int().min(0).describe('The version of the note you edited, from get_note.'),
    }),
    query: ({ note_id, body, base_version }) => ({ kind: 'updateNote', noteId: note_id, body, baseVersion: base_version }),
  }),
  operation({
    name: 'delete_note',
    method: 'DELETE',
    path: '/notes/{note_id}',
    description: 'Move a note to Recently Deleted in Puffer, where the user can restore it. Returns the note without its body.' + WRITE_LATER,
    input: z.object({ note_id: NoteIdArg }),
    query: ({ note_id }) => ({ kind: 'deleteNote', noteId: note_id }),
  }),
  operation({
    name: 'append_to_note',
    method: 'POST',
    path: '/notes/{note_id}/append',
    description: 'Append text as a new paragraph at the end of a note. Needs no version, so it never conflicts. Returns the note after the change.' + WRITE_LATER,
    input: z.object({ note_id: NoteIdArg, text: z.string().min(1).max(NOTE_APPEND_MAX).describe('Markdown to add at the end.') }),
    query: ({ note_id, text }) => ({ kind: 'appendToNote', noteId: note_id, text }),
  }),
];
