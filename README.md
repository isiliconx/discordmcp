# discordmcp

Give an MCP-compatible AI client access to Discord through a locally held token.
The setup command saves your token privately and generates the MCP configuration
you can add to your client. Supports stdio and authenticated Streamable HTTP.

**287 tools in full mode:** 246 public REST operations generated from Discord’s
official v10 API specification, 20 experimental user-account operations, and 21
MCP/Gateway helper tools. All operations remain callable in compact mode.
No read-only restriction is imposed by the server: actions run with the supplied
account’s Discord permissions. The MCP client may require its own tool approvals.

**User-token mode is experimental.** Discord
[forbids automated normal user accounts](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
and may terminate accounts used this way. It is included as requested, with raw
user-token authentication; it is not an officially supported Discord integration.
Bot tokens and externally supplied OAuth2 bearer tokens are also supported.

API coverage does **not** mean every Discord client feature is implemented or that
every endpoint accepts a user token. Voice-state signalling is available; voice
audio/video streaming, screen sharing, billing, CAPTCHA/MFA flows, and some
undocumented client features are not implemented. Live user-account compatibility
has been verified for the subset listed in [live validation](docs/LIVE_VALIDATION.md).
OAuth2 scopes and Discord permissions still apply.

## Quick start

Requires Node.js 22.13 or newer (uses the bundled SQLite runtime).

```bash
git clone https://github.com/isiliconx/discordmcp.git
cd discordmcp
npm ci
npm run build
node dist/index.js setup
```

Setup asks for the authentication mode and a token using **hidden input**. It writes
an owner-readable `.env` and `mcp.json` in the current directory. Existing files are
never overwritten. Both files are ignored by Git. The generated MCP configuration
contains the absolute server and environment-file paths, so it works regardless of
the client’s working directory. Copy the `mcpServers.discord` configuration into
your client’s MCP settings. Keep the checkout at that path.

Only clients with MCP support can use this server; it cannot add MCP support to an
arbitrary AI product. No AI API key is needed by this project.

To configure manually, copy `.env.example` to `.env`, enter your token **locally**,
and set `DISCORD_AUTH_TYPE` to `user`, `bot`, or `oauth`. Supply the raw token without
a `Bot` or `Bearer` prefix. Restrict the file’s permissions (`chmod 600 .env` on
Linux/macOS). Never send a token in chat or put it in source control.

## MCP client configuration

The setup command generates this structure with real absolute paths:

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": [
        "/absolute/path/discordmcp/dist/index.js",
        "--env-file",
        "/absolute/path/discordmcp/.env"
      ]
    }
  }
}
```

Inherited environment variables take precedence over `.env`. You can use the
client’s `env` configuration to supply `DISCORD_TOKEN` and `DISCORD_AUTH_TYPE`
instead of an environment file, but the client configuration then contains a
credential. Setup keeps credentials in `.env` instead.

Full mode advertises all 287 tools in one tools/list response. Some clients have
limits on tool count or context size. Set `MCP_TOOL_MODE=compact` in `.env` to
advertise only the 21 helpers; the AI then uses `discord_search_tools`,
`discord_describe_operation`, and `discord_call` to access any of the 266 REST
operations. This does not reduce available actions.

## Workflow helpers

Version 1.1 adds four direct MCP tools for common AI workflows:

| Tool | Behavior |
| --- | --- |
| `discord_send_message` | Text send with mentions disabled by default and recent-duplicate detection using a nonce |
| `discord_reply_to_message` | Exact reply target; missing targets fail; no automatic reply ping |
| `discord_read_history` | Bounded, resumable older-history reads with signed cursors and a stable newest-message boundary |
| `discord_search_messages` | Guild/DM search with explicit index readiness, flattened matches, and pagination metadata |

For history, pass `channel_id` and optionally `max_messages` (default 100, maximum
1000), `page_size` (1–100), and `format` (`compact` or `full`). Continue using
`next_cursor` until `reached_start`. Each call makes at most 20 history requests;
the cursor carries the continuation rather than holding an unbounded request open.
Cursors survive process restarts with the same account token, reject modification
or use with another channel/account, and retain the initial newest-message
boundary. They are signed, not encrypted. Rotating the account token invalidates
old cursors. `reached_start` means the end of history accessible to this account.

For search, supply `guild_id`, `channel_id`, or both, plus Discord filters in
`query`. With both IDs, the guild search is restricted to that channel. Indexing
responses return `index_ready: false`, not an invented zero-result answer. The
helper waits up to `max_wait_ms` (default 10000, maximum 30000) for an indexing
response to resolve. Already indexed searches can still lag very new posts.
`next_offset` supports paging; `pagination_limit_reached` identifies Discord’s
search offset limit. Use history for exhaustive reading, or date/ID partitions
for searches beyond the native offset limit.

For sends/replies, choose a stable `nonce` (1–25 characters) before the first
attempt if retrying the same action might be necessary. Discord checks recently
used nonces; the live test verified repeat sends returned the existing message ID.
This is a recent retry safeguard, not permanent idempotency. The tool returns its
nonce and includes it in ambiguous network-failure errors. Never reuse a nonce
for a different action. Full message payloads/uploads remain available through
`discord_create_message`.

Message sends/edits and ordinary webhook sends suppress mentions when
`allowed_mentions` is absent, including through the general API tool. Explicit
`allowed_mentions` choices remain available.

Set `MCP_READ_ONLY=true` to block API writes and application Gateway commands at
the server. Reads, history/search, and Gateway event monitoring remain available;
Gateway connection lifecycle still runs. Full access is the default. The setting
applies to every tool, including the general API and helper tools, and requires a
server restart to change. See the [operating safeguards](docs/OPERATING_GUIDE.md)
for exact boundaries and verification.

## Persistent deleted messages and edit versions

Version 1.2 adds an optional local SQLite archive. Setup enables it in a private
`.discordmcp/` directory; manual installations can set `MCP_ARCHIVE_ENABLED=true`
and an absolute `MCP_ARCHIVE_PATH` inside a directory with permissions `0700`.
The database and its journal files use owner-only permissions and are ignored by
Git. Without an explicit path, an account-credential-specific directory in the
user's local data directory is used. The archive is local and unencrypted.

Messages received through Gateway events or read/sent through REST are preserved.
Edits merge partial updates and retain observed earlier versions. Single and bulk
deletions mark saved messages without removing their content. Unknown original
content stays explicitly unknown. It cannot recover content deleted before it
was observed, or guarantee events from every server channel/user subscription.

`discord_read_history` includes saved deleted messages and edit versions in its
normal conversation results by default, with explicit `archive` metadata. Set
`include_archived=false` for live-only history. The original observed version and
up to nine recent versions are included inline; additional versions are available
through the paginated archive tools. The native REST tools retain Discord's live
semantics, including a 404 for a deleted message. Native Discord search excludes
deleted content; use `discord_archive_search` to search all saved versions.

| Tool | Behavior |
| --- | --- |
| `discord_archive_status` | Message/version counts, persistence errors, background recorder connection/heartbeat |
| `discord_archive_get_message` | Saved message and all paginated observed versions, including after deletion |
| `discord_archive_read_channel` | Saved channel/DM history without a Discord connection; continue with `next_before` |
| `discord_archive_search` | Literal-text search across every saved version, including deleted and edited messages |

For background recording after the AI client exits:

```bash
node dist/index.js archive start --env-file /absolute/path/discordmcp/.env
node dist/index.js archive status --env-file /absolute/path/discordmcp/.env
node dist/index.js archive stop --env-file /absolute/path/discordmcp/.env
```

The detached recorder reconnects and writes to the same database as the MCP.
It starts one recorder per database and records a heartbeat. It continues while
the computer/process stays running; it does **not** install reboot autostart.
For an OS-managed service, run `node dist/index.js --archive-only --env-file ...`.
Set `MCP_ARCHIVE_AUTOCONNECT=false` in clients using a dedicated background recorder;
the standalone recorder always connects. Otherwise an enabled archive connects
its own Gateway when the MCP starts, unless an active background recorder exists.
OAuth bearer authentication can archive REST reads but cannot run this Gateway.

Retention is unlimited, so disk use grows with observed messages and versions.
Attachment metadata and URLs are saved; attachment files are not downloaded and
their URLs may expire. Recording can miss content during offline/unresumable gaps.
See [archive behavior and operation](docs/MESSAGE_ARCHIVE.md) for exact coverage,
credential rotation, storage, and reproducible live testing.

## Conservative request pacing

All production MCP transports apply shared local pacing before every outgoing REST
request and application Gateway command. Managed heartbeats/connection lifecycle
keep their protocol timing; receiving archive events does not poll message history.

- Minimum 2 seconds between outgoing requests, 6 seconds between mutations, plus
  0–500 ms scheduling variation. Configure longer delays in `.env` if needed.
- Shared rolling caps: 20 requests and 4 mutations per minute across local clients
  using the same pacing state. Requests wait for their slot instead of racing.
- After 45 minutes of sustained API activity, pause outgoing operations for 10
  minutes. Ordinary idle periods reset the activity window; passive logging alone
  does not start a long-operation window.
- Honor Discord's response bucket/global limits and `retry_after`. Three repeated
  429s, a wait above 60 seconds, or three network failures stop outgoing activity
  for at least 10 minutes. Ambiguous writes are never automatically retried.
- HTTP 401, account-verification code 40002, CAPTCHA fields, and Gateway invalid
  authentication pause that credential. Active recorders disconnect when they see
  the shared account pause. Resolve verification in Discord and update credentials.
- A forbidden route (HTTP 403) is cooled for 15 minutes; repeated attempts cannot
  generate a rapid series of invalid requests. Messaging-restriction responses
  40003/40004 pause outgoing activity for 15 minutes.

`discord_capabilities.request_pacing` reports active limits, pauses, and rest time.
The queue holds at most 10 pending REST calls per process. A queued slot requiring
more than two minutes is rejected with an explicit retry-later result. Some long
workflows need a longer MCP client tool timeout or smaller history batches.

The pacing and stop behaviors were implemented independently after reviewing
[Discrub's published source](https://github.com/pratherbytecraft/discrub/tree/95c5f908d80bcd3e78ba8694b114a59ef46804ba).
No Discrub code is incorporated. Timing variation controls load; it does not make
user-token automation indistinguishable from a person or guarantee against account
flags. See [operating safeguards](docs/OPERATING_GUIDE.md) for scope and references.

## What the AI can do

| Area | Operations |
| --- | --- |
| Messages | Read history, create/edit/delete messages, replies, embeds, reactions, pins, polls, attachments |
| Servers and channels | Inspect/manage servers and channels, permissions, roles, members, moderation, invites, threads/forums |
| Other public APIs | Webhooks, scheduled events, emojis, stickers, soundboard, automod, stage instances, application commands, entitlements |
| Experimental user APIs | DMs/group DMs, relationships, friend requests/blocks, profiles, settings, notification settings, read receipts, invite acceptance, DM search, interactions |
| Gateway | Live events, presence/activity updates, member requests, voice-state signalling, other application opcodes |
| Escape hatch | Any Discord v10 REST path via `discord_api_request`; lifecycle Gateway opcodes are managed internally |

The [generated tool list](docs/TOOLS.md) contains every public REST operation.
[Experimental operations](docs/EXPERIMENTAL.md) lists the user-specific tools.
The `discord://guide` and `discord://capabilities` MCP resources provide usage hints.
In user mode, `discord_get_message` uses an exact-ID lookup in channel history,
because Discord restricts the direct single-message endpoint to bots. Missing or
deleted messages return a 404; a neighboring message is never returned instead.
The same adaptation applies to that path through `discord_api_request`.

