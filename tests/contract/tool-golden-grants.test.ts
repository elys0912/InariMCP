/**
 * Golden: the BrowserCommand of a call retried with a human-approval token
 * (safety/approval.ts), next to tool-golden.test.ts.
 *
 * Regenerate (only when a change of the recorded behaviour is intended):
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tool-golden-grants.test.ts
 *
 * tests/golden/tool-commands-grants.json, one entry per case:
 *   - approvals: the sites the human was asked about, in order
 *   - refusedByBrowser: actions the browser refused (the Extension's own
 *     check of the real tab, helpers/extension-approval.ts)
 *   - command: the BrowserCommand of the approved call that ran (requestId
 *     dropped)
 *
 * Situations: an acting tool on a tab the server knows (`known`), on a tab
 * that moved to another site without the server seeing it (`stale`: asked
 * for the old site, refused by the browser, asked again for the real one),
 * a call that goes to or opens a URL (`target`), and a read of a
 * confirm_read_sites site the server knows (`read`) or only the browser
 * knows (`readBrowser`). Public tool calls must give the same command as the
 * operation they run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserCommand } from '@inari-mcp/shared';
import { createToolHandler } from '../../packages/mcp-server/src/tools/handlers.js';
import { callSchemaFor } from '../../packages/mcp-server/src/tools/operations.js';
import { getConnectionManager } from '../../packages/mcp-server/src/connection/manager.js';
import { getSafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { answerFromElicitation } from '../../packages/mcp-server/src/tools/approval-flow.js';
import { findApprovalRequest } from '../../packages/mcp-server/src/relay/approval.js';
import { extensionApprovalRefusal } from './helpers/extension-approval.js';

const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const GOLDEN = fileURLToPath(new URL('../golden/tool-commands-grants.json', import.meta.url));

const SITE_HOST = 'bank.example.test';
const SITE_URL = `https://${SITE_HOST}/transfer`;
const PLAIN_URL = 'https://plain.example.test/';

type Situation = 'known' | 'stale' | 'target' | 'read' | 'readBrowser';
type Case = [id: string, situation: Situation, tool: string, args: Record<string, unknown>];

const CASES: Case[] = [
  ['known/click', 'known', 'fox_click', { selector: '#send' }],
  ['known/type', 'known', 'fox_type', { text: 'abc', selector: '#q' }],
  ['known/press_key', 'known', 'fox_press_key', { key: 'Enter' }],
  ['known/set_value', 'known', 'fox_set_value', { selector: '#v', value: '1' }],
  ['known/select_option', 'known', 'fox_select_option', { selector: 'select', value: 'a' }],
  ['known/handle_dialog', 'known', 'fox_handle_dialog', { action: 'accept' }],
  ['known/back', 'known', 'fox_navigate', { action: 'back' }],
  ['known/close_tab', 'known', 'fox_close_tab', { tabId: 1 }],
  ['known/public_select', 'known', 'fox_set_value', { kind: 'select', selector: 'select', option: { value: 'a' } }],
  ['stale/click', 'stale', 'fox_click', { selector: '#send' }],
  ['stale/select_option', 'stale', 'fox_select_option', { selector: 'select', value: 'a' }],
  ['stale/public_select', 'stale', 'fox_set_value', { kind: 'select', selector: 'select', option: { value: 'a' } }],
  ['target/navigate', 'target', 'fox_navigate', { url: SITE_URL }],
  ['target/create_tab', 'target', 'fox_create_tab', { url: SITE_URL }],
  ['target/create_blank_tab', 'target', 'fox_create_tab', {}],
  ['target/open_in_container', 'target', 'fox_open_in_container', { url: SITE_URL, containerName: 'Work' }],
  ['target/public_create', 'target', 'fox_tab', { action: 'create', url: SITE_URL }],
  ['target/public_container', 'target', 'fox_tab', { action: 'create', url: SITE_URL, container: { name: 'Work' } }],
  ['read/screenshot', 'read', 'fox_screenshot', {}],
  ['read/get_text', 'read', 'fox_get_text', {}],
  ['read/public_read', 'read', 'fox_read', { mode: 'text' }],
  ['readBrowser/screenshot', 'readBrowser', 'fox_screenshot', {}],
  ['readBrowser/public_read', 'readBrowser', 'fox_read', { mode: 'text' }],
];

/** Public-tool cases and the operation case whose command they must repeat. */
const SAME_COMMAND: Record<string, string> = {
  'known/public_select': 'known/select_option',
  'stale/public_select': 'stale/select_option',
  'target/public_create': 'target/create_tab',
  'target/public_container': 'target/open_in_container',
  'read/public_read': 'read/get_text',
};

// ---------------------------------------------------------------------------
// Fake Firefox: the Extension's own approval check on one tab (id 1) whose
// URL the test sets.
// ---------------------------------------------------------------------------

const browser = { tabUrl: PLAIN_URL, sent: [] as BrowserCommand[] };

