/**
 * Contract: human approval of tool calls (every acting tool, on every site), across
 *   mcp-server  handlers.ts (confirmation_required → approval request,
 *               approvalToken → allowed_by_human + approvedHost),
 *               tools/approval-flow.ts (elicitation / popup answers → token),
 *               relay/approval.ts (ask, then retry once with the token),
 *               transport/http-bridge.ts (/approval/* routes, approvalToken)
 *   extension   approval.ts (popup view, command result, isApprovedHost),
 *               background.ts (wire envelope, scope sets, message guards),
 *               content.ts (no approval UI in the page)
 *
 * The browser is a fake connection that behaves like the Extension's own
 * approval check (helpers/extension-approval.ts: an acting command runs only
 * on the site of its approvedHost) and answers request_approval like the
 * popup would.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalPromptSchema, parseBrowserResponse, type BrowserCommand } from '@inari-mcp/shared';
import { createToolHandler } from '../../packages/mcp-server/src/tools/handlers.js';
import {
  answerFromElicitation,
  askBrowser,
  buildApprovalPrompt,
  isBrowserApproval,
} from '../../packages/mcp-server/src/tools/approval-flow.js';
import { getConnectionManager } from '../../packages/mcp-server/src/connection/manager.js';
import { getApprovalStore } from '../../packages/mcp-server/src/safety/approval.js';
import { callWithApproval, findApprovalRequest } from '../../packages/mcp-server/src/relay/approval.js';
import { startHttpBridge } from '../../packages/mcp-server/src/transport/http-bridge.js';
import { getSafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { ACTION_TABLE } from '../../packages/extension/src/background/action-table.ts';
import { readExtensionSource, readExtensionTree } from './helpers/extension-source.js';
import { extensionApprovalRefusal } from './helpers/extension-approval.js';

// ---------------------------------------------------------------------------
// Extension-side helpers (approval.ts, imported as a module)
// ---------------------------------------------------------------------------

interface ApprovalView {
  id: string;
  kind: string;
  deadline: number;
  host?: string;
  url?: string;
  matchedPattern?: string;
  toolName?: string;
  message?: string;
}
interface ExtensionApproval {
  APPROVAL_MESSAGE: { LIST: string; DECIDE: string };
  parseApprovalPrompt(data: unknown, requestId: string, now: number, defaultTimeoutMs: number): ApprovalView | null;
  approvalCommandResult(view: ApprovalView, decision: string, now: number): Record<string, unknown>;
  isApprovedHost(tabUrl: string | undefined, approvedHost: unknown): boolean;
}
type ToWireResponse = (requestId: number | string, result: Record<string, unknown>) => Record<string, unknown>;

let ext: ExtensionApproval;
let toWireResponse: ToWireResponse;

// ---------------------------------------------------------------------------
// Fake Firefox
// ---------------------------------------------------------------------------

const SITE_HOST = 'bank.example.test';
const SITE_URL = `https://${SITE_HOST}/transfer`;
const PLAIN_URL = 'https://plain.example.test/';

const browser = {
  tabUrl: PLAIN_URL,
  /** What the "human" answers in the popup (`error`: the popup itself fails). */
  popupDecision: 'approved' as 'approved' | 'denied' | 'timeout' | 'cancelled' | 'error',
  received: [] as BrowserCommand[],
};

function extensionAnswer(command: BrowserCommand): Record<string, unknown> {
  if (command.action === 'request_approval') {
    const view = ext.parseApprovalPrompt(command.data, command.requestId, Date.now(), 60_000);
    if (!view) return { success: false, error: 'Malformed approval request' };
    if (browser.popupDecision === 'error') return { success: false, error: 'The popup could not be shown' };
    return ext.approvalCommandResult(view, browser.popupDecision, Date.now());
  }
  // The Extension's own check (background/url-policy.ts) against the real
  // tab URL: an acting command runs only on the approved site.
  const refusal = extensionApprovalRefusal(command, browser.tabUrl);
  if (refusal) return refusal;
  if (command.action === 'navigate' && typeof command.data?.['url'] === 'string') {
    browser.tabUrl = command.data['url'];
  }
  return { success: true, url: browser.tabUrl };
}

