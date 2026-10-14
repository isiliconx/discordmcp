# Operating safeguards and limits

The tested messaging, reply, reaction, history, and search workflow is ready for
use with an MCP client. The controls below reduce concrete failure modes. They
do not certify every endpoint or guarantee an AI client always chooses the right
action.

| Control | Enforcement and verification |
| --- | --- |
| Private credential setup | Hidden token input; owner-only `.env` and client configuration; token omitted from generated MCP configuration |
| Credential redaction | Configured Discord/HTTP credentials and active Gateway session IDs removed from returned data/errors |
| Fixed API destination | HTTPS requests confined to Discord v10; arbitrary URLs, traversal, auth-header overrides, and redirects rejected |
| Quiet message defaults | Missing `allowed_mentions` becomes empty parsing and `replied_user: false`; explicit choices remain available |
| Recent duplicate detection | Send/reply helpers use `nonce` and `enforce_nonce`; live repeat returned the same message ID |
| Exact reply targets | Missing referenced messages fail rather than becoming unthreaded sends; confirmed live |
| Optional read-only mode | `MCP_READ_ONLY=true` blocks POST/PUT/PATCH/DELETE and application Gateway commands, including generic/helper routes; confirmed with live attempted writes and regression tests |
| Resumable history | Account-bound signed cursors, channel matching, stable newest-message boundary, deduplication, bounded work, and nonadvancing-page detection |
| Honest search readiness | Indexing responses reported separately; bounded retry delay; fresh-message lag and search offset limit exposed |
| Rate limits | Serialized account requests, learned route/major-resource buckets, fractional/global waits, bounded 429 retries |
| Shared outgoing pacing | Private SQLite queue across local clients, 2-second request / 6-second mutation spacing, small additional delay, 20 requests / 4 mutations per minute |
| Sustained-operation breaks | 45-minute activity window followed by 10 minutes without outgoing API/application commands; passive Gateway event recording continues |
| Repeated failures | Three 429s, prolonged rate limiting, or three network failures pause outgoing work for 10 minutes; 401/verification challenges pause the credential and disconnect active Gateway recorders |
| Ambiguous writes | Network errors are not automatically retried; send helper retains the retry nonce in an ambiguous-failure error |
| HTTP entry point | Loopback default; separate strong Bearer key; Host/Origin checks; body, connection, request-time, and concurrency bounds |
| Untrusted content | MCP instructions and helper metadata label Discord content as data; the server never executes message contents |
| Observed-message archive | Owner-only SQLite storage, credential binding, partial edit merging, duplicate/stale snapshot handling, and explicit deletion/version metadata; never invents unseen content |

## Resource bounds

- Discord responses: 16 MiB decoded; files: 25 MiB combined / 10 files per request.
- API paths: 4096 characters; the server remains bound to Discord regardless of path.
- REST queue: 10 pending requests per process; shared scheduling enforces local
  credential limits across processes. Slots more than two minutes away are
  rejected for later retry.
- HTTP JSON body: 36 MiB; 8 active MCP requests / 64 socket connections.
- HTTP request/header/keepalive timeouts: 60 seconds / 10 seconds / 5 seconds.
- Gateway event buffer: at most 500 events and 32 MiB; dropped cursors reported.
- Gateway event waiters: at most 100; each public wait is at most 30 seconds.
- History helper: 1000 messages and 20 requests per call, followed by continuation.
- Archive read/search: 100 results per call; message version reads: 100 versions per
  page; inline history: first observed version and latest nine. Storage retention
  is unlimited; disk use grows over time. Archive failures and recorder heartbeat
  are visible through `discord_archive_status`.
- Search indexing wait: at most 30 seconds per helper call; search offsets capped
  by Discord at 9975. History continuation has no overall 10,000-message cap.

## Deployment choices

The default is full account access through the server. For reading and analysis,
set `MCP_READ_ONLY=true` in the server environment. That flag protects this MCP’s
mutation paths; it does not control other tools an AI client may have. Gateway
connection lifecycle is still enabled and establishes a Discord session.

Keep externally exposed HTTP deployments behind HTTPS with an exact Host allowlist
and only the browser origins you intend to use. Every client on an endpoint shares
one account and its event buffer. The server is not a multi-tenant credential
service and does not implement MCP OAuth discovery.

The MCP client remains responsible for recognizing human instructions and for its
approval policy on high-impact actions. Content labels and tool annotations are
not an independent prompt-injection firewall. In full mode, the account’s allowed
mutation operations remain available, including deletion and moderation.

## Verified scope

See [live validation](LIVE_VALIDATION.md) for the real account tests. The automated
suite covers cursor forgery, replay/channel boundaries, queued cancellations,
credential redaction, read-only enforcement through generic routes, size bounds,
quiet defaults, and transport authentication. Dependency audit reports no known
production advisories at verification time; that is not a security certification.

Server creation remains rejected with HTTP 403 for the tested account. Voice/video
streaming and screen sharing remain unimplemented. Other account/server mutations
are exposed where present in the API catalog but have not all been live-tested.

## Pacing reference

Discrub's published source at commit
[`95c5f908d80bcd3e78ba8694b114a59ef46804ba`](https://github.com/pratherbytecraft/discrub/tree/95c5f908d80bcd3e78ba8694b114a59ef46804ba)
was downloaded and reviewed without installation or execution. Its public source
is not licensed for copying into this MIT project, so this implementation is
independent. The behavioral references were separate read/write delays, random
additions, long-operation breaks, and stops on repeated 429/network errors.
Discrub's own service code references suspension reports; it does not establish a
never-flagged guarantee.

Discord's [rate-limit documentation](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx)
requires honoring returned limits and identifies 401/403/429 as invalid requests.
The [status-code reference](https://github.com/discord/discord-api-docs/blob/main/developers/topics/opcodes-and-status-codes.mdx)
documents account verification and messaging restriction codes. This server stops
or cools down accordingly; it does not solve challenges, impersonate a browser,
or certify user-account automation as safe.
