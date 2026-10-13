/**
 * Golden: the BrowserCommand of a call retried with a human-approval token
 * (protected sites, safety/approval.ts), next to tool-golden.test.ts.
 *
 * Regenerate (only when a change of the recorded behaviour is intended):
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tool-golden-grants.test.ts
 *
 * tests/golden/tool-commands-grants.json, one entry per case:
 *   - refusedFirst: actions the browser refused before the approval (the
 *     Extension-side check of a tab the server did not know as protected)
 *   - approval: the tool name and host of the approval request
 *   - command: the BrowserCommand of the approved retry (requestId dropped)
 *
 * Three situations: the server knows the target tab is protected (guard
 * Layer 7 / Layer 4 screenshot), only the browser knows it (Extension
 * refusal), and the call targets a protected URL (`url` argument). Public
 * tool calls must give the same command as the operation they run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserCommand } from '@kitsune-mcp/shared';
import { createToolHandler } from '../../packages/mcp-server/src/tools/handlers.js';
import { callSchemaFor } from '../../packages/mcp-server/src/tools/operations.js';
import { getConnectionManager } from '../../packages/mcp-server/src/connection/manager.js';
import { getSafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { answerFromElicitation } from '../../packages/mcp-server/src/tools/approval-flow.js';
import { findApprovalRequest } from '../../packages/mcp-server/src/relay/approval.js';
import { checkProtectedTarget } from '../../packages/extension/src/background/url-policy.ts';
import { compileUrlRules } from '../../packages/extension/src/url-rule.ts';

const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const GOLDEN = fileURLToPath(new URL('../golden/tool-commands-grants.json', import.meta.url));

const PROTECTED_HOST = 'bank.example.test';
const PROTECTED_URL = `https://${PROTECTED_HOST}/transfer`;
const PLAIN_URL = 'https://plain.example.test/';

type Situation = 'known' | 'browser' | 'target';
type Case = [id: string, situation: Situation, tool: string, args: Record<string, unknown>];

const CASES: Case[] = [
  ['known/click', 'known', 'fox_click', { selector: '#send' }],
  ['known/type', 'known', 'fox_type', { text: 'abc', selector: '#q' }],
  ['known/press_key', 'known', 'fox_press_key', { key: 'Enter' }],
  ['known/set_value', 'known', 'fox_set_value', { selector: '#v', value: '1' }],
  ['known/select_option', 'known', 'fox_select_option', { selector: 'select', value: 'a' }],
  ['known/execute_script', 'known', 'fox_execute_script', { script: '1' }],
  ['known/inject_observer', 'known', 'fox_inject_observer', {}],
  ['known/handle_dialog', 'known', 'fox_handle_dialog', { action: 'accept' }],
  ['known/screenshot', 'known', 'fox_screenshot', {}],
  ['known/public_select', 'known', 'fox_set_value', { kind: 'select', selector: 'select', option: { value: 'a' } }],
  ['known/public_script', 'known', 'fox_evaluate', { mode: 'script', script: '1' }],
  ['known/public_observer', 'known', 'fox_observer', { action: 'inject' }],
  ['browser/click', 'browser', 'fox_click', { selector: '#send' }],
  ['browser/execute_script', 'browser', 'fox_execute_script', { script: '1' }],
  ['browser/public_script', 'browser', 'fox_evaluate', { mode: 'script', script: '1' }],
  ['target/navigate', 'target', 'fox_navigate', { url: PROTECTED_URL }],
  ['target/create_tab', 'target', 'fox_create_tab', { url: PROTECTED_URL }],
  ['target/open_in_container', 'target', 'fox_open_in_container', { url: PROTECTED_URL, containerName: 'Work' }],
  ['target/public_create', 'target', 'fox_tab', { action: 'create', url: PROTECTED_URL }],
  ['target/public_container', 'target', 'fox_tab', { action: 'create', url: PROTECTED_URL, container: { name: 'Work' } }],
];

/** Public-tool cases and the operation case whose command they must repeat. */
const SAME_COMMAND: Record<string, string> = {
  'known/public_select': 'known/select_option',
  'known/public_script': 'known/execute_script',
  'known/public_observer': 'known/inject_observer',
  'browser/public_script': 'browser/execute_script',
  'target/public_create': 'target/create_tab',
  'target/public_container': 'target/open_in_container',
};

