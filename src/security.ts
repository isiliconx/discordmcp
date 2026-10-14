import { timingSafeEqual } from 'node:crypto';

export function redact(value: unknown, secrets: string[]): unknown {
  // Redact configured credentials wherever a remote API echoes them, including nested errors.
  const replace = (text: string) => secrets.filter(Boolean).reduce(
    (result, secret) => result.split(secret).join('[REDACTED]'), text);
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [replace(key), redact(item, secrets)]));
  }
  return value;
}

export function matchesSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateApiPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\?#\s\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Use a relative Discord API path such as /channels/123/messages; pass query separately.');
  }
  for (const segment of path.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error('Malformed path encoding.'); }
    if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) {
      throw new Error('Path traversal and encoded path separators are not allowed.');
    }
  }
  if (/^\/api(?:\/|$)/.test(path)) throw new Error('Omit /api/v10 from the API path.');
}
