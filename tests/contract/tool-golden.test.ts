/**
 * Golden: what each tool call sends to the browser, and what the guard
 * decides for it.
 *
 * Regenerate (only when a change of the recorded behaviour is intended):
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tool-golden.test.ts
 *
 * tests/golden/tool-commands.json, one entry per case:
 *   - approval: the site the human was asked about, for a call that needs
 *     approval (acting tools); the call is then approved (MCP elicitation)
 *     and retried with the token, as the relay does
 *   - command: the BrowserCommand handlers.ts sends (requestId dropped),
 *     after the arguments went through the tool's call schema like
 *     transport/http-bridge.ts does; null when nothing is sent
 *   - refusal: the error text when the call is refused before sending
 *   - timeoutMs: resolveCommandTimeout() on the Extension / headless path
 *   - headless: the HeadlessBrowser branch the action reaches
 *     (`dispatch:<action>`, `execute:<action>` or `default`; read from the
 *     route table HEADLESS_ROUTES of headless/actions.ts)
 * tests/golden/guard-decisions.json: SafetyGuard.check() per case and
 * policy (null = allowed).
 *
 * The cases call the public tools (tools/public-tools.ts); each id names the
 * operation the call runs. Together they run every operation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserCommand } from '@inari-mcp/shared';
import { OPERATION_NAMES } from '../../packages/mcp-server/src/tools/schemas.js';
import { createToolHandler } from '../../packages/mcp-server/src/tools/handlers.js';
import { getConnectionManager, resolveCommandTimeout } from '../../packages/mcp-server/src/connection/manager.js';
import { SafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { DEFAULT_CONFIG, type LoadedSafetyConfig } from '../../packages/mcp-server/src/safety/config.js';
import { callSchemaFor, resolveOperation } from '../../packages/mcp-server/src/tools/operations.js';
import { PUBLIC_TOOL_NAMES } from '../../packages/mcp-server/src/tools/public-tools.js';
import { headlessRoute } from '../../packages/mcp-server/src/headless/actions.js';
import { getSafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { callApproving } from '../../packages/mcp-server/tests/helpers/approval.js';

const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));

const PLAIN_URL = 'https://plain.example.test/';
const READ_SITE_URL = 'https://bank.example.test/transfer';
const BLOCKED_URL = 'https://blocked.example.test/';

/** The policy of both goldens: every list non-empty, container scope on. */
const POLICY = {
  blockedUrlPatterns: ['blocked.example.test'],
  allowedUrlPatterns: ['example.test'],
  confirmReadSites: ['bank.example.test'],
  containerScope: { enabled: true, containerName: 'Golden Agent' },
};

// ---------------------------------------------------------------------------
// Cases: [id, tool, raw arguments]. Schema defaults plus the main variants.
// ---------------------------------------------------------------------------

type Case = [id: string, tool: string, args: Record<string, unknown>];

