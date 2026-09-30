/**
 * Keys compare after normalizeKey(): lower case, '-' and '_' removed, so
 * `action_script`, `actionScript` and `Action-Script` are the same key.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Tool arguments masked in the audit log. */
const SENSITIVE_ARGS: ReadonlySet<string> = new Set([
  'text', 'script', 'value', 'password', 'steps', 'actionscript', 'condition',
  'prompttext',
]);

/** Result keys (headers, JSON fields) whose value is always masked. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie',
  'xapikey', 'apikey', 'xgoogapikey',
  'xauthtoken', 'authtoken', 'xaccesstoken', 'accesstoken', 'refreshtoken', 'idtoken',
  'xcsrftoken', 'csrftoken', 'xxsrftoken', 'xsrftoken',
  'xamzsecuritytoken', 'sessionid', 'clientsecret', 'secret', 'password', 'passwd',
]);

const MASKED = '[MASKED]';

const AUTH_SCHEME_RE = /\b(Bearer\s+)\S+/gi;
const BASIC_AUTH_RE = /\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g;

/** Names of secrets inside strings: query strings, form bodies, JSON bodies. */
const SECRET_NAME =
  '(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|' +
  'api_key|apikey|session_id|sessionid|auth)';
/** `?token=...`, `&password=...`, form bodies (`password=...&`). */
const QUERY_SECRET_RE = new RegExp(`((?:^|[?&;])${SECRET_NAME}=)[^&#;,\\s"']*`, 'gi');
/** `"password": "..."` in JSON text. */
const JSON_SECRET_RE = new RegExp(`("${SECRET_NAME}"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, 'gi');

/**
 * Invisible and reordering characters a page can use to hide or disguise
 * text shown to the LLM: C0/C1 controls (except tab, LF, CR), bidi embeddings,
 * overrides and isolates (U+202A-202E, U+2066-2069), zero-width and
 * direction marks (U+200B-200F, U+2060-2064, U+061C, U+180E, U+FEFF) and
 * Unicode tag characters (U+E0000-E007F).
 */
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;

export function maskSensitiveArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    masked[key] = SENSITIVE_ARGS.has(normalizeKey(key)) ? '***' : val;
  }
  return masked;
}

/** Remove the characters matched by INVISIBLE_RE. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
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
      const safeKey = stripInvisible(key);
      sanitized[safeKey] = SECRET_KEYS.has(normalizeKey(safeKey)) ? MASKED : sanitizeResult(val);
    }
    return sanitized;
  }

  return result;
}
