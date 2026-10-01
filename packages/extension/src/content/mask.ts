// Masking of sensitive headers in logged network traffic.

// Headers that must never appear in logged network traffic
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);

export function maskHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    safe[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? "[MASKED]"
      : value;
  }
  return safe;
}