const CASES: Case[] = [
  ['screenshot/default', 'fox_screenshot', {}],
  ['screenshot/full_page', 'fox_screenshot', { scope: 'full_page', tabId: 3, filename: 'shot.png' }],
  ['screenshot/all_tabs', 'fox_screenshot', { scope: 'all_tabs', urlPattern: 'example', timeout: 40000 }],
  ['screenshot/scroll_capture', 'fox_screenshot', { scope: 'scroll_capture', scrollStep: 400, maxScrolls: 5, restore: false }],
  ['snapshot/default', 'fox_snapshot', {}],
  ['snapshot/options', 'fox_snapshot', { selector: 'main', maxDepth: 3, includeText: false, roles: ['button'], tabId: 2 }],
  ['get_elements/default', 'fox_find', { by: 'selector', selector: 'a' }],
  ['get_elements/options', 'fox_find', { by: 'selector', selector: 'li', limit: 5, tabId: 2 }],
  ['get_text/default', 'fox_read', { mode: 'text' }],
  ['get_text/options', 'fox_read', { mode: 'text', selector: '#x', maxLength: 100, tabId: 2 }],
  ['find_text/default', 'fox_find', { by: 'text', text: 'hello' }],
  ['find_text/options', 'fox_find', { by: 'text', text: 'Hi', caseSensitive: true, entireWord: true, includeRectData: true, tabId: 4 }],
  ['get_page_info/default', 'fox_read', { mode: 'info' }],
  ['get_page_info/tab', 'fox_read', { mode: 'info', tabId: 5 }],
  ['get_tabs/default', 'fox_tabs', { what: 'tabs' }],
  ['get_tabs/options', 'fox_tabs', { what: 'tabs', currentWindowOnly: false, limit: 10, urlPattern: '^https://', includeFavicon: true }],
  ['get_tabs/invalid_regex', 'fox_tabs', { what: 'tabs', urlPattern: '(' }],
  ['navigate/default', 'fox_navigate', { url: PLAIN_URL }],
  ['navigate/goto_new_tab', 'fox_navigate', { action: 'goto', url: `${PLAIN_URL}next`, newTab: true, waitForLoad: false }],
  ['navigate/back', 'fox_navigate', { action: 'back' }],
  ['navigate/back_new_tab', 'fox_navigate', { action: 'back', newTab: true }],
  ['navigate/forward', 'fox_navigate', { action: 'forward', tabId: 2 }],
  ['navigate/refresh', 'fox_navigate', { action: 'refresh', bypassCache: true }],
  ['navigate/hard_refresh', 'fox_navigate', { action: 'hard_refresh' }],
  ['navigate/read_site', 'fox_navigate', { url: READ_SITE_URL }],
  ['navigate/blocked', 'fox_navigate', { url: BLOCKED_URL }],
  ['click/selector', 'fox_click', { selector: '#b' }],
  ['click/text', 'fox_click', { text: 'OK', doubleClick: true }],
  ['click/xy', 'fox_click', { x: 10, y: 20, rightClick: true, tabId: 2 }],
  ['click/xpath', 'fox_click', { xpath: '//a' }],
  ['type/selector', 'fox_type', { text: 'abc', selector: '#q' }],
  ['type/placeholder', 'fox_type', { text: 'x', placeholder: 'Search', clear: true, pressEnter: true, delay: 0 }],
  ['type/name', 'fox_type', { text: 'y', name: 'n' }],
  ['type/id', 'fox_type', { text: 'z', id: 'i', tabId: 3 }],
  ['type/password_selector', 'fox_type', { text: 'secret', selector: 'input[type=password]' }],
  ['press_key/default', 'fox_press_key', { key: 'Enter' }],
  ['press_key/options', 'fox_press_key', { key: 'a', selector: '#q', ctrl: true, shift: true, alt: true, meta: true, tabId: 2 }],
  ['press_key/locators', 'fox_press_key', { key: 'Tab', xpath: '//input', text: 'Name', id: 'q' }],
  ['set_value/default', 'fox_set_value', { selector: '#v', value: '1' }],
  ['set_value/tab', 'fox_set_value', { kind: 'input', selector: '#v', value: '2', tabId: 2 }],
  ['select_option/value', 'fox_set_value', { kind: 'select', selector: 'select', option: { value: 'a' } }],
  ['select_option/text', 'fox_set_value', { kind: 'select', selector: 'select', option: { text: 'A' } }],
  ['select_option/index', 'fox_set_value', { kind: 'select', selector: 'select', option: { index: 2 }, tabId: 2 }],
  ['hover/default', 'fox_interact', { action: 'hover', selector: '#h' }],
  ['scroll/default', 'fox_interact', { action: 'scroll' }],
  ['scroll/direction', 'fox_interact', { action: 'scroll', direction: 'down', amount: 500 }],
  ['scroll/to_element', 'fox_interact', { action: 'scroll', toElement: '#f', tabId: 2 }],
  ['scroll/container', 'fox_interact', { action: 'scroll', selector: '#pane', direction: 'top' }],
  ['highlight/default', 'fox_interact', { action: 'highlight', selector: '#h' }],
  ['highlight/options', 'fox_interact', { action: 'highlight', selector: '#h', duration: 1000, label: 'L', tabId: 2 }],
  ['create_tab/default', 'fox_tab', { action: 'create' }],
  ['create_tab/url', 'fox_tab', { action: 'create', url: PLAIN_URL, active: false }],
  ['create_tab/read_site', 'fox_tab', { action: 'create', url: READ_SITE_URL }],
  ['close_tab/default', 'fox_tab', { action: 'close', tabId: 7 }],
  ['switch_tab/default', 'fox_tab', { action: 'switch', tabId: 7 }],
  // 0.2.0
  ['set_window_state/default', 'fox_tab', { action: 'window' }],
  ['set_window_state/options', 'fox_tab', { action: 'window', state: 'fullscreen', tabId: 2 }],
  ['wait_for_element/default', 'fox_wait', { for: 'element', selector: '#w' }],
  ['wait_for_element/options', 'fox_wait', { for: 'element', selector: '#w', timeout: 40000, visible: false, tabId: 2 }],
  ['wait_for_network_idle/default', 'fox_wait', { for: 'network_idle' }],
  ['wait_for_network_idle/options', 'fox_wait', { for: 'network_idle', timeout: 2000, idleTime: 100, tabId: 2 }],
  ['wait_for_navigation/default', 'fox_wait', { for: 'navigation' }],
  ['wait_for_navigation/options', 'fox_wait', { for: 'navigation', waitUntil: 'domcontentloaded', urlPattern: '/done', timeout: 60000 }],
  ['wait_for_url/url', 'fox_wait', { for: 'url', url: `${PLAIN_URL}done` }],
  ['wait_for_url/pattern', 'fox_wait', { for: 'url', urlPattern: 'done$', timeout: 1000, tabId: 2 }],
  ['wait_for_url/read_site', 'fox_wait', { for: 'url', url: READ_SITE_URL }],
  ['handle_dialog/accept', 'fox_handle_dialog', { action: 'accept' }],
  ['handle_dialog/dismiss', 'fox_handle_dialog', { action: 'dismiss', tabId: 2 }],
  ['handle_dialog/prompt', 'fox_handle_dialog', { action: 'accept', promptText: 'p', timeout: 1000 }],
  ['request_approval/default', 'fox_request_approval', { message: 'm' }],
  ['request_approval/options', 'fox_request_approval', { message: 'm', detail: 'd', timeout: 120000, tabId: 2 }],
  ['detect_captcha/default', 'fox_detect_captcha', {}],
  ['detect_captcha/options', 'fox_detect_captcha', { timeout: 1000, tabId: 2 }],
  ['list_containers/default', 'fox_tabs', { what: 'containers' }],
  ['open_in_container/name', 'fox_tab', { action: 'create', url: PLAIN_URL, container: { name: 'Work' } }],
  ['open_in_container/cookie_store', 'fox_tab', { action: 'create', url: PLAIN_URL, container: { cookieStoreId: 'firefox-container-1' }, active: false }],
  ['open_in_container/blocked', 'fox_tab', { action: 'create', url: BLOCKED_URL, container: { name: 'Work' } }],
  ['safety_status/default', 'fox_safety_status', {}],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = callSchemaFor(tool);
  if (!schema) throw new Error(`unknown tool ${tool}`);
  return schema.parse(args) as Record<string, unknown>;
}

