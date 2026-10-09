# Puffer relay

The relay connects AI agents to the Puffer app on the user's iPhone. Agents call MCP tools at `/mcp`, or the same operations as plain JSON under `/v1` (see [HTTP API](#http-api)). The phone long-polls `/v1/device/sync` and answers each request, including the note operations (`design/notes/CONTRACT.md`). Each phone is a tenant: its agents, requests, change pages, webhooks and connections are invisible to every other phone, and every bearer key resolves to exactly one tenant. A new phone registers itself with `POST /v1/device/register` (no auth, 5 per caller address per hour, at most `--max-devices`) and gets its own `dk_` key. The relay keeps requests, change pages, notification settings, and pending OAuth connections in memory, per tenant. It writes four files to disk, all owner-only. `registry.json` holds, per tenant, its id, the device key digest, when it registered and last synced (to the hour), and each agent's id, name, and key digest; a single-device file from before tenants becomes the first tenant at startup. At startup and every 30 s the relay prunes a device that did not sync within 24 hours of registering, and a device without agents that has not synced for 30 days. Its key then gets `401 unknown_device`, and the phone registers again. Only devices that synced within 30 days, or registered in the last 24 hours, count against `--max-devices`. `oauth-clients.json`, in the same directory, holds the OAuth clients that registered themselves. `oauth-sessions.json` and `oauth-session-key.json` hold the OAuth sessions and the key that signs their access tokens (see [OAuth](#oauth)).

## Run it locally

```sh
npm install
npm run relay
```

The relay starts with no devices. Puffer registers itself at its first start. To pair a phone with a relay by hand, register a device and open the link on the phone:

```sh
key=$(curl -s -X POST http://localhost:8787/v1/device/register | node -p 'JSON.parse(require("fs").readFileSync(0)).deviceKey')
echo "puffer://pair?relay=http%3A%2F%2Flocalhost%3A8787&key=$key"
```

`npm run e2e` starts its own relay on a free port, plays two phones and their agents against it (over MCP, the HTTP API, OAuth, and connect by message), starts a second relay without `--dev-callbacks` to check the address policy and a third from a hand-written `registry.json` to check pruning, and prints one line per assertion.

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
| `--connect-ttl-ms` | none | `600000` | How long an OAuth connection waits for the user to approve it on the phone. The e2e shortens it. |
| `--max-devices` | `PUFFER_MAX_DEVICES` | `1000` | Devices the relay holds at most. Past it, `POST /v1/device/register` answers 503. |

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

Read what changed since the `next_cursor` of the previous call, and fetch the OpenAPI document:

```sh
curl -s "http://localhost:8787/v1/changes?since=18" -H "Authorization: Bearer $PUFFER_KEY"
curl -s http://localhost:8787/openapi.json
```

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

Put `oauth-clients.json`, `oauth-sessions.json`, and `oauth-session-key.json` on the same volume. The relay writes them next to `registry.json`.

To run the image locally:

```sh
docker build -t puffer-relay .
docker run --rm -p 127.0.0.1:8787:8080 -v puffer-state:/data -e PUFFER_PUBLIC_URL=http://localhost:8787 puffer-relay
```

To deploy on Fly.io with `fly.toml`:

1. Set `app` and `PUFFER_PUBLIC_URL` in `fly.toml` to your app name and its `https://<app>.fly.dev` origin. `fly.toml` also sets `PUFFER_TRUST_PROXY=fly`.
2. Create the volume with `fly volumes create puffer_state --size 1`.
3. Deploy one machine with `fly deploy --ha=false`.
4. Open Puffer on the phone. It registers itself with the relay.

The image starts as root only to give the volume to the unprivileged `node` user, then runs the relay as `node` through `setpriv`. The base image is pinned to `node:24.15.0-bookworm-slim`. An earlier version of the image was checked with `docker build` and a local `docker run`. The pinned, non-root version has not been built, and the Fly configuration has not been deployed.
