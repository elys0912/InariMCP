const SENSITIVE_ARGS: Set<string> = new Set([
  'text', 'script', 'value', 'password', 'steps', 'action_script', 'condition',
]);

const MASKED = '[MASKED]';

const AUTH_HEADER_RE = /\b(Bearer\s+)\S+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g;
const COOKIE_HEADER_KEYS = new Set(['cookie', 'set-cookie']);
const AUTH_HEADER_KEYS = new Set(['authorization']);

export function maskSensitiveArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    masked[key] = SENSITIVE_ARGS.has(key) ? '***' : val;
  }
  return masked;
}

function maskStringValue(s: string): string {
  let result = s;
  result = result.replace(AUTH_HEADER_RE, `$1${MASKED}`);
  result = result.replace(JWT_RE, MASKED);
  return result;
}

export function sanitizeResult(result: unknown): unknown {
  if (result === null || result === undefined) return result;

  if (typeof result === 'string') {
    return maskStringValue(result);
  }

  if (Array.isArray(result)) {
    return result.map(sanitizeResult);
  }

  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (AUTH_HEADER_KEYS.has(lowerKey) || COOKIE_HEADER_KEYS.has(lowerKey)) {
        sanitized[key] = MASKED;
      } else if (typeof val === 'string') {
        sanitized[key] = maskStringValue(val);
      } else {
        sanitized[key] = sanitizeResult(val);
      }
    }
    return sanitized;
  }

  return result;
}
