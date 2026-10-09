# Puffer relay

The relay connects AI agents to the Puffer app on the user's iPhone. Agents call MCP tools at `/mcp`, or the same operations as plain JSON under `/v1` (see [HTTP API](#http-api)). The phone long-polls `/v1/device/sync` and answers each request, including the note operations (`design/notes/CONTRACT.md`). Each phone is a tenant: its agents, requests, change pages, webhooks and connections are invisible to every other phone, and every bearer key resolves to exactly one tenant. Users have accounts (see [Accounts](#accounts)): a signed-in phone registers itself with `POST /v1/device/register` (the account's session token, 5 per caller address per hour, at most `--max-devices-per-user` per account and `--max-devices` in all) and gets its own `dk_` key. The relay keeps requests, change pages, notification settings, and pending OAuth connections in memory, per tenant. It writes six files to disk, all owner-only. `registry.json` holds, per tenant, its id, the device key digest, the id of the account that registered it, when it registered and last synced (to the hour), and each agent's id, name, and key digest; a single-device file from before tenants becomes the first tenant at startup. At startup and every 30 s the relay prunes a device that did not sync within 24 hours of registering, and a device without agents that has not synced for 30 days. Its key then gets `401 unknown_device`, and the phone registers again. Only devices that synced within 30 days, or registered in the last 24 hours, count against `--max-devices`. `oauth-clients.json`, in the same directory, holds the OAuth clients that registered themselves. `oauth-sessions.json` and `oauth-session-key.json` hold the OAuth sessions and the key that signs their access tokens (see [OAuth](#oauth)). `auth.db` (SQLite) holds the accounts, and outside production `auth-secret` holds the key that signs their sessions.

## Run it locally

```sh
npm install
npm run relay
```

The relay starts with no devices and no accounts. Puffer registers itself once the user signs in. To pair a phone with a relay by hand, create an account, register a device with its session token, and open the link on the phone:

```sh
token=$(curl -s -X POST http://localhost:8787/api/auth/sign-up/email -H 'content-type: application/json' -H 'expo-origin: puffer://' \
  -d '{"name":"Me","email":"me@example.com","password":"a long password"}' | node -p 'JSON.parse(require("fs").readFileSync(0)).token')
key=$(curl -s -X POST http://localhost:8787/v1/device/register -H "Authorization: Bearer $token" | node -p 'JSON.parse(require("fs").readFileSync(0)).deviceKey')
echo "puffer://pair?relay=http%3A%2F%2Flocalhost%3A8787&key=$key"
```

`npm run e2e` starts its own relay on a free port, plays two phones and their agents against it (over MCP, the HTTP API, OAuth, and connect by message), starts a second relay without `--dev-callbacks` to check the address policy and a third from a hand-written `registry.json` to check pruning, and prints one line per assertion. Its relays register devices without accounts: the npm script sets `PUFFER_OPEN_REGISTER=1` (see below), which every relay it starts inherits. `npm run e2e:auth` tests accounts, registration, device self-management and the admin routes.

## Flags and environment

A flag wins over its environment variable.

