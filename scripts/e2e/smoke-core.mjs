/**
 * Pure helpers of scripts/e2e/tools-smoke.mjs, kept apart so tests/scripts
 * can check them without a daemon or Firefox.
 */

/** First `n` code points of `s` with whitespace runs collapsed (never splits a surrogate pair). */
export function truncate(s, n = 120) {
  return Array.from(String(s ?? '').replace(/\s+/g, ' ')).slice(0, n).join('');
}

/**
 * Interpret the daemon's answer to POST /mcp/call.
 *
 * 200 wraps the MCP CallToolResult: `{ success, result }`. Errors (403 auth,
 * 500 …) carry `{ error }` only, without `success`, so the status decides;
 * 400 (bad arguments) has `success: false`. No answer or a body that is not
 * JSON is an error too.
 *
 * @param {{status: number, body: Buffer|string}|null} res
 * @returns {{isError: boolean, text: string, data: any, content: any[]}}
 */
export function interpretCallResponse(res) {
  if (!res) return { isError: true, text: 'no answer from the daemon', data: undefined, content: [] };
  const bodyText = res.body.toString('utf8');
  let outer;
  try {
    outer = JSON.parse(bodyText);
  } catch {
    return { isError: true, text: `HTTP ${res.status}: not JSON: ${truncate(bodyText, 80)}`, data: undefined, content: [] };
  }
  const ok = res.status >= 200 && res.status < 300;
  if (!ok || !outer || typeof outer !== 'object') {
    const why = outer && typeof outer.error === 'string' ? outer.error : truncate(bodyText, 80);
    return { isError: true, text: `HTTP ${res.status}: ${why}`, data: undefined, content: [] };
  }
  const result = outer.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { isError: outer.success === false || Boolean(result.isError), text, data, content };
}
