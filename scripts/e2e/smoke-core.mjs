/**
 * Pure helpers of scripts/e2e/tools-smoke.mjs and reviewer-smoke.mjs, kept
 * apart so tests/scripts can check them without a daemon or Firefox.
 */

/** Code points of a response body quoted in an error. */
const BODY_EXCERPT_LENGTH = 80;

/**
 * How long the add-on's toolbar popup waits for the human to approve a call
 * (BROWSER_APPROVAL_WAIT_MS of packages/mcp-server/src/tools/approval-flow.ts;
 * the scripts cannot import the TypeScript sources).
 */
export const POPUP_APPROVAL_WAIT_MS = 60_000;

/** First `n` code points of `s` with whitespace runs collapsed (never splits a surrogate pair). */
export function truncate(s, n = 120) {
  return Array.from(String(s ?? '').replace(/\s+/g, ' ')).slice(0, n).join('');
}

/** `text` parsed as JSON, or undefined when it is not one JSON document. */
export function parseJsonOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The answer of a call that failed before any tool result came back.
 *
 * @param {string} text  what went wrong
 * @returns {{isError: true, text: string, data: undefined, content: []}}
 */
export function failure(text) {
  return { isError: true, text, data: undefined, content: [] };
}

/** Whether `value` is a JSON object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The content blocks of a tool result (none when it has no array). */
function contentOf(result) {
  return Array.isArray(result.content) ? result.content : [];
}

/**
 * The JSON text blocks of `content` that ask for human approval
 * (`confirmationRequired: true`), parsed.
 */
function confirmationBlocks(content) {
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => parseJsonOrUndefined(block.text))
    .filter((parsed) => parsed?.confirmationRequired === true);
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
  if (!res) return failure('no answer from the daemon');

  const bodyText = res.body.toString('utf8');
  const excerpt = truncate(bodyText, BODY_EXCERPT_LENGTH);
  // JSON.parse never gives undefined, so undefined means "not JSON".
  const outer = parseJsonOrUndefined(bodyText);
  if (outer === undefined) return failure(`HTTP ${res.status}: not JSON: ${excerpt}`);

  const ok = res.status >= 200 && res.status < 300;
  const isObject = isPlainObject(outer);
  if (!ok || !isObject) {
    const why = isObject && typeof outer.error === 'string' ? outer.error : excerpt;
    return failure(`HTTP ${res.status}: ${why}`);
  }
  if (!isPlainObject(outer.result)) return failure(`HTTP ${res.status}: no result in ${excerpt}`);

  const interpreted = interpretToolResult(outer.result);
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
  const content = contentOf(result);
  const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');

  return { isError: Boolean(result.isError), text, data: parseJsonOrUndefined(text), content };
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
  return confirmationBlocks(contentOf(result)).length > 0;
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

  return confirmationBlocks(r.content)
    .map((details) => details.approval?.requestId)
    .find((id) => typeof id === 'string' && id !== '');
}