function connectFakeBrowser(): void {
  const cm = getConnectionManager();
  cm.registerBrowser('fake-firefox', (command) => {
    browser.received.push(command);
    const wire = toWireResponse(command.requestId, extensionAnswer(command));
    const parsed = parseBrowserResponse(wire);
    setTimeout(() => {
      if (parsed.ok) cm.handleResponse(parsed.response);
    }, 0);
  }, 'native-host');
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  ext = await import('../../packages/extension/src/approval.ts');
  // The test feeds plain records (not CommandResult): typed by its own alias.
  toWireResponse = (await import('../../packages/extension/src/background/wire.ts')).toWireResponse as unknown as ToWireResponse;

  // The guard singleton reads this config (no audit log, no rate limit).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-approval-'));
  const configPath = path.join(tmpDir, 'safety.json');
  fs.writeFileSync(configPath, JSON.stringify({
    audit_log: false,
    max_actions_per_minute: 0,
  }));
  process.env['FOX_SAFETY_CONFIG'] = configPath;
  connectFakeBrowser();
});

afterAll(() => {
  getConnectionManager().unregisterBrowser('fake-firefox');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  browser.received = [];
  browser.popupDecision = 'approved';
});

function details(result: CallToolResult): Record<string, unknown> {
  const block = result.content[1];
  if (!block || block.type !== 'text') throw new Error('no details block');
  return JSON.parse(block.text) as Record<string, unknown>;
}

