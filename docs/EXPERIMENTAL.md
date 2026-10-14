# Experimental user-account tools

These undocumented client endpoints are exposed as separate tools in full mode,
and through `discord_call` in either mode. They use the server’s configured
authentication without bypassing Discord permissions, account verification, or
challenges. User tokens are outside Discord’s supported bot/OAuth API; these
operations have not been verified against a live account and can change at any time.

| Tool | Purpose |
| --- | --- |
| `discord_list_private_channels` | DM and group DM channel list |
| `discord_list_relationships` | Friends, blocks, requests |
| `discord_send_friend_request` | Request by username |
| `discord_set_relationship` | Friend/request (`type: 1`) or block (`type: 2`) by ID |
| `discord_remove_relationship` | Remove relationship or unblock |
| `discord_get_account_settings` | Legacy settings |
| `discord_update_account_settings` | Change legacy settings |
| `discord_get_settings_proto` | Base64 settings protobuf |
| `discord_update_settings_proto` | Change base64 settings protobuf; external encoder needed |
| `discord_get_user_profile` | Profile by user ID |
| `discord_update_my_profile` | Bio/pronouns and other profile fields |
| `discord_acknowledge_message` | Mark channel/message read |
| `discord_acknowledge_guild` | Mark server read |
| `discord_update_guild_notification_settings` | Mutes/notification overrides |
| `discord_search_private_channel_messages` | DM message search |
| `discord_join_guild_by_invite` | Accept invite, subject to verification |
| `discord_get_recent_mentions` | Mention history |
| `discord_get_guild_command_index` | Discover guild application commands |
| `discord_invoke_interaction` | Invoke a command or component with full interaction data |

For a newer or missing route, use `discord_api_request`. Supplying a path does not
guarantee Discord accepts it. These tools are made available even in bot/OAuth
mode so clients can inspect the complete catalog; most user-specific routes will
reject those authentication modes.
