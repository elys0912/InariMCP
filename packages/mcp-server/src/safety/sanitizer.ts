/**
 * Keys compare after normalizeKey(): lower case, '-' and '_' removed, so
 * `prompt_text`, `promptText` and `Prompt-Text` are the same key.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Tool arguments masked in the audit log. */
const SENSITIVE_ARGS: ReadonlySet<string> = new Set([
  'text', 'value', 'password', 'steps', 'prompttext',
]);

/** Result keys (headers, JSON fields) whose value is always masked. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie',
  'xapikey', 'apikey', 'xgoogapikey', 'ocpapimsubscriptionkey', 'secretkey',
  'token', 'xauthtoken', 'authtoken', 'xaccesstoken', 'accesstoken', 'refreshtoken', 'idtoken',
  'privatetoken', 'xcsrftoken', 'csrftoken', 'xxsrftoken', 'xsrftoken',
  'xamzsecuritytoken', 'sessionid', 'clientsecret', 'secret', 'password', 'passwd',
]);

const MASKED = '[MASKED]';

const AUTH_SCHEME_RE = /\b(Bearer\s+)\S+/gi;
const BASIC_AUTH_RE = /\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g;

/**
 * Names of secrets inside strings: query strings, URL fragments (OAuth
 * implicit flow), form bodies, JSON bodies. `[-_]?` also covers camelCase
 * (the match is case-insensitive).
 */
const SECRET_NAME =
  '(?:password|passwd|pwd|secret|client[-_]?secret|secret[-_]?key|' +
  '(?:access|refresh|id|auth|private|csrf|xsrf)?[-_]?token|' +
  'api[-_]?key|session[-_]?id|auth)';
/** `?token=...`, `#access_token=...`, `&password=...`, form bodies (`password=...&`). */
const QUERY_SECRET_RE = new RegExp(`((?:^|[?&;#])${SECRET_NAME}=)[^&#;,\\s"']*`, 'gi');
/** `"password": "..."` in JSON text. */
const JSON_SECRET_RE = new RegExp(`("${SECRET_NAME}"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, 'gi');

/**
 * Invisible and reordering characters a page can use to hide or disguise
 * text shown to the LLM: C0/C1 controls (except tab, LF, CR), soft hyphen,
 * bidi embeddings, overrides and isolates (U+202A-202E, U+2066-2069),
 * zero-width space and direction marks (U+200B, U+200E-200F, U+2060-2064,
 * U+061C, U+180E, U+FEFF), Unicode tag characters (U+E0000-E007F) and the
 * supplementary variation selectors (U+E0100-E01EF). ZWNJ / ZWJ
 * (U+200C-200D) and U+FE00-FE0F stay: scripts and emoji need them.
 */
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F\uDD00-\uDDEF]/g;

export function maskSensitiveArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    masked[key] = SENSITIVE_ARGS.has(normalizeKey(key)) ? '***'
      // e.g. a url argument carrying ?token=...
      : typeof val === 'string' ? sanitizeString(val)
        : val;
  }
  return masked;
}

/** Remove the characters matched by INVISIBLE_RE. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}

/**
 * Characters escaped in text shown to a human who approves a call: those of
 * INVISIBLE_RE, plus ZWNJ / ZWJ (U+200C-200D) and the line / paragraph
 * separators (U+2028-2029), which `JSON.stringify` leaves as they are and
 * which break or join lines in the popup and the MCP client.
 */
const HUMAN_HIDDEN_RE = new RegExp(`${INVISIBLE_RE.source}|[\\u200C\\u200D\\u2028\\u2029]`, 'g');

/** Digits of a `\uXXXX` escape (BMP code points). */
const BMP_ESCAPE_DIGITS = 4;

function escapeCodePoint(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const hex = cp.toString(16).toUpperCase();
  return hex.length <= BMP_ESCAPE_DIGITS ? `\\u${hex.padStart(BMP_ESCAPE_DIGITS, '0')}` : `\\u{${hex}}`;
}

/**
 * Show the invisible and reordering characters of `s` as escapes
 * (`\u202E`, `\u{E0041}`) instead of removing them, so a human sees that
 * they are there. `found` tells whether there was any.
 */
export function revealInvisible(s: string): { text: string; found: boolean } {
  let found = false;
  const text = s.replace(HUMAN_HIDDEN_RE, (ch) => {
    found = true;
    return escapeCodePoint(ch);
  });
  return { text, found };
}

/**
 * Sanitize one string bound for the MCP client: strip invisible characters,
 * mask credentials (Bearer / Basic values, JWTs, secret query parameters and
 * JSON fields).
 */
export function sanitizeString(s: string): string {
  let result = stripInvisible(s);
  result = result.replace(AUTH_SCHEME_RE, `$1${MASKED}`);
  result = result.replace(BASIC_AUTH_RE, `$1${MASKED}`);
  result = result.replace(JWT_RE, MASKED);
  result = result.replace(QUERY_SECRET_RE, `$1${MASKED}`);
  result = result.replace(JSON_SECRET_RE, `$1${MASKED}$2`);
  return result;
}

export function sanitizeResult(result: unknown): unknown {
  if (result === null || result === undefined) return result;

  if (typeof result === 'string') {
    return sanitizeString(result);
  }

  if (Array.isArray(result)) {
    return result.map(sanitizeResult);
  }

  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      // Header names in network logs come from the page as well.
      // A stripped key that collides with another key keeps its original
      // form, so the page cannot overwrite one entry with another.
      const stripped = stripInvisible(key);
      const safeKey = stripped !== key && stripped in obj ? key : stripped;
      sanitized[safeKey] = SECRET_KEYS.has(normalizeKey(stripped)) ? MASKED : sanitizeResult(val);
    }
    return sanitized;
  }

  return result;
}
