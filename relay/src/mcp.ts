// The agent-facing surface: the library tools, the note tools (notes.ts) and the puffer.changes event (events/list, subscribe, unsubscribe), served
// statelessly by createMcpHandler, one fresh server per HTTP request bound to the agent the bearer key authenticated.

import { McpServer, type CallToolResult, type ServerCapabilities } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { NOTE_OPERATIONS } from './notes';
import type { Notifier } from './notify';
import {
  ASK_DESCRIPTION,
  CHANGES_DESCRIPTION,
  GET_ANSWER_DESCRIPTION,
  RECENT_DESCRIPTION,
  SOURCES_DESCRIPTION,
  type Operations,
  type Reply,
  type Structured,
} from './operations';
import {
  AskArgs,
  EventsSubscribeParams,
  EventsUnsubscribeParams,
  GetAnswerArgs,
  GetChangesArgs,
  PUFFER_CHANGES,
  RecentArgs,
  SourcesArgs,
  type AgentId,
} from './protocol';

const PUFFER_CHANGES_EVENT = {
  name: PUFFER_CHANGES,
  description:
    "Fires when the user's Puffer library changes. The event carries no content, only data.head, a position in the " +
    'change log. Call get_puffer_changes with your next_cursor to fetch what changed.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: { head: { type: 'integer' } }, required: ['head'] },
};

// The SDK's ServerCapabilities type has no `events` key yet; the object reaches the wire as written.
const EVENTS_CAPABILITY = { events: { listChanged: true } } as ServerCapabilities;

export type McpDeps = {
  operations: Operations;
  waitMs: number;
  notifier: Notifier;
};

export function createAgentServer(agentId: AgentId, deps: McpDeps): McpServer {
  const { operations, waitMs } = deps;
  const server = new McpServer({ name: 'puffer', version: '0.1.0' });

  server.registerTool('ask_puffer', { description: ASK_DESCRIPTION, inputSchema: AskArgs }, async (args, ctx) =>
    toToolResult(await operations.ask(agentId, args, waitMs, ctx.mcpReq.signal)),
  );
  server.registerTool('list_puffer_recent', { description: RECENT_DESCRIPTION, inputSchema: RecentArgs }, async (args, ctx) =>
    toToolResult(await operations.recent(agentId, args, waitMs, ctx.mcpReq.signal)),
  );
  server.registerTool('list_puffer_sources', { description: SOURCES_DESCRIPTION, inputSchema: SourcesArgs }, async (_args, ctx) =>
    toToolResult(await operations.sources(agentId, waitMs, ctx.mcpReq.signal)),
  );
  server.registerTool('get_puffer_changes', { description: CHANGES_DESCRIPTION, inputSchema: GetChangesArgs }, async (args, ctx) =>
    toToolResult(await operations.changes(agentId, args, waitMs, ctx.mcpReq.signal)),
  );
  server.registerTool('get_puffer_answer', { description: GET_ANSWER_DESCRIPTION, inputSchema: GetAnswerArgs }, async (args, ctx) =>
    toToolResult(await operations.answer(agentId, args, waitMs, ctx.mcpReq.signal)),
  );
  for (const note of NOTE_OPERATIONS) {
    server.registerTool(note.name, { description: note.description, inputSchema: note.input }, async (args, ctx) =>
      toToolResult(await operations.note(agentId, note.query(args), waitMs, ctx.mcpReq.signal)),
    );
  }

  server.server.registerCapabilities(EVENTS_CAPABILITY);
  server.server.setRequestHandler('events/list', { params: z.object({}) }, () => ({ events: [PUFFER_CHANGES_EVENT] }));
  server.server.setRequestHandler('events/subscribe', { params: EventsSubscribeParams }, (params) =>
    deps.notifier.subscribe(agentId, params),
  );
  server.server.setRequestHandler('events/unsubscribe', { params: EventsUnsubscribeParams }, (params) =>
    deps.notifier.unsubscribe(agentId, params),
  );

  return server;
}

/**
 * The message is the text content; document files follow it as embedded resources. The file bytes go only there, so
 * structuredContent keeps each file's name and type. A refusal is an error result.
 */
function toToolResult(reply: Reply): CallToolResult {
  if (reply.kind === 'refused') return { isError: true, content: [{ type: 'text', text: reply.message }] };
  return {
    content: [
      { type: 'text', text: reply.message },
      ...reply.files.map(({ name, mimeType, data }) => ({
        type: 'resource' as const,
        resource: { uri: `puffer://documents/${encodeURIComponent(name)}`, mimeType, blob: data },
      })),
    ],
    structuredContent: reply.files.length ? withoutFileData(reply.structured) : reply.structured,
  };
}

type FileItem = { document?: { file?: { data?: string } } };

function withoutFileData(structured: Structured): Structured {
  const items = structured.items as FileItem[] | undefined;
  return {
    ...structured,
    items: items?.map((item) => {
      if (!item.document?.file) return item;
      const { data: _, ...file } = item.document.file;
      return { ...item, document: { ...item.document, file } };
    }),
  };
}
