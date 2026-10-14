/**
 * Pure helpers of scripts/e2e/tools-smoke.mjs and reviewer-smoke.mjs, kept
 * apart so tests/scripts can check them without a daemon or Firefox.
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
  const interpreted = interpretToolResult(result);
  return { ...interpreted, isError: outer.success === false || interpreted.isError };
}

/**
 * Read an MCP CallToolResult: the text blocks joined, and that text parsed
 * as JSON when it is one JSON document (else `data` is undefined).
 *
 * @param {{isError?: boolean, content?: any[]}} result
 * @returns {{isError: boolean, text: string, data: any, content: any[]}}
 */
export function interpretToolResult(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { isError: Boolean(result.isError), text, data, content };
}

/**
 * Whether a tool result is the guard's "human approval needed" answer: one of
 * its text blocks is a JSON object with `confirmationRequired: true` (the
 * block relay/approval.ts reads). The relay returns it when the human did not
 * approve, or could not be asked (headless mode has no popup).
 *
 * @param {{isError?: boolean, content?: any[]}} result
 */
export function needsApproval(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.some((block) => {
    if (block?.type !== 'text') return false;
    try {
      return JSON.parse(block.text)?.confirmationRequired === true;
    } catch {
      return false;
    }
  });
}

/**
 * The values of the form fields of `type` (e.g. 'password', 'hidden') in a
 * fox_read mode 'info' answer (`forms[].fields[]`), in page order.
 *
 * @param {any} pageInfo
 * @param {string} type
 * @returns {unknown[]}
 */
export function formFieldValues(pageInfo, type) {
  const forms = Array.isArray(pageInfo?.forms) ? pageInfo.forms : [];
  return forms
    .flatMap((form) => (Array.isArray(form?.fields) ? form.fields : []))
    .filter((field) => field?.type === type)
    .map((field) => field.value);
}

/**
 * The fixture file a request path names, or null. Only the files listed in
 * `fileNames` are served, so a path such as `/../package.json` matches
 * nothing; `/` is `index.html`.
 *
 * @param {string} urlPath  request path, query and fragment allowed
 * @param {readonly string[]} fileNames
 * @returns {string|null}
 */
export function fixtureFileFor(urlPath, fileNames) {
  const pathname = urlPath.split(/[?#]/, 1)[0];
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  return fileNames.includes(name) ? name : null;
}

/** Command line of scripts/e2e/reviewer-smoke.mjs: `--headless` and `--help` only. */
export function parseReviewerSmokeArgs(argv) {
  const known = new Set(['--headless', '-h', '--help']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(' ')}` };
  return { headless: argv.includes('--headless'), help: argv.includes('-h') || argv.includes('--help') };
}

/**
 * A plain-text table: one column per key of `columns`, each as wide as its
 * longest cell, separated by two spaces.
 *
 * @param {Record<string, string>} columns  key → heading
 * @param {Record<string, unknown>[]} rows
 */
export function formatTable(columns, rows) {
  const keys = Object.keys(columns);
  const cells = [columns, ...rows].map((row) => keys.map((k) => String(row[k] ?? '')));
  const widths = keys.map((_, i) => Math.max(...cells.map((line) => Array.from(line[i]).length)));
  const pad = (line) => line.map((cell, i) => cell + ' '.repeat(widths[i] - Array.from(cell).length)).join('  ').trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');

  return [pad(cells[0]), rule, ...cells.slice(1).map(pad)].join('\n');
}
