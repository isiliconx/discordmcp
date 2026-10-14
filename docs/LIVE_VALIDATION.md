# Live user-account validation

Tested on 2026-10-14 with a user-provided account token, using the actual MCP server
and Discord API. Credentials, account identifiers, membership lists, and private
message contents are excluded from this record.

The reproducible isolated suite passed **30 checks, 0 failures** with version 1.1.
The automated suite passes 27 tests. These
results verify a representative subset; they do not certify every advertised
operation or every account’s permissions.

| Area | Live result |
| --- | --- |
| MCP over stdio | Initialization, tool dispatch, and user authentication passed |
| MCP over Streamable HTTP | Bearer-authenticated user lookup, guild list, and message reads passed |
| Account reads | Guilds, private channels, relationships, connections, settings protobuf, profile, and recent mentions passed |
| Guild reads | Channel list, text-channel history, and a specific message passed |
| Gateway | READY, buffered READY dispatch, and live MESSAGE_CREATE dispatch passed |
| Private test fixture | Created a group DM with an empty recipient list; verified account ownership and no other participants |
| Messages | Create, exact read, edit, delete, and history passed |
| Replies | Reply helper returned type 19 with the exact source-message reference; a missing target failed without creating an ordinary message |
| History continuation | Before/after paging passed; signed continuation resumed across separate processes without gaps/duplicates and excluded newer arrivals |
| Cursor integrity | Modified cursor rejected in both regression and live tests; another-channel/account cursors rejected in regression tests |
| Duplicate sends | Two sends using the same nonce returned the same message ID |
| Mentions | Default helper send containing `@everyone`/`@here` returned `mention_everyone: false`; outgoing suppression verified for generic sends, edits, and webhooks in regression tests |
| Optional read-only mode | A separate live read-only process read history but rejected helper/raw API writes |
| Guild search | Native catalog operation and new helper returned the exact known message in an accessible channel using channel/ID filters |
| DM search | Existing-DM search returned an exact known message; a new self-only DM eventually returned every fixture message after indexing caught up |
| Deleted messages | Exact lookup returned HTTP 404 / code 10008 instead of a nearby message |
| Reactions | Add, list the account’s reaction, and remove passed |
| Pins | Pin, list the pinned message, and unpin passed |
| Read receipts | Acknowledge message passed |
| Attachments | Multipart text-file upload returned an attachment; deleting the upload message passed |
| Cleanup | Test messages were deleted and all temporary self-only group DMs were left successfully |

## Compatibility fix found during testing

The direct `GET /channels/{channel_id}/messages/{message_id}` endpoint rejected
user authentication with HTTP 403 / code 20002 (`Only bots can use this endpoint`).
User mode now queries channel history with `around=message_id&limit=1` and returns
only an exact ID match. The fix passed live tests in a group DM and an existing
guild text channel. It also passed the deleted-message case. Bot and OAuth modes
retain the original endpoint. The adaptation is shared by named tools and the
general API request tool.

The new `discord_create_group_dm` tool passed live testing with `recipients: []`.

## Search behavior

The first new-DM search did not immediately include every just-created message.
Later bounded polling of the new DM returned all fixture IDs; an existing DM and
an existing guild also returned the exact ID under test. The reproducible suite
now verifies DM search after bounded indexing waits. Immediate search completeness
for freshly posted messages is not guaranteed by Discord. Use history for an
exhaustive read. The helper exposes pending indexing separately from zero matches.

An additional advanced live suite passed 11 checks covering helpers, cross-process
history continuation, stable snapshot boundaries, cursor rejection, duplicate
prevention, read-only mode, and existing DM/guild searches. It also observed a
successful new-DM search returning all six fixtures. Every fixture message was
deleted and the self-only group DM was left successfully.

## Requests that remain unsupported in this validation

Both `POST /guilds` and `POST /guilds/templates/{code}` returned HTTP 403 / code
10008 (`Unknown Message`) for the test account. No server was created. The reason
for those responses has not been determined. Neither server-creation route is in
the vendored public operation catalog; the requests were attempted through the
general API tool and are not claimed to work in user mode.

Other state-changing user/account/server operations, application interactions,
presence, and voice-state signalling were not live-tested in this run. Voice/video
media streaming remains unimplemented. Message tests were confined to self-only group DMs; existing contacts and
other users were not messaged.

## Reproduce

Supply `DISCORD_TOKEN` and `DISCORD_AUTH_TYPE=user` through the environment or an
ignored `.env` file.

```bash
npm run smoke:live                 # Read-only account checks
npm run smoke:live -- --isolated   # Self-only group DM, messaging, uploads, Gateway, and cleanup
```

The isolated suite prints pass/fail statuses without account or message data. It
checks exact message contents, reaction ownership, pin membership, attachment
count, and the actual event’s channel/content rather than treating any successful
HTTP response as proof of behavior. A failed cleanup prints the test-channel ID
so it can be removed manually. The test does not alter account settings or contact
other users.
