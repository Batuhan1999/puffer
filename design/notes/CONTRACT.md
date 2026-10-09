# Notes and multi-tenant wire contract (protocol v1, additive)

Status: fixed 2026-10-09 by the relay owner. Later changes are listed here, newest first, with the date.

- 2026-10-09, offline write changelog: while the phone is offline, agent note writes are queued on the relay and answered `queued` instead of `phone_offline` (section 5). The phone receives them as ordinary `createNote`, `appendToNote`, `updateNote` and `deleteNote` requests with the new optional fields `queued`, `queuedAt` and, for a create, `noteId` (section 3a). Outcomes and acks are unchanged. Also: `SyncResponse.connects` and `approvedBy` on outcomes are gone (a phone that still sends `approvedBy` has it dropped).

- 2026-10-09, OAuth sessions (relay only): an OAuth client now gets a 1-hour signed `at_` access token and a rotating 90-day `rt_` refresh token instead of the connection's `ak_` key, which no longer leaves the relay. The phone still approves by adding the connection's `keyDigest`, and removing that agent still ends access at once. `revokedKeys` also lists the agent of a session revoked for refresh token reuse or 90 days idle. No wire field changed.
- 2026-10-09, photos removed from the app: agent-facing texts describe the library as notes and documents. The agent schemas no longer offer `image_size`, `include_images` or the `kind` filter (photo or document), so the relay never sends `imageSize` or `filters.kind` again. The wire fields themselves are unchanged. Nothing in sections 1 to 4 changed.
- 2026-10-09, before any implementation shipped: no permission model. Every connected agent reads and writes everything; the phone never asks per request. Note requests are never reviewed, so the phone answers them at once and never sends `awaitingUser` for them (section 4), `approvedBy` on a note answer is always `grant`, and `/open/<id>` sends note requests to `puffer://agents`, not to a review screen (section 3). Connecting still needs the user's one approval of the link on the phone (section 2, unchanged).

The relay schema in `relay/src/protocol.ts` is authoritative once implemented. This file is what the phone codes against. All JSON. Timestamps are UTC ISO 8601 at whole seconds (`2026-10-09T14:02:11Z`). As today, an absent key and `null` mean the same in phone-to-relay bodies. In relay-to-phone requests, an optional field that is not set is absent.

## 1. Device registration (no pairing link needed)

```
POST /v1/device/register
Content-Type: application/json
Authorization: Bearer <Better Auth session token of the signed-in account>

{"v": 1}
```

The account's session token (relay/README.md, Accounts); the device belongs to that account. Without a valid session the relay answers `401 {"error": "sign_in_required"}` (only a relay started with `--dev-open-register` skips this), and past the per-account cap `403 {"error": "device_limit"}`. The body may be empty. Replies:

- `200 {"v": 1, "deviceId": "tn_<22 chars>", "deviceKey": "dk_<43 chars>"}` with `Cache-Control: no-store`. The relay stores only the SHA-256 digest of the key, so the phone must keep the key (Keychain) and use it exactly as a key from a `puffer://pair` link: `Authorization: Bearer dk_...` on `/v1/device/sync` and the device endpoints below. `deviceId` is for display and support only.
- `429 {"error": "rate_limited", "message": "..."}` with `Retry-After: <seconds>`. Five registrations per caller address per hour.
- `503 {"error": "capacity", "message": "..."}`. The relay holds its maximum number of devices.

Each device is its own tenant: its agents, requests, change pages, read cursors, webhooks and connections are invisible to every other device. The pairing link flow keeps working for the device the relay minted at first start.

## 2. Connections: fetch by link, then confirm

The relay no longer lists waiting connections in the sync response, and `SyncResponse` has no `connects` field. A phone learns about a connection only by being opened through its approve link, `puffer://connect/<id>?link=<secret>`, and fetching it:

```
GET /v1/device/connects/by-link/<secret>
Authorization: Bearer dk_...
```

