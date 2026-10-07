/**
 * Contract: human approval of protected-site actions, across
 *   mcp-server  handlers.ts (confirmation_required → approval request,
 *               approvalToken → allowed_by_human + approvedHost),
 *               tools/approval-flow.ts (elicitation / popup answers → token),
 *               relay/approval.ts (ask, then retry once with the token),
 *               transport/http-bridge.ts (/approval/* routes, approvalToken)
 *   extension   approval.ts (popup view, command result, isApprovedHost),
 *               background.ts (wire envelope, scope sets, message guards),
 *               content.ts (no approval UI in the page)
 *
 * The browser is a fake connection that behaves like the Extension's
 * protected-domain check (protectedUrlPatterns + approvedHost) and answers
 * request_approval like the popup would.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalPromptSchema, parseBrowserResponse, type BrowserCommand } from '@kitsune-mcp/shared';
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
import { ACTION_TABLE } from '../../packages/extension/src/background/action-table.ts';
import { readExtensionSource, readExtensionTree } from './helpers/extension-source.js';

// ---------------------------------------------------------------------------
// Extension-side helpers (approval.ts publishes them on globalThis)
// ---------------------------------------------------------------------------

interface ApprovalView { id: string; kind: string; deadline: number; host?: string; toolName?: string; message?: string }
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

const PROTECTED_HOST = 'bank.example.test';
const PROTECTED_URL = `https://${PROTECTED_HOST}/transfer`;
const PLAIN_URL = 'https://plain.example.test/';

const browser = {
  tabUrl: PLAIN_URL,
  /** What the "human" answers in the popup. */
  popupDecision: 'approved' as 'approved' | 'denied' | 'timeout',
  received: [] as BrowserCommand[],
};

