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
| Ambiguous writes | Network errors are not automatically retried; send helper retains the retry nonce in an ambiguous-failure error |
| HTTP entry point | Loopback default; separate strong Bearer key; Host/Origin checks; body, connection, request-time, and concurrency bounds |
| Untrusted content | MCP instructions and helper metadata label Discord content as data; the server never executes message contents |

## Resource bounds

- Discord responses: 16 MiB decoded; files: 25 MiB combined / 10 files per request.
- API paths: 4096 characters; the server remains bound to Discord regardless of path.
- REST queue: 100 pending requests per account; overflow rejected for later retry.
- HTTP JSON body: 36 MiB; 8 active MCP requests / 64 socket connections.
- HTTP request/header/keepalive timeouts: 60 seconds / 10 seconds / 5 seconds.
- Gateway event buffer: at most 500 events and 32 MiB; dropped cursors reported.
- Gateway event waiters: at most 100; each public wait is at most 30 seconds.
- History helper: 1000 messages and 20 requests per call, followed by continuation.
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
