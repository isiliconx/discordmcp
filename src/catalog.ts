import { readFileSync } from 'node:fs';
import type { Operation, JsonSchema } from './types.js';

export const publicOperations = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8')) as Operation[];
const object: JsonSchema = { type: 'object', additionalProperties: true };
const query: JsonSchema = { type: 'object', additionalProperties: { anyOf: [{ type: ['string', 'number', 'boolean', 'null'] }, { type: 'array', items: { type: ['string', 'number', 'boolean'] } }] } };
export const filesSchema = {
  type: 'array', maxItems: 10, items: { type: 'object', properties: {
    filename: { type: 'string', minLength: 1 }, data_base64: { type: 'string' },
    content_type: { type: 'string' }, field: { type: 'string' },
  }, required: ['filename', 'data_base64'], additionalProperties: false },
};
function experimental(id: string, method: Operation['method'], path: string, description: string, body?: JsonSchema, bodyRequired = false): Operation {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [, key] of path.matchAll(/\{([^}]+)\}/g)) { properties[key] = { type: 'string', minLength: 1 }; required.push(key); }
  properties.query = query;
  if (body) { properties.body = body; if (bodyRequired) required.push('body'); }
  if (method !== 'GET') properties.reason = { type: 'string', maxLength: 512 };
  return { name: `discord_${id}`, method, path, description: `${description} ${method} ${path}. EXPERIMENTAL undocumented user-account endpoint; compatibility is not guaranteed.`,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    contentTypes: body ? ['application/json'] : [], auth: [{ UserToken: [] }], experimental: true };
}
export const userOperations = [
  experimental('list_private_channels', 'GET', '/users/@me/channels', 'List the account’s DM and group DM channels.'),
  experimental('list_relationships', 'GET', '/users/@me/relationships', 'List friends, blocks, and pending friend requests.'),
  experimental('send_friend_request', 'POST', '/users/@me/relationships', 'Send a friend request by username.', {
    type: 'object', properties: { username: { type: 'string' }, discriminator: { type: 'string' } }, required: ['username'], additionalProperties: true,
  }, true),
  experimental('set_relationship', 'PUT', '/users/@me/relationships/{user_id}', 'Set a relationship by user ID: type 1 for friend/request, type 2 for block.', {
    type: 'object', properties: { type: { type: 'integer', enum: [1, 2] } }, required: ['type'], additionalProperties: true,
  }, true),
  experimental('remove_relationship', 'DELETE', '/users/@me/relationships/{user_id}', 'Remove a friend/request or unblock a user.'),
  experimental('get_account_settings', 'GET', '/users/@me/settings', 'Get legacy account settings. Some settings moved to the settings-proto endpoint.'),
  experimental('update_account_settings', 'PATCH', '/users/@me/settings', 'Update legacy account settings.', object, true),
  experimental('get_settings_proto', 'GET', '/users/@me/settings-proto/{settings_type}', 'Get settings protobuf (base64); type 1 is preloaded settings.'),
  experimental('update_settings_proto', 'PATCH', '/users/@me/settings-proto/{settings_type}', 'Update a base64-encoded settings protobuf. Requires external protobuf encoding.', object, true),
  experimental('get_user_profile', 'GET', '/users/{user_id}/profile', 'Get a user profile; optional guild_id query for a server profile.'),
  experimental('update_my_profile', 'PATCH', '/users/@me/profile', 'Update profile fields such as bio and pronouns.', object, true),
  experimental('acknowledge_message', 'POST', '/channels/{channel_id}/messages/{message_id}/ack', 'Mark a message/channel as read.', object, true),
  experimental('acknowledge_guild', 'POST', '/guilds/{guild_id}/ack', 'Mark a server as read.', object),
  experimental('update_guild_notification_settings', 'PATCH', '/users/@me/guilds/{guild_id}/settings', 'Update server notification settings, mute, or channel overrides.', object, true),
  experimental('search_private_channel_messages', 'GET', '/channels/{channel_id}/messages/search', 'Search DM messages; filters such as content, author_id, has, offset, and limit go in query.'),
  experimental('join_guild_by_invite', 'POST', '/invites/{invite_code}', 'Accept an invite. Discord may require CAPTCHA or verification; this tool does not bypass challenges.', object),
  experimental('get_recent_mentions', 'GET', '/users/@me/mentions', 'Get recent mentions.'),
  experimental('get_guild_command_index', 'GET', '/guilds/{guild_id}/application-command-index', 'Discover installed application commands.'),
  experimental('invoke_interaction', 'POST', '/interactions', 'Invoke an application command or message component. Provide Discord’s full interaction payload; Gateway session context may be required.', object, true),
];
export const operations = [...publicOperations, ...userOperations];
export function describeOperation(name: string) {
  const op = operations.find(item => item.name === name || item.name === `discord_${name}`);
  if (!op) throw new Error(`Unknown operation: ${name}`);
  if (op.experimental) return op;
  const spec = JSON.parse(readFileSync(new URL('../vendor/discord-openapi.json', import.meta.url), 'utf8'));
  const item = spec.paths[op.path];
  const details = item[op.method.toLowerCase()];
  const definitions: JsonSchema = {};
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref?.startsWith('#/components/schemas/')) {
      const key = value.$ref.split('/').at(-1);
      if (!(key in definitions)) { definitions[key] = spec.components.schemas[key]; visit(definitions[key]); }
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'responses') visit(child);
  };
  visit(details.requestBody); visit(item.parameters); visit(details.parameters);
  return { ...op, parameters: [...(item.parameters ?? []), ...(details.parameters ?? [])],
    requestBody: details.requestBody ?? null, components: { schemas: definitions },
    note: 'Request schemas are from the official preview specification. Discord documentation takes precedence when they differ.' };
}