// ---------------------------------------------------------------------------
// Fake Firefox: the Extension's own protected-tab check (checkProtectedTarget
// with protectedUrlRules and approvedHost) on one tab whose URL the test sets.
// ---------------------------------------------------------------------------

const browser = { tabUrl: PLAIN_URL, sent: [] as BrowserCommand[] };

function answer(command: BrowserCommand): Record<string, unknown> {
  const rules = compileUrlRules(command.protectedUrlRules ?? []).rules;
  const tab = { id: 1, url: browser.tabUrl } as Parameters<typeof checkProtectedTarget>[0];
  const refusal = checkProtectedTarget(tab, rules, command.approvedHost);
  if (refusal) {
    // The wire form: everything but success / safetyDecision / error goes in `data`.
    const { success, safetyDecision, error, ...data } = refusal;
    return { success, safetyDecision, error, data };
  }
  return { success: true, data: {} };
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-golden-grants-'));
  const configPath = path.join(tmpDir, 'safety.json');
  fs.writeFileSync(configPath, JSON.stringify({
    audit_log: false,
    max_actions_per_minute: 0,
    protected_url_patterns: [PROTECTED_HOST],
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
  refusedFirst: string[];
  approval: { toolName: string; host: string };
  command: Omit<BrowserCommand, 'requestId'>;
}

function setSituation(situation: Situation): void {
  // What the server last saw on the active tab, and where the tab really is.
  const known = situation === 'known' ? PROTECTED_URL : PLAIN_URL;
  getSafetyGuard().noteUrl({ url: known }, {}, 'fox_get_page_info');
  browser.tabUrl = situation === 'target' ? PLAIN_URL : PROTECTED_URL;
  browser.sent = [];
}

async function record(): Promise<GrantEntry[]> {
  const entries: GrantEntry[] = [];
  for (const [id, situation, tool, raw] of CASES) {
    const args = callSchemaFor(tool)!.parse(raw) as Record<string, unknown>;
    const handler = createToolHandler(tool);
    setSituation(situation);

    const first: CallToolResult = await handler(args);
    const request = findApprovalRequest(first);
    if (request === null) throw new Error(`${id}: no approval request: ${JSON.stringify(first.content)}`);
    const refusedFirst = browser.sent.map((c) => c.action);

    const reply = answerFromElicitation(request.requestId, true);
    if (!reply.approved || reply.approvalToken === undefined) throw new Error(`${id}: not approved`);
    browser.sent = [];
    const retry = await handler(args, { approvalToken: reply.approvalToken });
    if (retry.isError) throw new Error(`${id}: retry failed: ${JSON.stringify(retry.content)}`);
    if (browser.sent.length !== 1) throw new Error(`${id}: ${browser.sent.length} commands on retry`);

    const { requestId: _requestId, ...command } = browser.sent[0]!;
    entries.push(JSON.parse(JSON.stringify({
      id, tool, args: raw, refusedFirst,
      approval: { toolName: request.toolName, host: request.host },
      command,
    })) as GrantEntry);
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

  it('the approval names the tool as called and the protected host', () => {
    for (const e of actual) expect(e.approval, e.id).toEqual({ toolName: e.tool, host: PROTECTED_HOST });
  });

  it('only the browser-side situation is refused by the browser first', () => {
    for (const e of actual) {
      expect(e.refusedFirst, e.id).toEqual(e.id.startsWith('browser/') ? [e.command.action] : []);
    }
  });

  it('a public tool call gives the command of the operation it runs', () => {
    const byId = new Map(actual.map((e) => [e.id, e]));
    for (const [publicId, opId] of Object.entries(SAME_COMMAND)) {
      expect(byId.get(publicId)!.command, publicId).toEqual(byId.get(opId)!.command);
    }
  });
});
