/**
 * Pure helpers of scripts/e2e/tools-smoke.mjs, kept apart so tests/scripts
 * can check them without a daemon or Firefox.
 */

/** Code points of a response body quoted in an error. */
const BODY_EXCERPT_LENGTH = 80;

/** First `n` code points of `s` with whitespace runs collapsed (never splits a surrogate pair). */
export function truncate(s, n = 120) {
  return Array.from(String(s ?? '').replace(/\s+/g, ' ')).slice(0, n).join('');
}

/**
 * Interpret the daemon's answer to POST /mcp/call.
 *
 * 200 wraps the MCP CallToolResult: `{ success, result }`. Errors (403 auth,
 * 500 …) carry `{ error }` only, without `success`, so the status decides;
 * 400 (bad arguments) has `success: false`. No answer, a body that is not
 * JSON, and a 2xx body that is not an object with `result` (an array, `{}`)
 * are errors too.
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
    return { isError: true, text: `HTTP ${res.status}: not JSON: ${truncate(bodyText, BODY_EXCERPT_LENGTH)}`, data: undefined, content: [] };
  }
  const ok = res.status >= 200 && res.status < 300;
  const isObject = outer !== null && typeof outer === 'object' && !Array.isArray(outer);
  if (!ok || !isObject) {
    const why = isObject && typeof outer.error === 'string' ? outer.error : truncate(bodyText, BODY_EXCERPT_LENGTH);
    return { isError: true, text: `HTTP ${res.status}: ${why}`, data: undefined, content: [] };
  }
  const result = outer.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { isError: true, text: `HTTP ${res.status}: no result in ${truncate(bodyText, BODY_EXCERPT_LENGTH)}`, data: undefined, content: [] };
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { isError: outer.success === false || Boolean(result.isError), text, data, content };
}

/**
 * The approval request of a call answered `confirmation_required` (every
 * acting tool asks the human first): `details.approval.requestId` of its
 * JSON block, or undefined when the call needs no approval or cannot be
 * approved.
 *
 * @param {{isError: boolean, content: any[]}} r  interpretCallResponse()
 * @returns {string|undefined}
 */
export function approvalRequestId(r) {
  if (!r.isError) return undefined;
  for (const block of r.content) {
    if (!block || block.type !== 'text') continue;
    let parsed;
    try { parsed = JSON.parse(block.text); } catch { continue; }
    const id = parsed?.confirmationRequired === true ? parsed.approval?.requestId : undefined;
    if (typeof id === 'string' && id !== '') return id;
  }
  return undefined;
}