| Flag | Environment | Default | Effect |
| --- | --- | --- | --- |
| `--host` | `HOST` | `127.0.0.1` | Address the relay binds. |
| `--port` | `PORT` | `8787` | Port the relay binds. `0` picks a free port. |
| `--state` | `PUFFER_STATE` | `.state/registry.json` | Path of the registry file. |
| `--public-url` | `PUFFER_PUBLIC_URL` | `http://localhost:<bound port>` | Origin that agents and the phone use. It goes into approve URLs and `/open/<id>` links, and its host passes the Host header check. |
| `--wait-ms` | none | `50000` | How long an MCP tool call waits for the phone before it returns a status. An HTTP API call waits its `wait` parameter, at most this long. |
| `--dev-callbacks` | `PUFFER_DEV_CALLBACKS=1` | off | Allows plain http callbacks to `localhost`, `127.0.0.1`, and `[::1]`, and lets callbacks and metadata documents reach loopback addresses. Without it, every callback URL must be https and resolve to a public address. |
| none | `PUFFER_TRUST_PROXY=fly` | unset | Per-caller rate limits key on the `Fly-Client-IP` header that Fly's proxy sets. Unset, they key on the connection's address and ignore that header. Set it only behind Fly's proxy, because anyone else can forge the header. |
| `--notify-debounce-ms` | `PUFFER_NOTIFY_DEBOUNCE_MS` | `3000` | Head changes for one agent inside this window send one ping. |
| `--offline-after-ms` | none | `35000` | The phone counts as offline after this long without a sync. The e2e shortens it. |
| `--queued-ttl-ms` | `PUFFER_QUEUED_TTL_MS` | `604800000` (7 days) | How long a note write queued while the phone is offline waits for the phone. Past it the write expires unapplied. The e2e shortens it. See [Offline writes](#offline-writes). |
| `--queued-writes-max` | `PUFFER_QUEUED_WRITES_MAX` | `200` | Queued writes one device holds at once. Past it, a write answers `429 offline_queue_full`. |
| `--queued-bytes-max` | `PUFFER_QUEUED_BYTES_MAX` | `4194304` | Characters (UTF-16 units) of note text the queued writes of one device hold at once. Past it, a write answers `429 offline_queue_full`. |
| `--connect-ttl-ms` | none | `600000` | How long an OAuth connection waits for the user to approve it on the phone. The e2e shortens it. |
| `--max-devices` | `PUFFER_MAX_DEVICES` | `1000` | Devices the relay holds at most. Past it, `POST /v1/device/register` answers 503. |
| `--max-devices-per-user` | `PUFFER_MAX_DEVICES_PER_USER` | `5` | Devices one account may register. Past it, `POST /v1/device/register` answers `403 device_limit`. |
| none | `NODE_ENV=production` | unset | Production: `BETTER_AUTH_SECRET` is required, `--dev-open-register` is refused, and Better Auth's own rate limits (per caller address) turn on. The Docker image sets it. |
| none | `BETTER_AUTH_SECRET` | minted | Signs account sessions; 32 characters or more. Required in production. Outside production the relay mints one into `auth-secret` next to `registry.json` (0600) and reuses it. Changing it signs every user out. |
| none | `PUFFER_ADMIN_EMAILS` | unset | Comma-separated emails (any case) whose accounts get the `admin` role: at sign-up, and at startup for accounts that already exist. See [Accounts](#accounts) for the caveat. |
| none | `PUFFER_ADMIN_USER_IDS` | unset | Comma-separated Better Auth user ids that are admins whatever their role. |
| none | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_APP_BUNDLE_IDENTIFIER` | unset | Sign in with Apple. All four of the first must be set together (`APPLE_PRIVATE_KEY` is the `.p8` PEM; `\n` escapes are allowed). The bundle identifier (`dev.local.puffer` in `app.json`) lets the app sign in with a native Apple ID token. Unset, Apple is off. |
| `--dev-open-register` | `PUFFER_OPEN_REGISTER=1` | off | Development and `npm run e2e` only: `POST /v1/device/register` works without a session. Refused with `NODE_ENV=production`. |

## HTTP API

Agents that cannot speak MCP call the same operations as JSON over HTTP. They use the same `ak_` key, reach the same mailbox, and count against the same per-agent limits as MCP calls. A connected agent reads and writes the user's notes and documents: the user approved it once, when it connected, and the phone answers every call without asking.

| Endpoint | MCP tool | Input |
| --- | --- | --- |
| `POST /v1/ask` | `ask_puffer` | JSON body `{"question": "...", "filters": {"after": "2026-06-01", "before": "2026-07-01", "source": "..."}, "sort": "relevance", "limit": 10, "include_documents": "text", "wait": 25}`. Only `question` is required. `sort` is `relevance` (default) or `recent`. With `recent` the phone returns every confident match, newest modified first, at most `limit` (1 to 20, default 10). |
| `GET /v1/recent` | `list_puffer_recent` | Query parameters `source`, `limit` (1 to 20, default 10), `include_documents`, and `wait`. The newest documents, newest modified first, in the ask item shape. |
| `GET /v1/sources` | `list_puffer_sources` | Query parameter `wait`. The source names to pass as `source`, each with its item count, in `sources` as `[{"name", "count"}]`. No content. |
| `GET /v1/answers/<request_id>` | `get_puffer_answer` | Query parameters `wait` and `include_documents`. |
| `GET /v1/changes` | `get_puffer_changes` | Query parameters `since`, `limit` (1 to 200, default 50), and `wait`. |
| `GET /v1/notes/search` | `search_notes` | Query parameters `query` (required), `folder`, `sort` (`relevance` or `recent`), `limit` (1 to 50, default 10), and `wait`. Notes with a snippet, no body. |
| `GET /v1/notes` | `list_notes` | Query parameters `folder`, `limit` (1 to 100, default 20), and `wait`. Newest modified first. |
| `GET /v1/notes/folders` | `list_note_folders` | Query parameter `wait`. Folder names and note counts. |
| `GET /v1/notes/<note_id>` | `get_note` | Query parameter `wait`. The Markdown body and `version`. A body over 200,000 characters comes cut, with `truncated: true`. |
| `POST /v1/notes` | `create_note` | JSON body `{"title": "...", "body": "<Markdown>", "folder": "..."}`. Only `body` is required. |
| `POST /v1/notes/<note_id>/append` | `append_to_note` | JSON body `{"text": "<Markdown>"}`. |
| `PATCH /v1/notes/<note_id>` | `update_note` | JSON body `{"body": "<Markdown>", "base_version": 3}`. A stale `base_version` answers `conflict` with `current_version`, and nothing is written. |
| `DELETE /v1/notes/<note_id>` | `delete_note` | Query parameter `wait`. Moves the note to Recently Deleted. |
| `GET /openapi.json` | none | No key. OpenAPI 3.1 for every operation. The operation IDs are the MCP tool names, the descriptions are the tool descriptions, and the server is the public base plus `/v1`. |

`/v1/notes/search` and `/v1/notes/folders` are paths of their own. Another method there is 405, never a note with the ID `search` or `folders`.

Use `list_puffer_recent` for "latest" requests without a topic. Use `ask_puffer` with `"sort": "recent"` for "latest X about Y". The tool descriptions, the OpenAPI document, and `GET /start` tell agents the same.

The phone lists the request kinds it can read in each sync (`requestKinds`). The relay never hands a phone a request of a kind it did not list, because one unknown kind would fail its whole sync. Such a request settles as `failed` at the next sync, and its `reason` asks the user to update the app.

Send the key in the header `Authorization: Bearer ak_...`. The relay never reads a key from the query string, because URLs end up in logs and browser history. A client that cannot set a header needs a proxy that adds it.

A result is the `structuredContent` of the matching MCP tool plus `message`, the text that tool returns. With `include_documents` set to `file`, a document's original file is in its item's `document.file` as base64, at most 15 MB of files per answer; MCP sends the same file as an embedded resource. Every status is a 200, so read `status`:

| Status | Meaning |
| --- | --- |
| `answered` | Settled. Items, events, sources, notes, folders, or a note. |
| `nothing_found` | Settled. Nothing matched, or no note has that ID. |
| `conflict` | Settled. `update_note` only: the note changed since `base_version`. |
| `declined` | Settled. Puffer on the phone did not run the request. |
| `rate_limited` | Settled. Puffer on the phone limits how often an agent reads. Wait a minute. |
| `disconnected` | Settled. The user removed the agent while the request was open. Later calls get 401. |
| `expired` | Settled. The request ran out, or its ID is unknown or belongs to another agent, so the API does not reveal which IDs exist. |
| `failed` | Settled. The phone could not run it; `reason` says why. |
| `processing`, `phone_offline` | Not final. Collect it later with its `request_id`. `phone_offline` adds `open_url`, a page that opens Puffer. |
| `queued` | Not final. A note write (create, append, update, delete) queued while the phone is offline, applied when it comes back. Adds `queued_at`, `kept_until`, `open_url`, and for a create the `note_id` the note will have. See [Offline writes](#offline-writes). |

Every response carries `Cache-Control: no-store`.

`wait` is in seconds, from 0 to 50, and the relay caps it at `--wait-ms`. It defaults to 25, because many HTTP tool runners give up near 30 s. A status that is not final yet comes with a `request_id` to collect later.

Errors are `{"error": "<code>", "message": "<text>"}`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | The body is not JSON, a field or a query parameter is invalid, or a query parameter appears twice. |
| 401 | `invalid_token` | The key is missing, unknown, or revoked. `WWW-Authenticate` is the challenge `/mcp` sends. |
| 403 | `invalid_host`, `invalid_origin`, and similar | The `Host` header does not name the relay, or a browser sent an `Origin` from another site. |
| 404 | `not_found` | No such path. |
| 405 | `method_not_allowed` | The method does not match the path. `Allow` names the right one. |
| 413 | `body_too_large` | The body is over 8 KB, or 1 MB for a note write. The relay closes the connection after this answer. |
| 429 | `rate_limited` | The agent started more than 20 requests in the last minute. `Retry-After` is 60. |
| 429 | `offline_queue_full` | The phone is offline and its device already holds `--queued-writes-max` queued writes or `--queued-bytes-max` of queued note text. Nothing was written or queued. There is no `Retry-After`: the queue empties when the phone comes back. |
| 429 | `too_many_open_requests` | The agent has 10 open requests. Collect them with `GET /v1/answers/<request_id>`. There is no `Retry-After`, because a slot frees up only when a request settles or expires. |

The API sends no CORS headers, and like `/mcp` it refuses a request whose `Origin` names another host. Call it from a server.

With the key in `PUFFER_KEY`, ask a question:

```sh
curl -s http://localhost:8787/v1/ask \
  -H "Authorization: Bearer $PUFFER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"question": "vet appointment"}'
```

```json
{"status":"answered","request_id":"rq_f1x7sAKeR9GI62QA","items":[{"title":"mochi-vet.txt","text":"Mochi (corgi, 4 years) vet appointment on Thursday at 17:30, ...","folder":"On My iPhone"}],"message":"From the user's Puffer library:\n1. mochi-vet.txt (in On My iPhone)\n   \"Mochi (corgi, 4 years) vet appointment on Thursday at 17:30, ...\""}
```

A call the phone does not answer within `wait` returns `processing` or `phone_offline`. Collect the answer with its request ID:

```sh
curl -s "http://localhost:8787/v1/answers/rq_EGe4b4dTrWhaYWSl?wait=50" -H "Authorization: Bearer $PUFFER_KEY"
```

Search the notes, then replace a note's body with the version you read:

```sh
curl -s "http://localhost:8787/v1/notes/search?query=packing%20list" -H "Authorization: Bearer $PUFFER_KEY"
curl -s -X PATCH http://localhost:8787/v1/notes/<note_id> \
  -H "Authorization: Bearer $PUFFER_KEY" -H 'Content-Type: application/json' \
  -d '{"body": "# Packing list\n\n- tent\n- stove", "base_version": 3}'
```

### Offline writes

While the phone is offline (no sync for `--offline-after-ms`), `create_note`, `append_to_note`, `update_note`, and `delete_note` do not answer `phone_offline`. The relay queues the write and answers `queued` with its `request_id`. The phone applies queued writes on its next sync, in the order the agents wrote them, and its answers settle them as usual, so `get_puffer_answer` returns the note afterwards.

- A queued create answers with the `note_id` the note will have, a lowercase UUID the relay mints in the phone's format. The agent can append to, update, or delete that note right away, and those writes queue behind the create.
- Reads (`get_note`, `search_notes`, `list_notes`, `ask_puffer`) do not see queued writes until the phone has applied them. The `queued` message says so.
- A queued `update_note` whose note the user edited since `base_version` is merged line by line with the user's edits on the phone instead of answering `conflict`.
- The phone gets each write as an ordinary request with `queued: true`, `queuedAt`, and, for a create, `noteId`. It applies each one once, by request ID, and acks it in its outbox. The relay then drops the write's note text.
- Queued writes do not count against the 10 open requests per agent. They count against the device's caps, `--queued-writes-max` and `--queued-bytes-max`, and live `--queued-ttl-ms` (7 days by default), after which they expire unapplied. `GET /v1/device` reports `queuedWrites`.
- Deleting the device (`DELETE /v1/device`, the operator's `DELETE /v1/admin/devices/<id>`, or deleting the account) drops its queue.
- Queued writes live in the relay's memory, unencrypted, and a restart loses them (their agents then read `expired`). Encrypting them to a key only the phone holds and persisting the ciphertext is a TODO.

Read what changed since the `next_cursor` of the previous call, and fetch the OpenAPI document:

```sh
curl -s "http://localhost:8787/v1/changes?since=18" -H "Authorization: Bearer $PUFFER_KEY"
curl -s http://localhost:8787/openapi.json
```

## Accounts

Accounts are [Better Auth](https://www.better-auth.com) 1.7.6, mounted at `/api/auth` on a SQLite database `auth.db` next to `registry.json` (Node's built-in `node:sqlite`; the relay creates and migrates its tables at startup). A user signs up and in with email and password, or with Apple when the `APPLE_*` variables are set. Each sign-in answers a session token (in the body as `token`, and signed in the `set-auth-token` header). Send it as `Authorization: Bearer <token>` (Better Auth's bearer plugin). Sessions last 7 days and renew while used.

The app uses Better Auth's Expo client, which sends its scheme as the `expo-origin` header. The relay trusts the origin `puffer://` (the scheme in `app.json`), plus `exp://` outside production; a browser request from any other origin gets 403. Agents never use accounts: their `ak_` keys and OAuth (below) are unchanged.

| Endpoint | Effect |
| --- | --- |
| `POST /api/auth/sign-up/email` | `{"name", "email", "password"}` (password 8 to 128 characters). Creates the account and signs in. |
| `POST /api/auth/sign-in/email` | `{"email", "password"}`. A wrong password is 401. |
| `GET /api/auth/get-session` | The session and user, or `null`. |
| `POST /api/auth/sign-out` | Ends the session. The phone's device stays registered. |
| `POST /api/auth/delete-user` | `{"password"}`. Deletes the account and every device it registered, like `DELETE /v1/device` for each. |
| `/api/auth/admin/*` | Better Auth's admin plugin, for accounts with the `admin` role: `list-users`, `set-role`, `ban-user`, `unban-user`, `remove-user` (which deletes the user's devices too), `list-user-sessions`, `revoke-user-sessions`, and the rest of the plugin. |

`POST /v1/device/register` needs a session: without one it answers `401 sign_in_required`. The new device belongs to that account (its user id is stored in `registry.json`), and an account holds at most `--max-devices-per-user` devices. Sign-in gates only registration and account management. The phone then syncs, rotates and deletes with its `dk_` key as before, and signing out does not unregister it.

Admins are accounts with the `admin` role. `PUFFER_ADMIN_EMAILS` gives the role to those addresses when they sign up and, at each start, to existing accounts with them. Sign-up does not verify email addresses, so whoever signs up first with a listed address becomes admin: create your account before you list it (the next start promotes it), or use `PUFFER_ADMIN_USER_IDS` with your user id. An admin can give the role to others with `POST /api/auth/admin/set-role`.

## Devices and admin

A phone manages its own device with its `dk_` key. None of these answers carry content, keys, or digests.

| Endpoint | Effect |
| --- | --- |
| `GET /v1/device` | The device's account: `deviceId`, `registeredAt`, `lastSyncAt` (to the hour, `null` before the first sync), `lifecycle` (`pending`, `active`, or `idle`), `agentCount`, `online`, and `queuedWrites` (note writes waiting for the phone). `online` and `queuedWrites` read `false` and `0` while the relay is not serving the device in memory. |
| `POST /v1/device/rotate` | A new `dk_` key for the same device, as `{"v": 1, "deviceId", "deviceKey"}`. The old key gets `401 unknown_device` from that moment. The registry file holds only the new digest. Agents and their keys are unchanged. |
| `DELETE /v1/device` | Deletes the device and everything the relay holds for it: its agents' keys, their OAuth sessions, the connections it confirmed (a waiting one polls `access_denied`), open and queued requests (their agents get `disconnected`), change pages, webhooks, and event subscriptions. The registry file no longer names it. Afterwards its `dk_` key and its agents' `ak_` keys and access tokens get 401. Answers `{"v": 1, "deleted": true}`. |

An admin account (see [Accounts](#accounts)) can list and remove devices. Send its session token as `Authorization: Bearer <token>`. No valid session answers 401, an account without the admin role 403. After 10 such failures from one caller in 15 minutes, that caller gets 429 for the rest of the window, even with an admin session. `PUFFER_ADMIN_TOKEN` is no longer read.

| Endpoint | Effect |
| --- | --- |
| `GET /v1/admin/devices` | Every device, oldest first, in the `GET /v1/device` shape plus `agents` as `[{"id", "name"}]`, `userId` and the account's `email` (both `null` for a device registered before accounts or with `--dev-open-register`). |
| `DELETE /v1/admin/devices/<device id>` | Deletes that device like `DELETE /v1/device`. An unknown ID is 404. |
| `GET /v1/admin/stats` | Counts: `devices`, by lifecycle (`pending`, `active`, `idle`, `prune`), `countedAgainstMax`, `maxDevices`, `users`, `online`, `agents`, and `queuedWrites`. |

```sh
token=$(curl -s -X POST http://localhost:8787/api/auth/sign-in/email -H 'content-type: application/json' -H 'expo-origin: puffer://' \
  -d '{"email":"you@example.com","password":"..."}' | node -p 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:8787/v1/admin/devices -H "Authorization: Bearer $token"
curl -s -X DELETE http://localhost:8787/v1/admin/devices/tn_... -H "Authorization: Bearer $token"
curl -s http://localhost:8787/api/auth/admin/list-users -H "Authorization: Bearer $token"
curl -s -X POST http://localhost:8787/api/auth/admin/remove-user -H "Authorization: Bearer $token" -H 'content-type: application/json' -d '{"userId":"..."}'
```

`npm run e2e:auth` tests these routes.

## OAuth

Some MCP clients, such as ChatGPT and Claude Code's remote OAuth, cannot take an `ak_` key. The relay is also an OAuth 2.1 authorization server for them, following the MCP authorization spec of 2026-07-28. The user approves each connection on the iPhone in Puffer. Keys minted on the phone keep working unchanged.

### Connect a client by URL

1. Give the client the relay's MCP URL without a header, for example `claude mcp add --transport http puffer-oauth http://localhost:8787/mcp` (a name other than an existing `puffer` entry), then run `/mcp` in Claude Code or `claude mcp login puffer-oauth`. Claude Code finds the relay's metadata document support and identifies itself by its own https metadata document, which the relay then fetches.
2. The client calls `/mcp`, gets 401, and discovers the relay from the `WWW-Authenticate` header.
3. The client opens a browser page. The page shows the client's name, a QR code of the request's approve URL (`/c/<secret>`), an Open in Puffer link for a page open on the iPhone itself, and the host the browser returns to.
4. Scan the QR code with the iPhone's camera. Puffer opens the request, and you approve it there. Puffer presents the link's secret to the relay. The relay allows 3 wrong secrets, and the third declines the request.
5. The page returns the browser to the client, and the client fetches its token.

If the page is open on the iPhone itself, its "Open Puffer" link opens the request in the app.

### Connect an agent by message

An agent that cannot do OAuth reads `GET /start`, calls `POST /v1/connect` with `{"name": "..."}`, sends the user the `approve_url`, and polls `POST /v1/connect/<connect_id>/token` with its `poll_token` as Bearer until it gets the key. A poll that repeats within 60 s gets the same key again, in case the reply was lost.

An agent that can receive webhooks may add `"callback_url": "https://..."`. The URL follows the same rules as other callbacks (see [Hosting](#hosting)). When the connection is approved, declined, or expired, the relay POSTs `{"event": "connect.approved" | "connect.declined" | "connect.expired", "connect_id": "cn_...", "timestamp": "..."}` once, with up to 5 attempts on transient failures. The relay signs it in the Standard Webhooks format (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>`). The key is the UTF-8 bytes of the `poll_token`. The body never holds the agent key. On `connect.approved` the agent calls the token endpoint once. A failed callback does not change the outcome, and polling still works.

### Endpoints

The issuer is the relay's public base, which is `--public-url` or else `http://localhost:<port>`. OAuth needs that base to be https, or plain http on `localhost`, and the relay refuses to start otherwise. The endpoints check the Host header like `/mcp`.

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728). The 401 from `/mcp` names this URL. The same document is at `/.well-known/oauth-protected-resource`. |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414). There is no `/.well-known/openid-configuration`, because the relay is not an OpenID provider. |
| `POST /register` | Dynamic client registration (RFC 7591). |
| `GET /authorize` | Checks the request and shows the page that waits for the phone. |
| `GET /authorize/poll/<token>` | The page polls this every 1.5 s. Only that page knows the token in the path. |
| `POST /token` | Exchanges the authorization code (`grant_type=authorization_code`) or a refresh token (`grant_type=refresh_token`, with `client_id`) for an access token and a new refresh token. |
| `GET /v1/device/connects/by-link/<secret>` | The phone fetches the connection its approve link names, with the device key. The relay lists connections to no phone, so this is how a phone learns of one. 404 once it ended or another phone confirmed it. |
| `POST /v1/device/connects/<id>/confirm` | The phone sends the secret of the approve link it was opened with, `{"v":1,"link":"<secret>"}`, with the device key. A match claims the connection for that phone's tenant: only its registry approves the key. The answer is `confirmed`, `wrongCode` with the tries left, `declined` after the third wrong secret, or `gone` (also for a connection another phone confirmed). |

### Registration

The relay accepts public clients only. PKCE with `S256` is required, and the token endpoint takes no client secret.

- **Client ID metadata documents.** When a `client_id` is an https URL with a path, the relay fetches that document at `/authorize`, with no redirects, a 5 s timeout, and a 5 KB limit. It fetches only from public addresses, like callbacks (see [Hosting](#hosting)), and the error page says only that the document could not be fetched. The document must name the same `client_id` and list `client_name` and `redirect_uris`. The relay fetches it on every authorization and does not cache it. Puffer shows the document's host as verified only when the connection's redirect URI is not on `localhost`, `127.0.0.1`, or `[::1]`, because anyone can present a client ID whose redirect lands on their own machine.
- **Dynamic registration.** `POST /register` takes 1 to 10 redirect URIs. Each must be https, or http on `localhost`, `127.0.0.1`, or `[::1]`, without a fragment or userinfo. Whatever authentication method the client asks for, the relay registers it with `none`. The relay keeps at most 200 such clients in `oauth-clients.json` (owner-only) and drops the one used longest ago first. The file holds each client's id, name, redirect URIs, registration time, and last use, and no secrets.

The relay removes control characters, bidi overrides, and line and paragraph separators from client names, collapses runs of whitespace, and keeps at most 2 combining marks in a row.

A redirect URI must match a registered one exactly. An http loopback redirect URI may use any port, because native apps choose a port at run time (RFC 8252). Every `/authorize` refusal is an error page, never a redirect. Anyone can register a client with any https redirect URI, so a redirect from the relay's domain would be an open redirect. Once a connection exists, the page sends declines and expiries back to the client.

### Tokens

When a connection starts, the relay mints an agent key, `ak_` plus 32 random bytes. Puffer approves by adding an agent with that key's digest to its registry. The relay hands out the authorization code only after the registry holds that digest. The key itself never leaves the relay. Redeeming the code starts a session for that agent, bound to the client ID and the phone's tenant, and the token response carries two tokens:

- **Access token.** `at_` plus a claim of tenant, agent digest, and expiry, signed with HMAC-SHA256. It lives 1 hour (`expires_in: 3600`). The relay keeps no record of it, so a restart or a deploy does not invalidate it. Every request still checks that the agent is in the tenant's registry, so removing the agent in Puffer ends access at once.
- **Refresh token.** `rt_` plus 384 bits, opaque to the client: 128 random bits that name the session, and 256 bits derived with HMAC-SHA256 from the signing key, the session, and its rotation count, so the relay can rebuild a token without storing it. It stays valid 90 days from its last use, and every use replaces it with a new one. The client repeats `client_id` with it and gets no client secret. Presenting a refresh token that was already replaced revokes the session (refresh token reuse detection). One exception covers a lost response: the token replaced last may be repeated within 60 s, also across a restart, and the relay answers with the same new refresh token.

When a session is revoked, or 90 days pass without a refresh, the client gets `invalid_grant` and starts a new authorization, and Puffer removes the agent (see `revokedKeys` below). `ak_` keys that OAuth clients received before sessions existed, and keys from connect by message, do not expire.

`oauth-session-key.json` holds the signing key. The relay generates it at the first start. `oauth-sessions.json` holds, per session, its client ID, tenant, agent digest, rotation count, the SHA-256 digests of the current refresh token and of the one it replaced (with the end of its 60 s retry window), and its expiry, and no token. At startup the relay drops a session entry it cannot read, with a warning, and keeps the others. The relay removes a session when its agent leaves the registry, and a revoked one after 24 hours. If the key file is lost, every access token fails, and clients get new ones with their refresh tokens.

The relay never writes the agent key, a token, an authorization code, a link secret, or a poll token to disk or to its logs. A pending connection lives in memory for `--connect-ttl-ms`, and an authorization code lives for 60 s from the moment the page receives it.

The relay tells the phone to remove an agent in `revokedKeys` on every sync response, and refuses that agent's key at `/mcp` at once. This happens in four cases. The phone approved a connection, but nobody redeemed its code before it expired. A client presented an authorization code a second time, which revokes the session that code bought (OAuth 2.1). A client presented a refresh token that was already replaced. Or a session went 90 days without a refresh. The relay lists a digest while the phone's registry holds it, and keeps the record for 24 hours.

### Rate limits

The limits count per caller. A caller is an IPv4 address or an IPv6 /64, taken from the connection or, with `PUFFER_TRUST_PROXY=fly`, from `Fly-Client-IP`. The relay never reads `X-Forwarded-For`.

| Limit | Value |
| --- | --- |
| `/register` | 10 per hour |
| `/authorize` with a known client and redirect URI | 10 per minute |
| Metadata document fetches | 20 per minute |
| Connections waiting for the phone | 3 per caller, 100 in total |

Beyond a limit `/register` answers 429 and `/authorize` shows an error page.

Each agent may start 20 new requests per minute and park 4 tool calls at once, counting MCP and HTTP API calls together. A fifth call answers at once with its status and `request_id`. An agent may hold 5 event subscriptions.

### Known gaps

- Anyone who can reach the relay can start a connection. Puffer shows it only once its approve link opens Puffer, which proves the user scanned or tapped that link, not that they started the connection themselves. A link from someone else still leads to a real request.
- The relay does not cache metadata documents.
- A redirect URI on `localhost` gets an extra warning in Puffer's approval screen, not on the browser page.
- Like `/mcp`, the OAuth endpoints refuse a request whose `Origin` header names another host. A client that runs in a browser on another site cannot use them.
- `redirect_uri` is required at `/authorize`, even when a client registered only one.

## Hosting

Run exactly one instance. The mailbox, the change pages, and the event subscriptions live in process memory, and tool calls and phone syncs hold HTTP requests open for up to 50 seconds. Serverless platforms and autoscaling split that state across instances and cut long requests short.

Put `registry.json` on a volume. The Docker image reads `PUFFER_STATE=/data/registry.json`, so mount the volume at `/data`.

Set `PUFFER_PUBLIC_URL` to the relay's public https origin. The app accepts https relays. With an https public URL every response carries `Strict-Transport-Security`.

The phone's sync body is the large one: an answer may carry a document's text and its original file. The relay refuses a sync body over 24 MB with 413, from its `Content-Length` before reading it. It reads and parses sync bodies over 4 MB one at a time, and the others wait their turn unread. A tenant keeps at most 32 MiB of settled answer text and files for collection, and drops the answers that settled first beyond that, so their IDs read `expired`. `fly.toml` gives the machine 512 MB.

Callback URLs for webhooks and event subscriptions must be public https in production. The relay resolves each callback host, refuses loopback, private, link-local, CGNAT, unique local (Fly's private network is `fdaa::/16`), multicast, and unspecified addresses and their IPv4-mapped forms, and connects to the address it checked. It reads at most 4 KB of a response and never decodes gzip. An agent sees the same failure reason whatever went wrong, and the relay logs the specific one. Leave `PUFFER_DEV_CALLBACKS` unset there. It also lets a client ID metadata document be served over http from the relay's own machine, which only the e2e needs.

Request headers must arrive within 10 s. A request body must arrive within 30 s, a sync body within 2 minutes (its wait for a turn included), and a body from an unauthenticated caller within 10 s. These limits end when the request has arrived, so the 25 s device long-poll and the 50 s tool-call wait are not affected. `/healthz` answers `{"ok":true}` and nothing else.

Put `oauth-clients.json`, `oauth-sessions.json`, `oauth-session-key.json`, and `auth.db` on the same volume. The relay writes them next to `registry.json`. The image sets `NODE_ENV=production`, so set `BETTER_AUTH_SECRET` (a secret, not in `fly.toml`): losing it signs every user out, losing `auth.db` loses every account.

To run the image locally:

```sh
docker build -t puffer-relay .
docker run --rm -p 127.0.0.1:8787:8080 -v puffer-state:/data -e PUFFER_PUBLIC_URL=http://localhost:8787 -e BETTER_AUTH_SECRET=$(openssl rand -base64 32) puffer-relay
```

To deploy on Fly.io with `fly.toml`:

1. Set `app` and `PUFFER_PUBLIC_URL` in `fly.toml` to your app name and its `https://<app>.fly.dev` origin. `fly.toml` also sets `PUFFER_TRUST_PROXY=fly`.
2. Create the volume with `fly volumes create puffer_state --size 1`.
3. Set the account secrets: `fly secrets set BETTER_AUTH_SECRET=$(openssl rand -base64 32)`, and `PUFFER_ADMIN_EMAILS` (or `PUFFER_ADMIN_USER_IDS`) for yourself. For Sign in with Apple also set the `APPLE_*` variables, and add `https://<app>.fly.dev/api/auth/callback/apple` as a return URL of the Services ID.
4. Deploy one machine with `fly deploy --ha=false`.
5. Open Puffer on the phone and sign in (Agents). It registers itself with the relay.

The image starts as root only to give the volume to the unprivileged `node` user, then runs the relay as `node` through `setpriv`. The base image is pinned to `node:24.15.0-bookworm-slim`. An earlier version of the image was checked with `docker build` and a local `docker run`. The pinned, non-root version has not been built, and the Fly configuration has not been deployed.