/** JSON round trip: drops undefined, like the golden file. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The HeadlessBrowser branch of an action, from the route table of
 * headless/actions.ts: run under the lock (`dispatch:`), by execute() itself
 * outside the lock (`execute:`), or the unsupported-action answer (`default`).
 */
function headlessTarget(action: string): string {
  const route = headlessRoute(action);
  if (route.kind === 'unlocked') return `execute:${action}`;
  if (route.kind === 'dispatch') return `dispatch:${action}`;
  return 'default';
}

function readGolden(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), 'utf-8'));
}

function writeGolden(name: string, value: unknown): void {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(GOLDEN_DIR, name), JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Commands sent to the browser
// ---------------------------------------------------------------------------

interface CommandEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  approval?: string;
  command: Omit<BrowserCommand, 'requestId'> | null;
  refusal?: string;
  timeoutMs?: { extension: number; headless: number };
  headless?: string;
}

const sent: BrowserCommand[] = [];
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-golden-'));
  const configPath = path.join(tmpDir, 'safety.json');
  fs.writeFileSync(configPath, JSON.stringify({
    audit_log: false,
    max_actions_per_minute: 0,
    blocked_url_patterns: POLICY.blockedUrlPatterns,
    allowed_url_patterns: POLICY.allowedUrlPatterns,
    confirm_read_sites: POLICY.confirmReadSites,
    container_scope: { enabled: true, container_name: POLICY.containerScope.containerName },
  }));
  process.env['FOX_SAFETY_CONFIG'] = configPath;

  const cm = getConnectionManager();
  cm.registerBrowser('golden', (command) => {
    sent.push(command);
    setTimeout(() => cm.handleResponse({ requestId: command.requestId, success: true, data: {} }), 0);
  }, 'native-host');
});