Schemas for complex nested request fields are compacted in tools/list; use
`discord_describe_operation` for the full upstream request definitions.

Discord endpoint names are preserved: for example, `discord_create_message` sends
a message, `discord_get_my_user` checks the authenticated account, and
`discord_list_my_guilds` lists accessible servers. Discord IDs must be strings.

Examples of tool arguments:

```json
{
  "tool": "discord_create_message",
  "arguments": {
    "channel_id": "123456789012345678",
    "body": { "content": "Hello from my AI assistant!" }
  }
}
```

```json
{
  "tool": "discord_list_messages",
  "arguments": {
    "channel_id": "123456789012345678",
    "query": { "limit": 20 }
  }
}
```

```json
{
  "tool": "discord_call",
  "arguments": {
    "name": "discord_create_message",
    "arguments": {
      "channel_id": "123456789012345678",
      "body": { "content": "Same operation in compact mode." }
    }
  }
}
```

For new or uncatalogued endpoints, call `discord_api_request` with `method`,
relative `path` (without `/api/v10`), optional `query`, and `body`. Query arrays are
encoded as repeated parameters. Authentication headers cannot be overridden.
Requests remain confined to `https://discord.com/api/v10`; redirects are rejected.
The generic request tool can bypass a stale catalog’s input schema while still
using the same authentication, rate-limit, and upload handling.