function answer(command: BrowserCommand): Record<string, unknown> {
  const refusal = extensionApprovalRefusal(command, browser.tabUrl);
  if (refusal) {
    // The wire form: everything but success / safetyDecision / error goes in `data`.
    const { success, safetyDecision, error, ...data } = refusal;
    return { success, safetyDecision, error, data };
  }
  return { success: true, data: {} };
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-golden-grants-'));
  const configPath = path.join(tmpDir, 'safety.json');
  fs.writeFileSync(configPath, JSON.stringify({
    audit_log: false,
    max_actions_per_minute: 0,
    confirm_read_sites: [SITE_HOST],
  }));
  process.env['FOX_SAFETY_CONFIG'] = configPath;

  const cm = getConnectionManager();
  cm.registerBrowser('golden-grants', (command) => {
    browser.sent.push(command);
    const a = answer(command);
    setTimeout(() => cm.handleResponse({ requestId: command.requestId, ...a } as never), 0);
  }, 'native-host');
});

afterAll(() => {
  getConnectionManager().unregisterBrowser('golden-grants');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

interface GrantEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  approvals: string[];
  refusedByBrowser: string[];
  command: Omit<BrowserCommand, 'requestId'>;
}

/** What the server last saw on the active tab (id 1), and where the tab really is. */
const PAGES: Readonly<Record<Situation, { known: string; real: string }>> = {
  known: { known: SITE_URL, real: SITE_URL },
  stale: { known: PLAIN_URL, real: SITE_URL },
  target: { known: PLAIN_URL, real: PLAIN_URL },
  read: { known: SITE_URL, real: SITE_URL },
  readBrowser: { known: PLAIN_URL, real: SITE_URL },
};

function setSituation(situation: Situation): void {
  getSafetyGuard().noteUrl({ tabs: [{ id: 1, url: PAGES[situation].known, active: true }] }, {}, 'fox_get_tabs');
  browser.tabUrl = PAGES[situation].real;
  browser.sent = [];
}

/** At most this many approvals per call (stale: the old site, then the real one). */
const MAX_APPROVALS = 2;

async function record(): Promise<GrantEntry[]> {
  const entries: GrantEntry[] = [];
  for (const [id, situation, tool, raw] of CASES) {
    const args = callSchemaFor(tool)!.parse(raw) as Record<string, unknown>;
    const handler = createToolHandler(tool);
    setSituation(situation);

    const approvals: string[] = [];
    const refusedByBrowser: string[] = [];
    let result: CallToolResult = await handler(args);
    for (let request = findApprovalRequest(result); request !== null; request = findApprovalRequest(result)) {
      if (approvals.length === MAX_APPROVALS) throw new Error(`${id}: asked more than ${MAX_APPROVALS} times`);
      approvals.push(request.host);
      refusedByBrowser.push(...browser.sent.map((c) => c.action));
      const reply = answerFromElicitation(request.requestId, true);
      if (!reply.approved || reply.approvalToken === undefined) throw new Error(`${id}: not approved`);
      browser.sent = [];
      result = await handler(args, { approvalToken: reply.approvalToken });
    }
    if (result.isError) throw new Error(`${id}: failed: ${JSON.stringify(result.content)}`);
    if (browser.sent.length !== 1) throw new Error(`${id}: ${browser.sent.length} commands on the approved call`);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to leave requestId out of the entry
    const { requestId: _requestId, ...command } = browser.sent[0]!;
    entries.push(JSON.parse(JSON.stringify({ id, tool, args: raw, approvals, refusedByBrowser, command })) as GrantEntry);
  }
  return entries;
}

describe('approved retries (tests/golden/tool-commands-grants.json)', () => {
  let actual: GrantEntry[];
  beforeAll(async () => { actual = await record(); });

  it('match the golden file', () => {
    if (UPDATE) fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf-8')) as GrantEntry[];
    expect(actual.map((e) => e.id)).toEqual(golden.map((e) => e.id));
    for (let i = 0; i < actual.length; i++) expect(actual[i], actual[i]!.id).toEqual(golden[i]);
  });

  it('the human is asked for the site the call acts on, and the command carries it', () => {
    for (const e of actual) {
      const expected = e.id === 'target/create_blank_tab' ? 'about:' : SITE_HOST;
      expect(e.approvals.at(-1), e.id).toBe(expected);
      expect(e.command.approvedHost, e.id).toBe(expected);
    }
  });

  it('only a stale or browser-only situation is refused by the browser first', () => {
    for (const e of actual) {
      const situation = e.id.split('/')[0];
      expect(e.refusedByBrowser, e.id).toEqual(
        situation === 'stale' || situation === 'readBrowser' ? [e.command.action] : [],
      );
      expect(e.approvals, e.id).toHaveLength(situation === 'stale' ? 2 : 1);
    }
  });

  it('a public tool call gives the command of the operation it runs', () => {
    const byId = new Map(actual.map((e) => [e.id, e]));
    for (const [publicId, opId] of Object.entries(SAME_COMMAND)) {
      expect(byId.get(publicId)!.command, publicId).toEqual(byId.get(opId)!.command);
    }
  });
});