function text(result: CallToolResult): string {
  return result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** The human's answer in the popup to the approval request `refused` opened. */
function askPopup(refused: CallToolResult): ReturnType<typeof askBrowser> {
  return askBrowser(findApprovalRequest(refused)!.requestId, getConnectionManager());
}

/** The tab shows `url`, and the guard learns it from a read (which needs no approval). */
async function showPage(url: string): Promise<void> {
  browser.tabUrl = url;
  const result = await createToolHandler('fox_get_text')({});
  expect(result.isError).toBeFalsy();
  expect(getSafetyGuard().urlFor()).toBe(url);
  browser.received = [];
}

// ---------------------------------------------------------------------------
// Server side: no approval → no browser command
// ---------------------------------------------------------------------------

describe('without approval, acting tools are refused', () => {
  it('fox_navigate: confirmation_required, nothing sent to the browser', async () => {
    const result = await createToolHandler('fox_navigate')({ action: 'goto', url: SITE_URL });
    expect(result.isError).toBe(true);
    expect(browser.received).toEqual([]);
    const d = details(result);
    expect(d).toMatchObject({ decision: 'confirmation_required', confirmationRequired: true });
    expect(d['approval']).toMatchObject({ toolName: 'fox_navigate', host: SITE_HOST, url: SITE_URL, matchedPattern: null });
    // The LLM is told how approval works and how to retry.
    expect(text(result)).toContain('How approval works');
    expect(text(result)).toContain('call fox_navigate again with the same arguments');
    expect(text(result)).toContain('fox_click');
  });

  it('the Extension refuses an acting tool approved for another site than its tab is on', async () => {
    await showPage(PLAIN_URL);
    browser.tabUrl = SITE_URL; // the user switched the page behind the server's back
    const args = { selector: '#send' };
    const first = await createToolHandler('fox_click')(args);
    expect(browser.received).toEqual([]);
    expect(details(first)['approval']).toMatchObject({ host: 'plain.example.test' });
    const { approvalToken } = answerFromElicitation(findApprovalRequest(first)!.requestId, true);

    const result = await createToolHandler('fox_click')(args, { approvalToken });
    expect(result.isError).toBe(true);
    expect(browser.received).toEqual([expect.objectContaining({ action: 'click', approvedHost: 'plain.example.test' })]);
    // A new request, for the site the browser reports.
    expect(details(result)['approval']).toMatchObject({ toolName: 'fox_click', host: SITE_HOST, url: SITE_URL });
  });

  it('a tab the server has not seen: not sent, and the LLM is told to list the tabs first', async () => {
    const result = await createToolHandler('fox_click')({ tabId: 99, selector: '#send' });
    expect(result.isError).toBe(true);
    expect(browser.received).toEqual([]);
    expect(details(result)['approval']).toBeUndefined();
    expect(text(result)).toContain('This call cannot be approved yet');
  });

  it('a made-up or reused token does not help', async () => {
    const handler = createToolHandler('fox_navigate');
    const args = { action: 'goto', url: SITE_URL };
    const fake = await handler(args, { approvalToken: 'kat_' + 'x'.repeat(43) });
    expect(fake.isError).toBe(true);
    expect(text(fake)).toContain('was not accepted');
    expect(browser.received).toEqual([]);
  });

  // A-KM-01: the human would approve arguments they were not shown in full.
  // D-KM-01 / D-KM-05: a URL cannot be split, so the LLM is told how the length is counted and
  // that such a value cannot be approved, not only to shorten it.
  it('arguments too long to show in full: no approval request, the LLM is told the length cannot be approved', async () => {
    const before = getApprovalStore().pendingCount;
    const url = `${SITE_URL}?note=${'x'.repeat(200)}`;
    const result = await createToolHandler('fox_navigate')({ action: 'goto', url });
    expect(result.isError).toBe(true);
    expect(browser.received).toEqual([]);
    const d = details(result);
    expect(d).toMatchObject({ decision: 'confirmation_required' });
    expect(d['approval']).toBeUndefined();
    expect(getApprovalStore().pendingCount).toBe(before);
    expect(text(result)).toContain('This call cannot be approved: its arguments are too long');
    expect(text(result)).toContain('too long to show the human in full');
    expect(text(result)).toContain('UTF-16 code units of the value as JSON');
    expect(text(result)).toContain('a value that cannot be split, such as a long URL, cannot be approved');
    expect(text(result)).not.toContain('Shorten the arguments');
  });
});

// ---------------------------------------------------------------------------
// Popup approval (extension fallback)
// ---------------------------------------------------------------------------

describe('popup approval → one-time token', () => {
  it('request_approval carries the server-built prompt; the Extension answer round-trips', async () => {
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: SITE_URL });
    const requestId = findApprovalRequest(first)!.requestId;

    const reply = await askBrowser(requestId, getConnectionManager());
    expect(reply).toMatchObject({ success: true, approved: true, reason: 'approved' });
    expect(reply.approvalToken).toMatch(/^kat_/);

    const sent = browser.received.find((c) => c.action === 'request_approval')!;
    expect(ApprovalPromptSchema.parse(sent.data)).toMatchObject({
      kind: 'tool_call',
      approvalId: requestId,
      toolName: 'fox_navigate',
      host: SITE_HOST,
      url: SITE_URL,
      matchedPattern: null,
    });
    // request_approval needs no tab: no URL rules, scope or approval attached.
    expect(sent.confirmReadUrlRules).toBeUndefined();
    expect(sent.approvedHost).toBeUndefined();

    // The token runs exactly this call once.
    const handler = createToolHandler('fox_navigate');
    const args = { action: 'goto', url: SITE_URL };
    const ok = await handler(args, { approvalToken: reply.approvalToken });
    expect(ok.isError).toBeFalsy();
    expect(browser.received.map((c) => c.action)).toContain('navigate');

    browser.received = [];
    const again = await handler(args, { approvalToken: reply.approvalToken });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain('was not accepted');
    expect(browser.received).toEqual([]);
  });

  it('a token is bound to the arguments', async () => {
    await showPage(PLAIN_URL);
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: SITE_URL });
    const reply = await askPopup(first);
    browser.received = [];
    const other = await createToolHandler('fox_navigate')(
      { action: 'goto', url: `${SITE_URL}?amount=9999` },
      { approvalToken: reply.approvalToken },
    );
    expect(other.isError).toBe(true);
    expect(browser.received).toEqual([]);
  });

  it.each([
    ['denied', 'declined'],
    ['timeout', 'timeout'],
    ['cancelled', 'cancelled'],
  ] as const)('%s in the popup → reason %s, no token, request closed', async (decision, reason) => {
    browser.popupDecision = decision;
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: SITE_URL });
    const requestId = findApprovalRequest(first)!.requestId;
    const reply = await askBrowser(requestId, getConnectionManager());
    expect(reply).toMatchObject({ success: true, approved: false, reason });
    expect(reply.approvalToken).toBeUndefined();
    expect(getApprovalStore().getRequest(requestId)).toBeUndefined();
  });

  // G-21 (c): the popup itself failed: nobody answered, so the request stays open.
  it('a failed popup → browser_error, no token, request still open', async () => {
    browser.popupDecision = 'error';
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: SITE_URL });
    const requestId = findApprovalRequest(first)!.requestId;
    const reply = await askBrowser(requestId, getConnectionManager());
    expect(reply).toMatchObject({
      success: false, approved: false, reason: 'browser_error', error: 'The popup could not be shown',
    });
    expect(reply.approvalToken).toBeUndefined();
    expect(getApprovalStore().getRequest(requestId)).toBeDefined();
  });

  it('acting on the current tab: the approved site reaches the Extension', async () => {
    await showPage(SITE_URL);
    const args = { selector: '#send' };
    const first = await createToolHandler('fox_click')(args);
    const reply = await askPopup(first);

    browser.received = [];
    const ok = await createToolHandler('fox_click')(args, { approvalToken: reply.approvalToken });
    expect(ok.isError).toBeFalsy();
    expect(browser.received).toHaveLength(1);
    expect(browser.received[0]).toMatchObject({ action: 'click', approvedHost: SITE_HOST });
  });

  it('a local page is approved by its scheme', async () => {
    await showPage('file:///tmp/inari-test/form.html');
    const args = { selector: '#send' };
    const first = await createToolHandler('fox_click')(args);
    expect(findApprovalRequest(first)).toMatchObject({ host: 'file:', url: 'file:///tmp/inari-test/form.html' });
    const reply = await askPopup(first);
    browser.received = [];
    const ok = await createToolHandler('fox_click')(args, { approvalToken: reply.approvalToken });
    expect(ok.isError).toBeFalsy();
    expect(browser.received[0]).toMatchObject({ action: 'click', approvedHost: 'file:' });
  });

  it('every acting call is asked about again: one approval runs one call', async () => {
    await showPage(SITE_URL);
    const args = { selector: '#send' };
    const reply = await askPopup(await createToolHandler('fox_click')(args));
    expect((await createToolHandler('fox_click')(args, { approvalToken: reply.approvalToken })).isError).toBeFalsy();
    browser.received = [];
    const next = await createToolHandler('fox_click')(args);
    expect(next.isError).toBe(true);
    expect(findApprovalRequest(next)).toMatchObject({ toolName: 'fox_click', host: SITE_HOST });
    expect(browser.received).toEqual([]);
  });

  it('the approved site does not carry over to another host', async () => {
    await showPage(SITE_URL);
    const args = { selector: '#send' };
    const first = await createToolHandler('fox_click')(args);
    const reply = await askPopup(first);

    browser.tabUrl = `https://other.${SITE_HOST}/`; // a subdomain: another site
    const result = await createToolHandler('fox_click')(args, { approvalToken: reply.approvalToken });
    expect(result.isError).toBe(true);
    expect(details(result)).toMatchObject({ decision: 'confirmation_required' });
    // WP-G P-4: the token was valid, but lifted nothing here: say so.
    expect(text(result)).toContain('The approval token sent with this call was not accepted');
  });

  it('no Firefox connected → no_browser', async () => {
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: SITE_URL });
    getConnectionManager().unregisterBrowser('fake-firefox');
    try {
      const reply = await askPopup(first);
      expect(reply).toMatchObject({ success: false, approved: false, reason: 'no_browser' });
    } finally {
      connectFakeBrowser();
    }
  });
});

