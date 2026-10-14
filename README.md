# discordmcp

Give an MCP-compatible AI client access to Discord through a locally held token.
The setup command saves your token privately and generates the MCP configuration
you can add to your client. Supports stdio and authenticated Streamable HTTP.

**279 tools in full mode:** 246 public REST operations generated from Discord’s
official v10 API specification, 20 experimental user-account operations, and 13
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

Requires Node.js 22 or newer.

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

Full mode advertises all 279 tools in one tools/list response. Some clients have
limits on tool count or context size. Set `MCP_TOOL_MODE=compact` in `.env` to
advertise only the 13 helpers; the AI then uses `discord_search_tools`,
`discord_describe_operation`, and `discord_call` to access any of the 266 REST
operations. This does not reduce available actions.

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
event ID. Up to 500 events are retained in memory, shared across connected clients;
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
deletes its test messages, and leaves the group. The 22-check isolated suite and
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