`<secret>` is the 32-character `link` value (`[A-Za-z0-9_-]{32}`). Replies, all `no-store`:

- `200 {"v": 1, "connect": WireConnect}`. `WireConnect` is unchanged: `{id, origin: "oauth" | "link", clientName, keyDigest, requestedAt, expiresAt}`, plus `clientHost` (string or null) and `redirectHost` for `origin: "oauth"`.
- `404 {"error": "not_found", "message": "..."}`. Unknown secret, connection over, or confirmed by another device.
- `401` for a missing or unknown device key.

Then confirm, unchanged in shape: `POST /v1/device/connects/<id>/confirm` with `{"v": 1, "link": "<secret>"}` replies `confirmed`, `wrongCode` (with `attemptsLeft`), `declined` or `gone`. A `confirmed` reply claims the connection for this device. From then on it is approved only when this device's registry holds `keyDigest`, and the key it hands out reaches only this device's data. A connection another device confirmed answers `gone`. Declining is unchanged (`connectDeclines` in the sync body, by id).

## 3. Note requests

A phone receives note requests only when its sync body lists their kinds in `requestKinds`, for example `["ask", "recent", "changes", "sources", "searchNotes", "listNotes", "listNoteFolders", "getNote", "createNote", "appendToNote", "updateNote", "deleteNote"]`. For a phone that does not list a kind, the relay answers the agent `failed` ("Puffer on the iPhone is too old...") and never sends the request.

Every `WireRequest` keeps `{id, agentId, askedAt, expiresAt}` and adds `kind` plus the fields below. There is no per-request consent: the phone runs the operation for any connected agent and answers at once. The relay only carries it.

| kind | fields | notes |
| --- | --- | --- |
| `searchNotes` | `query: string` (1 to 500), `folder?: string`, `sort: "relevance" \| "recent"`, `limit: int` (1 to 50) | The relay always sends `sort` (default `relevance`) and `limit` (default 10). `recent` means every confident match, newest `modified` first. |
| `listNotes` | `folder?: string`, `limit: int` (1 to 100) | Newest `modified` first. The relay always sends `limit` (default 20). |
| `listNoteFolders` | none | |
| `getNote` | `noteId: string` | |
| `createNote` | `title?: string` (1 to 300), `body: string` (Markdown, 0 to 200,000 UTF-16 units), `folder?: string` | No title: the phone derives it from the body, as Apple Notes does. No folder: the default folder. |
| `appendToNote` | `noteId: string`, `text: string` (1 to 50,000) | The phone appends `text` as a new paragraph at the end of the body. |
| `updateNote` | `noteId: string`, `body: string` (0 to 200,000), `baseVersion: int` | Replaces the whole body. A stale `baseVersion` answers `conflict`. |
| `deleteNote` | `noteId: string` | Moves the note to Recently Deleted. |

`folder` is a folder name, 1 to 200 characters. A `noteId` is minted by the phone and must match `^[A-Za-z0-9_-]{1,64}$` (a UUID string fits).

`GET /open/<request id>` redirects to `puffer://agents` for a note request, as for `changes` and `sources`: there is nothing to review.

## 3a. Queued writes (offline write changelog)

A note write an agent makes while the phone is offline is queued on the relay, at most `--queued-ttl-ms` (7 days by default), and handed over on the phone's next sync like any other request, in the order the agents wrote them. It carries these extra fields, absent on every other request:

| field | value |
| --- | --- |
| `queued` | `true` |
| `queuedAt` | datetime: when the relay queued it |
| `noteId` (on `createNote` only) | The id the relay already told the agent: a lowercase UUID, the phone's own format (`NoteBook.newID`). The phone creates the note with exactly this id, and the agent may already have queued appends, updates or a delete against it. |

The phone applies them:

- In the order received for each note, and once per request id (the `applied` table): a request id seen before returns its recorded outcome and writes nothing. A `createNote` whose `noteId` already exists is a replay and answers that note.
- `appendToNote` appends as usual.
- `updateNote` whose `baseVersion` is no longer current, because the user edited the note in the meantime, is merged line by line (`NoteMerge.merge`: base is the body at `baseVersion`, the agent's lines come first where they touch) instead of answering `conflict`. Only when the phone no longer has the body at `baseVersion` does it answer `conflict`.
- `deleteNote` moves the note to Recently Deleted.
- History marks the entry as written while offline.

The outcome and ack are unchanged (section 4). The relay drops the write's text once it settles. A phone that does not know the fields runs the write as a live one.

## 4. Note outcomes (phone outbox)

The outbox keeps its outcome kinds. Note requests use them like this:

- `answered`, with exactly one of the new payload fields below set (and `items` empty or absent). `approvedBy` is no longer read; the relay drops it.
- `nothingFound`: no match for a search or list, or `noteId` names no note (including one already in Recently Deleted).
- `declined`: the phone refused without running it, for example under a rate limit. Not a user decision.
- `failed` with `reason` (user-safe, 1 to 200 characters).
- `expired`.
- New: `{"kind": "conflict", "id": "rq_...", "currentVersion": <int>}`. Only for `updateNote` whose `baseVersion` is not the note's current version. Final.

The phone never sends `awaitingUser` for a note request. If it does, the agent is told `processing`, not `waiting_for_user`.

New nullable fields on `answered`:

| request kind | field | value |
| --- | --- | --- |
| `searchNotes`, `listNotes` | `notes` | `NoteSummary[]`, 1 to 100 |
| `listNoteFolders` | `folders` | `[{"name": string, "count": int >= 0}]`, 1 to 200 |
| `getNote`, `createNote`, `appendToNote`, `updateNote` | `note` | `Note` after the operation, with `body` |
| `deleteNote` | `note` | `Note` as it was, `body` absent or null |

```
NoteSummary = {
  "id": string,            // the noteId
  "title": string,         // 0 to 300
  "folder": string,        // 1 to 200
  "created": datetime,
  "modified": datetime,
  "version": int >= 0,     // bumped by every change to the note
  "pinned": bool,
  "snippet": string | null // 0 to 1,000 UTF-16 units; the matching passage for a search, the opening for a list
}

Note = {
  "id", "title", "folder", "created", "modified", "version", "pinned",  // as above
  "body": string | null    // Markdown, 0 to 200,000 UTF-16 units
}
```

An `answered` outcome whose payload does not fit its request (for example `notes` for a `getNote`) settles as `expired`, as today. The relay strips unknown fields. The ack for `conflict` echoes `conflict`.

## 5. What agents see (for reference, relay-side)

MCP tools: `search_notes`, `list_notes`, `list_note_folders`, `get_note`, `create_note`, `append_to_note`, `update_note`, `delete_note`, with snake_case arguments (`note_id`, `base_version`). HTTP: `GET /v1/notes/search`, `GET /v1/notes`, `GET /v1/notes/folders`, `GET /v1/notes/{note_id}`, `POST /v1/notes`, `POST /v1/notes/{note_id}/append`, `PATCH /v1/notes/{note_id}`, `DELETE /v1/notes/{note_id}`. Statuses: `answered`, `nothing_found`, `declined`, `failed`, `expired`, `conflict` (with `current_version`), plus `processing` and `phone_offline`, collected with `get_puffer_answer` as for asks. A write while the phone is offline answers `queued` (with `queued_at`, `kept_until`, `open_url`, and `note_id` for a create), also collected with `get_puffer_answer`; past the device's queue caps it is refused with `429 offline_queue_full` (MCP: an error result) and nothing is queued. No note status is `waiting_for_user`. Agent-facing texts no longer describe access levels or per-request approval; they say that a connected agent can read and write the user's notes and documents.
