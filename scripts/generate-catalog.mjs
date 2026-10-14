import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const spec = JSON.parse(readFileSync(root + 'vendor/discord-openapi.json', 'utf8'));
const methods = ['get', 'post', 'put', 'patch', 'delete'];
const resolve = value => value?.$ref ? resolve(value.$ref.slice(2).split('/').reduce((v, k) => v[k], spec)) : value;

// Keep the advertised tool catalog compact. Full request definitions remain available
// through discord_describe_operation, including referenced definitions from the snapshot.
function compact(original, depth = 0) {
  const schema = resolve(original) ?? {};
  if (depth > 3) return schema.type ? { type: schema.type } : {};
  const result = {};
  for (const key of ['type', 'description', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && !(key === 'enum' && !schema.enum.length)) result[key] = schema[key];
  }
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties)
      .filter(([, value]) => value.contentEncoding !== 'binary')
      .map(([key, value]) => [key, compact(value, depth + 1)]));
    result.additionalProperties = true;
    const required = (schema.required ?? []).filter(key => key in result.properties);
    if (required.length) result.required = required;
  }
  if (schema.items) result.items = compact(schema.items, depth + 1);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') result.additionalProperties = compact(schema.additionalProperties, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) result[key] = schema[key].map(v => compact(v, depth + 1));
  // Empty branches in oneOf could make a valid request fail local validation after compaction.
  if (result.oneOf) { result.anyOf = result.oneOf; delete result.oneOf; }
  return result;
}
const fileSchema = {
  type: 'array', maxItems: 10, description: 'Base64 file uploads. For message attachments fields default to files[0], files[1], etc. For stickers use field=file.',
  items: { type: 'object', properties: {
    filename: { type: 'string', minLength: 1 }, data_base64: { type: 'string' },
    content_type: { type: 'string' }, field: { type: 'string' },
  }, required: ['filename', 'data_base64'], additionalProperties: false },
};
const catalog = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of methods) {
    if (!item[method]) continue;
    const op = item[method];
    const properties = {};
    const required = [];
    const queryProperties = {};
    const queryRequired = [];
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const param = resolve(raw);
      if (param.in === 'path') {
        properties[param.name] = { ...compact(param.schema), description: param.description ?? `Path parameter ${param.name}. Use Discord IDs as strings.` };
        required.push(param.name);
      } else if (param.in === 'query') {
        queryProperties[param.name] = compact(param.schema);
        if (param.required) queryRequired.push(param.name);
      }
    }
    // Tolerate path parameters omitted by an upstream preview specification.
    for (const [, key] of path.matchAll(/\{([^}]+)\}/g)) {
      if (!properties[key]) { properties[key] = { type: 'string', minLength: 1 }; required.push(key); }
    }
    if (Object.keys(queryProperties).length) {
      properties.query = { type: 'object', properties: queryProperties, additionalProperties: true };
      if (queryRequired.length) { properties.query.required = queryRequired; required.push('query'); }
    }
    const rb = resolve(op.requestBody);
    const contentTypes = Object.keys(rb?.content ?? {});
    if (rb) {
      const preferred = rb.content['application/json'] ?? rb.content['multipart/form-data'] ?? Object.values(rb.content)[0];
      properties.body = { ...compact(preferred.schema), description: 'Discord request payload. Use discord_describe_operation for complete schemas. Binary fields belong in files.' };
      if (rb.required) required.push('body');
      properties.content_type = { type: 'string', enum: ['json', 'multipart', 'form'], description: 'Encoding override. Files automatically select multipart; multipart-only routes default to fields mode.' };
      if (contentTypes.includes('multipart/form-data')) properties.files = fileSchema;
    }
    if (method !== 'get') properties.reason = { type: 'string', maxLength: 512, description: 'Optional audit log reason, on operations that support it.' };
    const auth = op.security ?? spec.security ?? [];
    const authentication = auth.map(a => Object.entries(a).map(([key, scopes]) => `${key}${scopes.length ? ` (${scopes.join(', ')})` : ''}`).join(' + ')).join(' or ') || 'none';
    catalog.push({ name: `discord_${op.operationId}`, description: `${op.operationId.replaceAll('_', ' ')}. ${method.toUpperCase()} ${path}. Documented authentication: ${authentication}. User-token compatibility is experimental; Discord enforces permissions.`,
      method: method.toUpperCase(), path, inputSchema: { type: 'object', properties, required: [...new Set(required)], additionalProperties: false }, contentTypes, auth });
  }
}
catalog.sort((a, b) => a.name.localeCompare(b.name));
if (new Set(catalog.map(c => c.name)).size !== catalog.length) throw new Error('Duplicate operation IDs.');
const json = JSON.stringify(catalog, null, 2) + '\n';
const docs = '# Generated public REST tools\n\n' +
  `All ${catalog.length} operations in the vendored Discord v10 public OpenAPI snapshot are exposed. This is API coverage, not proof every operation works with every authentication mode.\n\n` +
  'Path IDs are top-level tool arguments. Filters go in `query`, request payloads in `body`, and base64 uploads in `files`. Inspect complex payloads with `discord_describe_operation`.\n\n' +
  '| Tool | Method | Path |\n| --- | --- | --- |\n' + catalog.map(op => `| \`${op.name}\` | ${op.method} | \`${op.path}\` |`).join('\n') + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(root + 'data/catalog.json', 'utf8') !== json || readFileSync(root + 'docs/TOOLS.md', 'utf8') !== docs) throw new Error('Generated catalog is stale; run npm run catalog:generate.');
} else {
  mkdirSync(root + 'data', { recursive: true }); mkdirSync(root + 'docs', { recursive: true });
  writeFileSync(root + 'data/catalog.json', json); writeFileSync(root + 'docs/TOOLS.md', docs);
}
console.log(`${catalog.length} public operations ${process.argv.includes('--check') ? 'verified' : 'generated'}.`);