afterAll(() => {
  getConnectionManager().unregisterBrowser('golden');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A golden case to record, its arguments parsed. */
interface Call { id: string; tool: string; raw: Record<string, unknown>; args: Record<string, unknown> }

const caseCalls = (): Call[] =>
  CASES.map(([id, tool, raw]) => ({ id, tool, raw, args: parseArgs(tool, raw) }));

/**
 * The tabs of the cases (tabId 2-7, and the active tab) are on PLAIN_URL, so
 * that an acting call can be approved for that site. Noted before every call:
 * fox_close_tab makes the guard forget its tab.
 */
function noteCaseTabs(): void {
  getSafetyGuard().noteUrl({
    tabs: [1, 2, 3, 4, 5, 7].map((id) => ({ id, url: PLAIN_URL, active: id === 1 })),
  }, {}, 'fox_get_tabs');
}

/** The first line of a result's first text block: the refusal message ('' without one). */
function firstLine(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? (first.text.split('\n')[0] ?? '') : '';
}

/** The golden fields of the one command a call sent. */
function commandFields(command: BrowserCommand): Pick<CommandEntry, 'command' | 'timeoutMs' | 'headless'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to leave requestId out of the entry
  const { requestId: _requestId, ...rest } = command;
  return {
    command: rest,
    timeoutMs: {
      extension: resolveCommandTimeout(command, 'native-host'),
      headless: resolveCommandTimeout(command, 'headless'),
    },
    headless: headlessTarget(command.action),
  };
}

/** One call as its golden entry. An acting call is approved by the human and retried with the token. */
async function recordCommand({ id, tool, raw, args }: Call): Promise<CommandEntry> {
  noteCaseTabs();
  sent.length = 0;
  const { result, request } = await callApproving(createToolHandler(tool), args, () => {
    if (sent.length > 0) throw new Error(`${id}: sent before the approval`);
  });
  if (sent.length > 1) throw new Error(`${id}: ${sent.length} commands sent`);

  const command = sent[0];
  const entry: CommandEntry = {
    id, tool, args: raw, ...(request !== null ? { approval: request.host } : {}), command: null,
  };
  if (command) Object.assign(entry, commandFields(command));
  else if (result.isError) entry.refusal = firstLine(result);

  return plain(entry);
}

async function recordCommands(calls: Call[]): Promise<CommandEntry[]> {
  const entries: CommandEntry[] = [];
  for (const call of calls) entries.push(await recordCommand(call));

  return entries;
}

// ---------------------------------------------------------------------------
// Guard decisions
// ---------------------------------------------------------------------------

/** tabUrl null: the guard has seen no page (an acting call cannot be approved yet). */
const GUARD_POLICIES: Record<string, { config: Partial<LoadedSafetyConfig>; tabUrl: string | null }> = {
  default: { config: {}, tabUrl: PLAIN_URL },
  readOnly: { config: { readOnly: true }, tabUrl: PLAIN_URL },
  readSiteTab: { config: {}, tabUrl: READ_SITE_URL },
  localFileTab: { config: {}, tabUrl: 'file:///tmp/inari-test/page.html' },
  unknownTab: { config: {}, tabUrl: null },
  blockedTab: { config: {}, tabUrl: BLOCKED_URL },
  guardOff: { config: { enabled: false }, tabUrl: BLOCKED_URL },
};

type GuardEntry = { id: string; tool: string } & Record<string, string | null>;

function recordGuardDecisions(calls: Call[]): GuardEntry[] {
  const guards = Object.entries(GUARD_POLICIES).map(([name, { config, tabUrl }]) => {
    const guard = new SafetyGuard({
      ...DEFAULT_CONFIG,
      ...POLICY,
      auditLog: false,
      maxActionsPerMinute: 0,
      ...config,
    });
    if (tabUrl !== null) guard.noteUrl({ url: tabUrl }, {}, 'fox_get_page_info');
    return [name, guard] as const;
  });
  return calls.map(({ id, tool, args }) => {
    const call = resolveOperation(tool, args);
    const entry: GuardEntry = { id, tool };
    for (const [name, guard] of guards) {
      entry[name] = guard.check(call.op, call.args, { label: call.label })?.safetyDecision ?? null;
    }
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('golden cases', () => {
  it('call every public tool, run every operation and have unique ids', () => {
    expect(new Set(CASES.map(([, tool]) => tool))).toEqual(new Set(PUBLIC_TOOL_NAMES));
    expect(new Set(caseCalls().map(({ tool, args }) => resolveOperation(tool, args).op))).toEqual(new Set(OPERATION_NAMES));
    expect(new Set(CASES.map(([id]) => id)).size).toBe(CASES.length);
  });
});

describe('BrowserCommand per tool call (tests/golden/tool-commands.json)', () => {
  it('matches the golden file', async () => {
    const actual = await recordCommands(caseCalls());
    if (UPDATE) writeGolden('tool-commands.json', actual);
    const golden = readGolden('tool-commands.json') as CommandEntry[];
    expect(actual.map((e) => e.id)).toEqual(golden.map((e) => e.id));
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i], actual[i]!.id).toEqual(golden[i]);
    }
  });
});

describe('SafetyGuard decisions (tests/golden/guard-decisions.json)', () => {
  it('match the golden file', () => {
    const actual = recordGuardDecisions(caseCalls());
    if (UPDATE) writeGolden('guard-decisions.json', actual);
    const golden = readGolden('guard-decisions.json') as GuardEntry[];
    expect(actual.map((e) => e.id)).toEqual(golden.map((e) => e.id));
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i], actual[i]!.id).toEqual(golden[i]);
    }
  });
});

describe('public tool call schemas', () => {
  const rejects = (tool: string, args: Record<string, unknown>) =>
    callSchemaFor(tool)!.safeParse(args).success === false;

  it('refuse a missing or unknown discriminator and cross-argument violations', () => {
    expect(rejects('fox_wait', { selector: '#a' })).toBe(true);
    expect(rejects('fox_wait', { for: 'nope' })).toBe(true);
    expect(rejects('fox_wait', { for: 'url' })).toBe(true);
    expect(rejects('fox_set_value', { kind: 'select', selector: 's', option: { value: 'a', index: 1 } })).toBe(true);
    expect(rejects('fox_tab', { action: 'create', container: { name: 'Work' } })).toBe(true);
    expect(rejects('fox_tab', { action: 'close' })).toBe(true);
  });
});
