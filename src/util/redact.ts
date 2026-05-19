// Secret scrubbing for log lines and arbitrary objects.
//
// Walks plain JSON-shaped values. Strings under secret-y keys (token, key,
// secret, password, authorization, bearer) become a placeholder. Free-form
// strings have Telegram bot tokens, OAuth bearer headers, and generic
// "name=value" pairs where the name looks secret-y rewritten too.

const SECRET_KEY_RE = /(token|secret|key|password|passwd|authorization|bearer|api[_-]?key)/i;
const PLACEHOLDER = '[redacted]';

// Telegram bot token: digits:base64-ish, ~35 chars.
const TELEGRAM_TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;
// OAuth-style "Bearer <stuff>".
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;
// Generic name=value where name looks secret-y.
const ASSIGN_RE =
  /\b(token|secret|key|password|passwd|authorization|bearer|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi;

export function redactString(input: string): string {
  return input
    .replace(TELEGRAM_TOKEN_RE, PLACEHOLDER)
    .replace(BEARER_RE, `Bearer ${PLACEHOLDER}`)
    .replace(ASSIGN_RE, (_, name: string) => `${name}=${PLACEHOLDER}`);
}

export function redact<T>(value: T): T {
  return walk(value, new WeakSet()) as T;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => walk(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k) && typeof v === 'string') {
      out[k] = PLACEHOLDER;
    } else {
      out[k] = walk(v, seen);
    }
  }
  return out;
}
