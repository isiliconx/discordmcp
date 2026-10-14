# Observed message archive

The archive saves messages this account actually reads or receives. It supports
server channels, threads, DMs, and group DMs through the same `channel_id` model.
There is no server/channel allowlist in the recorder. Discord permissions,
Gateway delivery, bot intents/content access, and experimental user-session
subscriptions determine what content arrives. This is not proof of complete
coverage of every channel the Discord client can open.

## Observation and version semantics

- `MESSAGE_CREATE`: save available content and mark original text observed.
- `MESSAGE_UPDATE`: merge supplied fields into known state; omitted text does not
  erase the earlier text. Content/attachments/embeds/components/flags/stickers/poll
  changes create an observed version. Duplicate snapshots do not create duplicates.
- `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK`: save a deletion marker and retain
  all existing versions. If the message was never observed, retain only its IDs
  and the marker, with `content_known=false` and `original_observed=false`.
- Successful normal message REST reads/sends/edits, message search responses,
  and explicit message deletions are also recorded. Older REST snapshots cannot
  overwrite a message with a newer known edit timestamp. Deletion markers remain.

Only supplied fields are available. Content restrictions may provide an empty
message field; the archive cannot infer whether an unavailable original contained
more text. An original already edited before the first observation is not marked
as observed. Older unseen edits are never reconstructed. Timestamps are the
observation time, alongside Discord's original/edit timestamp fields when supplied.

Archive failures do not cause an API mutation to be repeated. They are exposed
in `discord_archive_status` and background recorder status. Inspect that status
to assess whether recording is currently connected and whether persistence failed.

## AI results

The normal `discord_read_history` tool merges live and saved messages in message-ID
order, includes saved deletions, and attaches `archive` metadata with deletion time,
content/original availability, version count, and observed version snapshots.
Both original and current text remain available to the AI. They are clearly
identified as observed history rather than misrepresented as current Discord state.
Signed continuation cursors still preserve the initial newest-message boundary.
The budget remains at most 1000 returned messages and 20 Discord requests per call.
If live history fails but saved channel content exists, the helper returns the
saved history with `source=local_archive`, `live_available=false`, and a sanitized
`live_error`. This is an explicit offline result, not proof that current Discord
history was read completely. Without saved content, the live error is returned.

Inline versions include the first observed version and the latest nine versions;
`versions_truncated=true` signals more. Use `discord_archive_get_message` with
`offset`/`limit` to read all observed versions. Each version includes its source,
observation time, and merged message snapshot. All message content remains
untrusted data, including earlier/deleted content.

`discord_archive_read_channel` works entirely from disk and returns `next_before`
when another page exists. `discord_archive_search` searches literal text in every
observed version (case-insensitive according to SQLite's built-in `lower` rules).
Search results show saved current state and inline versions; paginated message
versions reveal older matches omitted from the inline sample. Optional channel,
guild, deleted-only, and edited-only filters narrow results. Archive tools work
even if the channel was deleted or the account can no longer read it live.
Guild filters require an observed guild ID; some REST message responses omit it.

Native REST reads and Discord's indexed search retain their live behavior. A
deleted message still returns a live 404; the saved counterpart remains available
through archive tools. There is no automatic bulk download of existing history.
Reading history seeds the archive only with the messages actually returned.

## Storage and process lifetime

SQLite uses WAL journaling, full synchronous writes, and a bounded lock wait so
independent MCP clients and a recorder can share one database. The parent directory
must be private (`0700`), and the database uses `0600`. No archive data is included
in Git or the npm package. Storage is unencrypted and retention is unlimited.
Message contents, author metadata, attachment metadata/URLs, and observed versions
are saved. Attachment files are not downloaded, and URLs can expire.

The archive is bound to a credential fingerprint. A different credential cannot
silently open it. When rotating a token, use a new path (the default path changes
automatically). Preserve the old private database if its history is needed; current
tools do not migrate or merge archives across credentials.

`archive start --env-file /absolute/path/.env` launches a detached background
process and reports whether it reached Gateway READY. `archive status` reports
counts and heartbeat; `archive stop` verifies the Linux worker command before
sending SIGTERM. Other platforms can run the foreground `--archive-only` command
under their OS service manager. A database lease prevents two background recorders
from running simultaneously. Reconnects use the existing Gateway backoff/resume
logic; failed initial connections wait at least 60 seconds before another attempt.

The recorder survives an AI chat/client closing, but a computer/container restart,
process termination, invalid credentials, lost access, missing events, or disk
failure can interrupt recording. Reboot autostart is not installed. Gateway resume
may replay a short gap; an unresumable gap is not recoverable. The archive never
fetches deleted messages from a hidden endpoint or bypasses Discord permissions.

## Verification

Automated tests cover persistent restart recovery, empty/partial edits, duplicates,
single/bulk deletion, unknown originals, stale snapshots, literal search over
older versions, mixed history pagination, all-deleted history, concurrent database
handles, recorder leases, REST integration, and Gateway event-buffer eviction.

With a configured, connected background recorder, run:

```bash
npm run smoke:archive -- --isolated --env-file /absolute/path/.env
```

The live script creates a self-only group DM and verifies its membership before
sending anything. A separate mutation client has archiving disabled, proving
CREATE/UPDATE/DELETE preservation came from the background Gateway recorder. A
reader checks both versions, deleted-message live 404, merged normal history,
original-version search, and persistence across reader restarts. Fixtures are
deleted and the group DM is left. No other conversation is used for write tests.