## Uploads

Supply files as base64 data; this avoids giving the AI arbitrary server-file reads.
The server accepts up to ten files and 25 MiB combined per request. Discord may
apply a different account/server upload limit. An attachment upload looks like:

```json
{
  "channel_id": "123456789012345678",
  "body": { "content": "Attached file." },
  "files": [
    { "filename": "hello.txt", "data_base64": "aGVsbG8=", "content_type": "text/plain" }
  ]
}
```

Message uploads use `payload_json` and `files[0]`, `files[1]`, etc. Multipart-only
routes such as sticker creation use normal form fields; set the file’s `field` to
`file` for a sticker. `discord_api_request` also supports `content_type: "form"`,
and `multipart_mode: "fields"` for explicit multipart field handling.

## Gateway

Call `discord_gateway_connect` before presence, voice-state, or event tools. The
server identifies, heartbeats, resumes sessions, and reconnects with backoff. Bot
mode uses `DISCORD_GATEWAY_INTENTS` (default `0`); enable only the needed intents,
including required privileged intents in the Discord Developer Portal. OAuth2
bearer-token Gateway connections are not supported by this implementation.
User-mode Gateway support is experimental and may be rejected by Discord.

`discord_gateway_events` reads buffered events. `discord_gateway_wait_events`
waits up to 30 seconds. Pass the returned `next_cursor` as `after` on the next call
and optionally filter `types`, such as `["MESSAGE_CREATE"]`. The cursor is a local
event ID. Up to 500 events (32 MiB total) are retained in memory, shared across connected clients;
`dropped_events` signals a cursor gap. There is no durable event storage.