function extensionAnswer(command: BrowserCommand): Record<string, unknown> {
  if (command.action === 'request_approval') {
    const view = ext.parseApprovalPrompt(command.data, command.requestId, Date.now(), 60_000);
    if (!view) return { success: false, error: 'Malformed approval request' };
    return ext.approvalCommandResult(view, browser.popupDecision, Date.now());
  }
  // background.ts checkProtectedTarget: patterns against the real tab URL,
  // let through only on the approved host.
  const patterns = (command.protectedUrlPatterns ?? []).map((p) => new RegExp(p, 'i'));
  const matched = patterns.find((p) => p.test(browser.tabUrl));
  if (matched && !ext.isApprovedHost(browser.tabUrl, command.approvedHost)) {
    return {
      success: false,
      safetyDecision: 'confirmation_required',
      error: 'Protected domain: confirmation required',
      url: browser.tabUrl,
      matchedPattern: matched.source,
    };
  }
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
  await import('../../packages/extension/src/approval.ts');
  ext = (globalThis as { KITSUNE_APPROVAL?: ExtensionApproval }).KITSUNE_APPROVAL!;
  // The test feeds plain records (not CommandResult): typed by its own alias.
  toWireResponse = (await import('../../packages/extension/src/background/wire.ts')).toWireResponse as unknown as ToWireResponse;

  // The guard singleton reads this config (no audit log, no rate limit).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-approval-'));
  const configPath = path.join(tmpDir, 'safety.json');
  fs.writeFileSync(configPath, JSON.stringify({
    audit_log: false,
    max_actions_per_minute: 0,
    protected_url_patterns: ['bank\\.example\\.test'],
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

async function navigate(url: string): Promise<void> {
  // A plain page first: the guard tracks it via noteUrl.
  const result = await createToolHandler('fox_navigate')({ action: 'goto', url });
  expect(result.isError).toBeFalsy();
  browser.received = [];
}

// ---------------------------------------------------------------------------
// Server side: no approval → no browser command
// ---------------------------------------------------------------------------

describe('without approval, protected-site actions are refused', () => {
  it('fox_navigate to a protected URL: confirmation_required, nothing sent to the browser', async () => {
    const result = await createToolHandler('fox_navigate')({ action: 'goto', url: PROTECTED_URL });
    expect(result.isError).toBe(true);
    expect(browser.received).toEqual([]);
    const d = details(result);
    expect(d).toMatchObject({ decision: 'confirmation_required', confirmationRequired: true });
    expect(d['approval']).toMatchObject({ toolName: 'fox_navigate', host: PROTECTED_HOST, protectedUrl: PROTECTED_URL });
    // The LLM is told how approval works and how to retry.
    expect(text(result)).toContain('How approval works');
    expect(text(result)).toContain('call fox_navigate again with the same arguments');
    expect(text(result)).toContain('fox_click');
  });

  it('the Extension refuses an acting tool on a protected tab the server did not know about', async () => {
    await navigate(PLAIN_URL);
    browser.tabUrl = PROTECTED_URL; // the user switched the page behind the server's back
    const result = await createToolHandler('fox_click')({ selector: '#send' });
    expect(result.isError).toBe(true);
    expect(browser.received.map((c) => c.action)).toEqual(['click']);
    // Sent as the anchored regex equivalent of the host pattern (safety/url-pattern.ts).
    const sentPatterns = browser.received[0]!.protectedUrlPatterns!.map((p) => new RegExp(p, 'i'));
    expect(sentPatterns).toHaveLength(1);
    expect(sentPatterns[0]!.test(PROTECTED_URL)).toBe(true);
    expect(sentPatterns[0]!.test(`https://${PROTECTED_HOST}.other.test/`)).toBe(false);
    expect(browser.received[0]!.approvedHost).toBeUndefined();
    expect(details(result)['approval']).toMatchObject({ toolName: 'fox_click', host: PROTECTED_HOST });
  });

  it('a made-up or reused token does not help', async () => {
    const handler = createToolHandler('fox_navigate');
    const args = { action: 'goto', url: PROTECTED_URL };
    const fake = await handler(args, { approvalToken: 'kat_' + 'x'.repeat(43) });
    expect(fake.isError).toBe(true);
    expect(text(fake)).toContain('was not accepted');
    expect(browser.received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Popup approval (extension fallback)
// ---------------------------------------------------------------------------

describe('popup approval → one-time token', () => {
  it('request_approval carries the server-built prompt; the Extension answer round-trips', async () => {
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: PROTECTED_URL });
    const requestId = findApprovalRequest(first)!.requestId;

    const reply = await askBrowser(requestId, getConnectionManager());
    expect(reply).toMatchObject({ success: true, approved: true, reason: 'approved' });
    expect(reply.approvalToken).toMatch(/^kat_/);

    const sent = browser.received.find((c) => c.action === 'request_approval')!;
    expect(ApprovalPromptSchema.parse(sent.data)).toMatchObject({
      kind: 'protected_action',
      approvalId: requestId,
      toolName: 'fox_navigate',
      host: PROTECTED_HOST,
    });
    // request_approval needs no tab: no protected patterns / scope attached.
    expect(sent.protectedUrlPatterns).toBeUndefined();

    // The token runs exactly this call once.
    const handler = createToolHandler('fox_navigate');
    const args = { action: 'goto', url: PROTECTED_URL };
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
    await navigate(PLAIN_URL);
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: PROTECTED_URL });
    const reply = await askBrowser(findApprovalRequest(first)!.requestId, getConnectionManager());
    browser.received = [];
    const other = await createToolHandler('fox_navigate')(
      { action: 'goto', url: `${PROTECTED_URL}?amount=9999` },
      { approvalToken: reply.approvalToken },
    );
    expect(other.isError).toBe(true);
    expect(browser.received).toEqual([]);
  });

  it('denied or unanswered in the popup → no token, request closed', async () => {
    for (const decision of ['denied', 'timeout'] as const) {
      browser.popupDecision = decision;
      const first = await createToolHandler('fox_navigate')({ action: 'goto', url: PROTECTED_URL });
      const requestId = findApprovalRequest(first)!.requestId;
      const reply = await askBrowser(requestId, getConnectionManager());
      expect(reply).toMatchObject({ success: true, approved: false, reason: decision === 'denied' ? 'declined' : 'timeout' });
      expect(reply.approvalToken).toBeUndefined();
      expect(getApprovalStore().getRequest(requestId)).toBeUndefined();
    }
  });

  it('acting on the current protected tab: the approved host reaches the Extension', async () => {
    await navigate(PLAIN_URL);
    browser.tabUrl = PROTECTED_URL;
    const args = { selector: '#send' };
    const first = await createToolHandler('fox_click')(args);
    const reply = await askBrowser(findApprovalRequest(first)!.requestId, getConnectionManager());

    browser.received = [];
    const ok = await createToolHandler('fox_click')(args, { approvalToken: reply.approvalToken });
    expect(ok.isError).toBeFalsy();
    expect(browser.received).toHaveLength(1);
    expect(browser.received[0]).toMatchObject({ action: 'click', approvedHost: PROTECTED_HOST });
  });

  it('the approved host does not carry over to another protected host', async () => {
    await navigate(PLAIN_URL);
    browser.tabUrl = PROTECTED_URL;
    const args = { selector: '#send' };
    const first = await createToolHandler('fox_click')(args);
    const reply = await askBrowser(findApprovalRequest(first)!.requestId, getConnectionManager());

    browser.tabUrl = `https://other.${PROTECTED_HOST}/`; // still matches the pattern, other host
    const result = await createToolHandler('fox_click')(args, { approvalToken: reply.approvalToken });
    expect(result.isError).toBe(true);
    expect(details(result)).toMatchObject({ decision: 'confirmation_required' });
    // WP-G P-4: the token was valid, but lifted nothing here: say so.
    expect(text(result)).toContain('The approval token sent with this call was not accepted');
  });

  it('no Firefox connected → no_browser', async () => {
    const first = await createToolHandler('fox_navigate')({ action: 'goto', url: PROTECTED_URL });
    getConnectionManager().unregisterBrowser('fake-firefox');
    try {
      const reply = await askBrowser(findApprovalRequest(first)!.requestId, getConnectionManager());
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
  const args = { action: 'goto', url: PROTECTED_URL };
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
    ['fox_tab', { action: 'create', url: PROTECTED_URL, active: true }],
    ['fox_create_tab', { url: PROTECTED_URL, active: true }],
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
    const call = { name: 'fox_navigate', arguments: { action: 'goto', url: PROTECTED_URL } };
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
      { toolName: 'fox_click', host: PROTECTED_HOST, argsHash: 'h' },
      { protectedUrl: PROTECTED_URL, matchedPattern: 'bank', summary: 'selector: "#x"' },
    );
    const now = Date.now();
    const view = ext.parseApprovalPrompt(buildApprovalPrompt(request, now), '7', now, 60_000)!;
    expect(view).toMatchObject({ id: request.id, kind: 'protected_action', toolName: 'fox_click', host: PROTECTED_HOST });
    expect(view.deadline).toBeLessThanOrEqual(request.expiresAt);
  });

  it('refuses malformed or expired protected_action prompts; fox_request_approval is a plain question', () => {
    const now = Date.now();
    expect(ext.parseApprovalPrompt({ kind: 'protected_action', approvalId: 'a' }, '1', now, 60_000)).toBeNull();
    expect(ext.parseApprovalPrompt(
      { kind: 'protected_action', approvalId: 'a', toolName: 't', host: 'h', expiresAt: now - 1 }, '1', now, 60_000,
    )).toBeNull();
    const question = ext.parseApprovalPrompt({ message: 'Proceed?', timeout: 5_000 }, '9', now, 60_000)!;
    expect(question).toMatchObject({ id: 'msg-9', kind: 'message', message: 'Proceed?', deadline: now + 5_000 });
  });

  it('only an approved answer with the same approvalId counts on the server', () => {
    const view = { id: 'appr-1', kind: 'protected_action', deadline: 0 };
    const wire = (decision: string, id = view.id): ReturnType<typeof parseBrowserResponse> =>
      parseBrowserResponse(toWireResponse('5', ext.approvalCommandResult({ ...view, id }, decision, Date.now())));
    const ok = (r: ReturnType<typeof parseBrowserResponse>): boolean => r.ok && isBrowserApproval(r.response, 'appr-1');
    expect(ok(wire('approved'))).toBe(true);
    expect(ok(wire('denied'))).toBe(false);
    expect(ok(wire('timeout'))).toBe(false);
    expect(ok(wire('cancelled'))).toBe(false);
    expect(ok(wire('approved', 'appr-2'))).toBe(false);
    // fox_request_approval answers carry no approvalId: never a token.
    const question = parseBrowserResponse(toWireResponse('6', ext.approvalCommandResult(
      { id: 'msg-6', kind: 'message', deadline: 0 }, 'approved', Date.now())));
    expect(question.ok && isBrowserApproval(question.response, 'msg-6')).toBe(false);
  });

  it('isApprovedHost: exact hostname only', () => {
    expect(ext.isApprovedHost('https://Bank.Example.test/x', PROTECTED_HOST)).toBe(true);
    expect(ext.isApprovedHost('https://bank.example.test.evil.test/', PROTECTED_HOST)).toBe(false);
    expect(ext.isApprovedHost('https://sub.bank.example.test/', PROTECTED_HOST)).toBe(false);
    expect(ext.isApprovedHost('https://bank.example.test/', undefined)).toBe(false);
    expect(ext.isApprovedHost('https://bank.example.test/', '')).toBe(false);
    expect(ext.isApprovedHost('not a url', PROTECTED_HOST)).toBe(false);
  });
});

describe('extension: approval UI is outside the page', () => {
  const background = readExtensionTree('background');
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

  it('decisions are accepted only from the toolbar popup (extension page, not a tab)', () => {
    expect(background).toMatch(
      /msg\.type === APPROVAL_MESSAGE\.LIST \|\| msg\.type === APPROVAL_MESSAGE\.DECIDE\)[\s\S]{0,400}!isExtensionPage\(sender\) \|\| \(msg\.type === APPROVAL_MESSAGE\.DECIDE && sender\.tab\)/,
    );
    // The popup uses the shared constants, not its own literals.
    expect(popup).toContain('APPROVAL_MESSAGE.LIST');
    expect(popup).toContain('APPROVAL_MESSAGE.DECIDE');
    expect(popup).not.toContain('kitsune:approvals:');
  });

  it('approval.ts is bundled into background.js and popup.js (imported, not loaded separately)', () => {
    expect(background).toMatch(/^import \{[^}]*\bAPPROVAL_MESSAGE\b[^}]*\} from "\.\.?\/approval";$/m);
    expect(readExtensionSource('popup/popup.ts')).toMatch(/^import \{[^}]*\bAPPROVAL_MESSAGE\b[^}]*\} from '\.\.\/approval';$/m);
    const manifest = JSON.parse(readExtensionSource('../manifest.json')) as { background: { scripts: string[] } };
    expect(manifest.background.scripts).toEqual(['dist/background.js']);
    const html = readExtensionSource('popup/popup.html');
    expect([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])).toEqual(['popup.js']);
  });
});