// ---------------------------------------------------------------------------
// Relay orchestration against the real daemon-side handlers
// ---------------------------------------------------------------------------

describe('relay: ask, then retry once with the token', () => {
  const handler = createToolHandler('fox_navigate');
  const args = { action: 'goto', url: SITE_URL };
  const call = (approvalToken?: string): Promise<CallToolResult> => handler(args, { approvalToken });

  it('elicitation approved → the call runs', async () => {
    const result = await callWithApproval(call, {
      canElicit: true,
      elicit: async () => ({ action: 'accept', content: { approve: true } }),
      reportElicitation: async (id, approved) => answerFromElicitation(id, approved),
      askBrowser: async (id) => askBrowser(id, getConnectionManager()),
    });
    expect(result.isError).toBeFalsy();
    expect(browser.received.map((c) => c.action)).toEqual(['navigate']);
  });

  it('no elicitation support → popup → the call runs', async () => {
    const result = await callWithApproval(call, {
      canElicit: false,
      elicit: async () => { throw new Error('not called'); },
      reportElicitation: async (id, approved) => answerFromElicitation(id, approved),
      askBrowser: async (id) => askBrowser(id, getConnectionManager()),
    });
    expect(result.isError).toBeFalsy();
    expect(browser.received.map((c) => c.action)).toEqual(['request_approval', 'navigate']);
  });

  it('elicitation declined → refused, nothing sent', async () => {
    const result = await callWithApproval(call, {
      canElicit: true,
      elicit: async () => ({ action: 'decline' }),
      reportElicitation: async (id, approved) => answerFromElicitation(id, approved),
      askBrowser: async (id) => askBrowser(id, getConnectionManager()),
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('declined');
    expect(browser.received).toEqual([]);
  });

  it.each([
    ['fox_tab', { action: 'create', url: SITE_URL, active: true }],
    ['fox_create_tab', { url: SITE_URL, active: true }],
  ])('a grouped public tool and its deprecated name (%s): refused, approved, run once', async (tool, toolArgs) => {
    const run = createToolHandler(tool);
    const asked: string[] = [];
    const result = await callWithApproval((approvalToken) => run(toolArgs, { approvalToken }), {
      canElicit: true,
      elicit: async (params) => {
        asked.push(JSON.stringify(params));
        return { action: 'accept', content: { approve: true } };
      },
      reportElicitation: async (id, approved) => answerFromElicitation(id, approved),
      askBrowser: async (id) => askBrowser(id, getConnectionManager()),
    });
    expect(result.isError).toBeFalsy();
    expect(browser.received.map((c) => c.action)).toEqual(['create_tab']);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(tool);
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

describe('daemon HTTP routes', () => {
  let server: http.Server;
  let base: string;
  const apiToken = 'test-token';

  beforeAll(async () => {
    server = await startHttpBridge({
      host: '127.0.0.1',
      port: 0,
      apiToken,
      connectionManager: getConnectionManager(),
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = async (p: string, body: unknown, key = apiToken): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('approval routes need the API key and a requestId', async () => {
    expect((await post('/approval/browser', { requestId: 'x' }, 'wrong')).status).toBe(403);
    expect((await post('/approval/elicitation', { approved: true })).status).toBe(400);
    expect((await post('/approval/elicitation', { requestId: 'x' })).status).toBe(400);
    expect((await post('/approval/elicitation', { requestId: 'nope', approved: true })).body)
      .toMatchObject({ success: false, reason: 'unknown_request' });
  });

  it('/mcp/call → /approval/browser → /mcp/call with approvalToken', async () => {
    const call = { name: 'fox_navigate', arguments: { action: 'goto', url: SITE_URL } };
    const first = await post('/mcp/call', call);
    expect(first.body['success']).toBe(false);
    const info = findApprovalRequest(first.body['result'] as CallToolResult)!;

    const approval = await post('/approval/browser', { requestId: info.requestId });
    expect(approval.body).toMatchObject({ success: true, approved: true });

    browser.received = [];
    // approvalToken inside `arguments` is not a tool argument: stripped, no effect.
    const inArgs = await post('/mcp/call', { ...call, arguments: { ...call.arguments, approvalToken: approval.body['approvalToken'] } });
    expect(inArgs.body['success']).toBe(false);
    expect(browser.received).toEqual([]);

    const second = await post('/mcp/call', { ...call, approvalToken: approval.body['approvalToken'] });
    expect(second.body['success']).toBe(true);
    expect(browser.received.map((c) => c.action)).toEqual(['navigate']);
  });
});

// ---------------------------------------------------------------------------
// Extension sources
// ---------------------------------------------------------------------------

describe('extension: approval request handling', () => {
  const store = getApprovalStore();

  it('parses the server prompt into a popup view (deadline within the request lifetime)', () => {
    const request = store.createRequest(
      { toolName: 'fox_click', host: SITE_HOST, argsHash: 'h' },
      { url: SITE_URL, matchedPattern: null, summary: 'selector: "#x"' },
    );
    const now = Date.now();
    const view = ext.parseApprovalPrompt(buildApprovalPrompt(request, now), '7', now, 60_000)!;
    expect(view).toMatchObject({ id: request.id, kind: 'tool_call', toolName: 'fox_click', host: SITE_HOST, url: SITE_URL });
    expect(view.matchedPattern).toBeUndefined();
    expect(view.deadline).toBeLessThanOrEqual(request.expiresAt);
  });

  it.each([
    ['without its fields', (): Record<string, unknown> => ({ kind: 'tool_call', approvalId: 'a' })],
    ['expired', (now: number): Record<string, unknown> => ({ kind: 'tool_call', approvalId: 'a', toolName: 't', host: 'h', expiresAt: now - 1 })],
  ])('refuses a tool_call prompt %s', (_label, prompt) => {
    const now = Date.now();
    expect(ext.parseApprovalPrompt(prompt(now), '1', now, 60_000)).toBeNull();
  });

  it('reads a fox_request_approval prompt as a plain question', () => {
    const now = Date.now();
    const question = ext.parseApprovalPrompt({ message: 'Proceed?', timeout: 5_000 }, '9', now, 60_000)!;
    expect(question).toMatchObject({ id: 'msg-9', kind: 'message', message: 'Proceed?', deadline: now + 5_000 });
  });

  describe('which popup answers count as an approval on the server', () => {
    const view = { id: 'appr-1', kind: 'tool_call', deadline: 0 };
    const wire = (decision: string, id = view.id): ReturnType<typeof parseBrowserResponse> =>
      parseBrowserResponse(toWireResponse('5', ext.approvalCommandResult({ ...view, id }, decision, Date.now())));
    const counts = (r: ReturnType<typeof parseBrowserResponse>): boolean => r.ok && isBrowserApproval(r.response, 'appr-1');

    it('an approved answer with the same approvalId counts', () => {
      expect(counts(wire('approved'))).toBe(true);
    });

    it.each(['denied', 'timeout', 'cancelled'])('a %s answer does not count', (decision) => {
      expect(counts(wire(decision))).toBe(false);
    });

    it('an approved answer for another approvalId does not count', () => {
      expect(counts(wire('approved', 'appr-2'))).toBe(false);
    });

    it('a fox_request_approval answer carries no approvalId and never counts', () => {
      const question = parseBrowserResponse(toWireResponse('6', ext.approvalCommandResult(
        { id: 'msg-6', kind: 'message', deadline: 0 }, 'approved', Date.now())));
      expect(question.ok && isBrowserApproval(question.response, 'msg-6')).toBe(false);
    });
  });

  it.each([
    ['https://Bank.Example.test/x', SITE_HOST, true],
    ['https://bank.example.test.evil.test/', SITE_HOST, false],
    ['https://sub.bank.example.test/', SITE_HOST, false],
    ['https://bank.example.test/', undefined, false],
    ['https://bank.example.test/', '', false],
    ['not a url', SITE_HOST, false],
    ['file:///tmp/a.html', 'file:', true],
    ['about:blank', 'about:', true],
    ['file:///tmp/a.html', SITE_HOST, false],
    ['https://bank.example.test/', 'https:', false],
  ])('isApprovedHost(%j, %j) is %s: exact hostname only, or the scheme of a URL without one', (tabUrl, approvedHost, expected) => {
    expect(ext.isApprovedHost(tabUrl, approvedHost)).toBe(expected);
  });
});

describe('extension: approval UI is outside the page', () => {
  const content = readExtensionTree('content');
  const popup = readExtensionSource('popup/popup.ts');

  it('content.ts has no approval banner or handler', () => {
    expect(content).not.toMatch(/__fox_approval_banner/);
    expect(content).not.toMatch(/case "requestApproval"/);
  });

  it('request_approval and cancel_human_wait need no tab (container scope, A7)', () => {
    const names = [...ACTION_TABLE].filter(([, d]) => d.scope === 'noTab').map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining(['status', 'requestApproval', 'cancelHumanWait']));
  });

  // Who may list or decide approvals is checked on the listeners themselves
  // (extension-background.test.ts, 'E-4 runtime.onMessage sender checks').
  it('the popup uses the shared message types, not its own literals', () => {
    expect(popup).toContain('APPROVAL_MESSAGE.LIST');
    expect(popup).toContain('APPROVAL_MESSAGE.DECIDE');
    expect(popup).not.toContain('inari:approvals:');
  });

  it('popup.html loads only the popup bundle', () => {
    // approval.ts is not loaded on its own: background.js and popup.js
    // bundle it through their imports (scripts/build-extension.mjs).
    // manifest.json loads one background bundle: extension-background.test.ts.
    const html = readExtensionSource('popup/popup.html');
    expect([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])).toEqual(['popup.js']);
  });
});