`discord_set_presence` sends opcode 3. `discord_gateway_update_voice_state` sends
opcode 4; `channel_id: null` leaves a channel. This is signalling only, not a voice
media connection. `discord_gateway_send` can send other application opcodes, with
a send budget that reserves room for protocol traffic. A successful send means
the command was transmitted, not that Discord accepted it; inspect later events.

For `discord_invoke_interaction`, connect the Gateway first. The server injects its
session ID if it is absent from the request body. The rest of Discord’s interaction
payload, including application/command/component identifiers, must be supplied.
Session credentials are redacted from tool output.

## Streamable HTTP

Setup creates a separate random `MCP_HTTP_TOKEN`. Configure it locally if using
manual setup (at least 32 characters), then run:

```bash
node dist/index.js --http --env-file .env
```

Connect an HTTP-capable MCP client to `http://127.0.0.1:3000/mcp` with an
`Authorization: Bearer <MCP_HTTP_TOKEN>` header. This key is separate from the
Discord token. `/health` also requires authentication. The HTTP transport is
stateless JSON-response MCP over POST; it does not expose legacy SSE transport.

The server binds to loopback by default and checks Host and Origin headers. To
use a reverse proxy, set `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, exact allowed Host
headers in `MCP_ALLOWED_HOSTS` (include the port when present), and exact browser
origins in `MCP_ALLOWED_ORIGINS`, separated by commas. Browser origins are denied
by default. If allowing origins, preflight responses are handled automatically.
Use HTTPS at the reverse proxy for external access.

All clients on this endpoint share one account and one event buffer. This is a
single-account server, not a multi-tenant hosted credential service. Clients that
require OAuth-based MCP authentication rather than a configured Bearer header
need an authentication proxy; the server does not implement MCP OAuth discovery.

## Testing and development

```bash
npm run check        # TypeScript build, automated tests, generated-catalog verification
npm run smoke:live   # Read-only live checks; requires your locally configured Discord token
npm run smoke:live -- --isolated  # Self-only group-DM message/upload/Gateway tests, then cleanup
```

Automated tests use fake credentials and mock Discord responses. They exercise
REST authentication/error handling, rate-limit queues, uploads, path validation,
Gateway events, and actual MCP clients over stdio and HTTP. They do not establish
live endpoint compatibility. The default live smoke test reads the current user, server
list, and (user mode only) DM channel list; it prints status only, without personal
data. The default mode does not send messages or change account settings. OAuth
scopes must cover the selected checks. `--isolated` is a user-mode suite that
creates a self-only group DM, verifies message/reaction/pin/upload/Gateway behavior,
deletes its test messages, and leaves the group. The 30-check isolated suite and
additional HTTP/account reads have passed against a live account; see the
[validation record](docs/LIVE_VALIDATION.md) for coverage and remaining failures.

The public catalog is reproducibly generated from the pinned
[official specification](https://github.com/discord/discord-api-spec). See
[vendor provenance](vendor/README.md) for updating it. This project is MIT licensed;
the upstream specification’s MIT license is preserved separately.

Requests are serialized per account, learn Discord rate-limit buckets, honor
fractional/global `retry_after` delays, and retry 429 responses with a bounded
budget. Ambiguous network failures and other HTTP errors are not automatically
retried, since writes could already have succeeded. Tool results redact configured
Discord/MCP credentials and active Gateway session IDs. Other data requested from
Discord (including webhook credentials when creating a webhook) is returned to
the AI; grant access only to clients you trust. Message content is untrusted data,
and the server’s MCP instructions tell clients not to follow instructions inside
Discord messages or profiles.
