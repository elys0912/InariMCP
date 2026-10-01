/**
 * Golden: what each tool call sends to the browser, and what the guard
 * decides for it (WP13: the tool consolidation must not change either).
 *
 * Regenerate (only when a change of the recorded behaviour is intended):
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tool-golden.test.ts
 *
 * tests/golden/tool-commands.json, one entry per case:
 *   - command: the BrowserCommand handlers.ts sends (requestId dropped),
 *     after the arguments went through the tool's zod schema like
 *     transport/http-bridge.ts does; null when nothing is sent
 *   - refusal: the error text when the call is refused before sending
 *   - timeoutMs: resolveCommandTimeout() on the Extension / headless path
 *   - headless: the HeadlessBrowser branch the action reaches
 *     (`dispatch:<case>`, `execute:<action>` or `default`)
 * tests/golden/guard-decisions.json: SafetyGuard.check() per case and
 * policy (null = allowed).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserCommand } from '@kitsune-mcp/shared';
import { TOOL_SCHEMAS } from '../../packages/mcp-server/src/tools/schemas.js';
import { createToolHandler } from '../../packages/mcp-server/src/tools/handlers.js';
import { getConnectionManager, resolveCommandTimeout } from '../../packages/mcp-server/src/connection/manager.js';
import { SafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { DEFAULT_CONFIG, type LoadedSafetyConfig } from '../../packages/mcp-server/src/safety/config.js';

const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));
const BACKEND_SRC = fileURLToPath(new URL('../../packages/mcp-server/src/headless/backend.ts', import.meta.url));

const PLAIN_URL = 'https://plain.example.test/';
const PROTECTED_URL = 'https://bank.example.test/transfer';
const BLOCKED_URL = 'https://blocked.example.test/';

/** The policy of both goldens: every list non-empty, container scope on. */
const POLICY = {
  blockedUrlPatterns: ['blocked.example.test'],
  allowedUrlPatterns: ['example.test'],
  protectedUrlPatterns: ['bank.example.test'],
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
  ['get_elements/default', 'fox_get_elements', { selector: 'a' }],
  ['get_elements/options', 'fox_get_elements', { selector: 'li', limit: 5, tabId: 2 }],
  ['get_text/default', 'fox_get_text', {}],
  ['get_text/options', 'fox_get_text', { selector: '#x', maxLength: 100, tabId: 2 }],
  ['find_text/default', 'fox_find_text', { query: 'hello' }],
  ['find_text/options', 'fox_find_text', { query: 'Hi', caseSensitive: true, entireWord: true, includeRectData: true, tabId: 4 }],
  ['get_page_info/default', 'fox_get_page_info', {}],
  ['get_page_info/tab', 'fox_get_page_info', { tabId: 5 }],
  ['get_tabs/default', 'fox_get_tabs', {}],
  ['get_tabs/options', 'fox_get_tabs', { currentWindowOnly: false, limit: 10, urlPattern: '^https://', includeFavicon: true }],
  ['get_tabs/invalid_regex', 'fox_get_tabs', { urlPattern: '(' }],
  ['navigate/default', 'fox_navigate', { url: PLAIN_URL }],
  ['navigate/goto_new_tab', 'fox_navigate', { action: 'goto', url: `${PLAIN_URL}next`, newTab: true, waitForLoad: false }],
  ['navigate/back', 'fox_navigate', { action: 'back' }],
  ['navigate/forward', 'fox_navigate', { action: 'forward', tabId: 2 }],
  ['navigate/refresh', 'fox_navigate', { action: 'refresh', bypassCache: true }],
  ['navigate/hard_refresh', 'fox_navigate', { action: 'hard_refresh' }],
  ['navigate/protected', 'fox_navigate', { url: PROTECTED_URL }],
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
  ['set_value/default', 'fox_set_value', { selector: '#v', value: '1' }],
  ['set_value/tab', 'fox_set_value', { selector: '#v', value: '2', tabId: 2 }],
  ['select_option/value', 'fox_select_option', { selector: 'select', value: 'a' }],
  ['select_option/text', 'fox_select_option', { selector: 'select', text: 'A' }],
  ['select_option/index', 'fox_select_option', { selector: 'select', index: 2, tabId: 2 }],
  ['hover/default', 'fox_hover', { selector: '#h' }],
  ['scroll/default', 'fox_scroll', {}],
  ['scroll/direction', 'fox_scroll', { direction: 'down', amount: 500 }],
  ['scroll/to_element', 'fox_scroll', { toElement: '#f', tabId: 2 }],
  ['scroll/container', 'fox_scroll', { selector: '#pane', direction: 'top' }],
  ['highlight/default', 'fox_highlight', { selector: '#h' }],
  ['highlight/options', 'fox_highlight', { selector: '#h', duration: 1000, label: 'L', tabId: 2 }],
  ['create_tab/default', 'fox_create_tab', {}],
  ['create_tab/url', 'fox_create_tab', { url: PLAIN_URL, active: false }],
  ['create_tab/protected', 'fox_create_tab', { url: PROTECTED_URL }],
  ['close_tab/default', 'fox_close_tab', { tabId: 7 }],
  ['switch_tab/default', 'fox_switch_tab', { tabId: 7 }],
  ['wait_for_element/default', 'fox_wait_for_element', { selector: '#w' }],
  ['wait_for_element/options', 'fox_wait_for_element', { selector: '#w', timeout: 40000, visible: false, tabId: 2 }],
  ['wait_for_network_idle/default', 'fox_wait_for_network_idle', {}],
  ['wait_for_network_idle/options', 'fox_wait_for_network_idle', { timeout: 2000, idleTime: 100, tabId: 2 }],
  ['wait_for_navigation/default', 'fox_wait_for_navigation', {}],
  ['wait_for_navigation/options', 'fox_wait_for_navigation', { waitUntil: 'domcontentloaded', urlPattern: '/done', timeout: 60000 }],
  ['wait_for_url/url', 'fox_wait_for_url', { url: `${PLAIN_URL}done` }],
  ['wait_for_url/pattern', 'fox_wait_for_url', { urlPattern: 'done$', timeout: 1000, tabId: 2 }],
  ['wait_for_url/protected', 'fox_wait_for_url', { url: PROTECTED_URL }],
  ['start_logging/default', 'fox_start_logging', {}],
  ['start_logging/options', 'fox_start_logging', { clearExisting: true, tabId: 2 }],
  ['stop_logging/default', 'fox_stop_logging', {}],
  ['get_console_logs/default', 'fox_get_console_logs', {}],
  ['get_console_logs/options', 'fox_get_console_logs', { level: 'error', search: 'x', limit: 5, tabId: 2 }],
  ['get_network_logs/default', 'fox_get_network_logs', {}],
  ['get_network_logs/options', 'fox_get_network_logs', { urlPattern: 'api', method: 'POST', status: 500, errorsOnly: true, limit: 3 }],
  ['clear_logs/default', 'fox_clear_logs', {}],
  ['clear_logs/options', 'fox_clear_logs', { console: false, tabId: 2 }],
  ['execute_script/default', 'fox_execute_script', { script: '1+1' }],
  ['execute_script/tab', 'fox_execute_script', { script: 'document.title', tabId: 2 }],
  ['eval_chain/default', 'fox_eval_chain', {
    steps: [{ script: '1' }, { script: '$prev+1', label: 'inc', captureConsole: false, stopOnError: false }],
  }],
  ['inject_observer/default', 'fox_inject_observer', {}],
  ['inject_observer/options', 'fox_inject_observer', { selector: '#root', observerId: 'o1', observeAttributes: false, tabId: 2 }],
  ['remove_observer/default', 'fox_remove_observer', { observerId: 'o1' }],
  ['run_workflow/default', 'fox_run_workflow', { steps: [{ tool: 'fox_click', arguments: { selector: '#a' } }] }],
  ['audit_page/default', 'fox_audit_page', {}],
  ['audit_page/options', 'fox_audit_page', { screenshot: false, fullPage: true, tabId: 2 }],
  ['wait_and_act/default', 'fox_wait_and_act', { condition: 'true', actionScript: '1' }],
  ['wait_and_act/options', 'fox_wait_and_act', { condition: 'true', actionScript: '1', pollIntervalMs: 50, timeoutMs: 60000, tabId: 2 }],
  ['handle_dialog/accept', 'fox_handle_dialog', { action: 'accept' }],
  ['handle_dialog/dismiss', 'fox_handle_dialog', { action: 'dismiss', tabId: 2 }],
  ['handle_dialog/prompt', 'fox_handle_dialog', { action: 'accept', promptText: 'p', timeout: 1000 }],
  ['request_approval/default', 'fox_request_approval', { message: 'm' }],
  ['request_approval/options', 'fox_request_approval', { message: 'm', detail: 'd', timeout: 120000, tabId: 2 }],
  ['detect_captcha/default', 'fox_detect_captcha', {}],
  ['detect_captcha/options', 'fox_detect_captcha', { timeout: 1000, tabId: 2 }],
  ['list_containers/default', 'fox_list_containers', {}],
  ['open_in_container/name', 'fox_open_in_container', { url: PLAIN_URL, containerName: 'Work' }],
  ['open_in_container/cookie_store', 'fox_open_in_container', { url: PLAIN_URL, cookieStoreId: 'firefox-container-1', active: false }],
  ['open_in_container/blocked', 'fox_open_in_container', { url: BLOCKED_URL, containerName: 'Work' }],
  ['safety_status/default', 'fox_safety_status', {}],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_SCHEMAS[tool];
  if (!def) throw new Error(`unknown tool ${tool}`);
  return def.inputSchema.parse(args) as Record<string, unknown>;
}

/** JSON round trip: drops undefined, like the golden file. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** case labels of HeadlessBrowser._dispatch(), and actions execute() handles itself. */
function headlessBranches(): { dispatch: Set<string>; execute: Set<string> } {
  const src = fs.readFileSync(BACKEND_SRC, 'utf-8');
  const start = src.indexOf('private async _dispatch(');
  const end = src.indexOf('export function getHeadlessBrowser');
  const executeStart = src.indexOf('async execute(');
  if (start < 0 || end < 0 || executeStart < 0) throw new Error('backend.ts layout changed');
  const labels = (text: string, re: RegExp) => new Set([...text.matchAll(re)].map((m) => m[1]!));
  return {
    dispatch: labels(src.slice(start, end), /case '([a-z_]+)'/g),
    execute: labels(src.slice(executeStart, start), /action === '([a-z_]+)'/g),
  };
}

function headlessTarget(action: string, branches: ReturnType<typeof headlessBranches>): string {
  if (branches.execute.has(action)) return `execute:${action}`;
  if (branches.dispatch.has(action)) return `dispatch:${action}`;
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
  command: Omit<BrowserCommand, 'requestId'> | null;
  refusal?: string;
  timeoutMs?: { extension: number; headless: number };
  headless?: string;
}

const sent: BrowserCommand[] = [];
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-golden-'));
  const configPath = path.join(tmpDir, 'safety.json');
  fs.writeFileSync(configPath, JSON.stringify({
    audit_log: false,
    max_actions_per_minute: 0,
    blocked_url_patterns: POLICY.blockedUrlPatterns,
    allowed_url_patterns: POLICY.allowedUrlPatterns,
    protected_url_patterns: POLICY.protectedUrlPatterns,
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

async function recordCommands(): Promise<CommandEntry[]> {
  const branches = headlessBranches();
  const entries: CommandEntry[] = [];
  for (const [id, tool, raw] of CASES) {
    const args = parseArgs(tool, raw);
    sent.length = 0;
    const result = await createToolHandler(tool)(args);
    if (sent.length > 1) throw new Error(`${id}: ${sent.length} commands sent`);
    const command = sent[0];
    const entry: CommandEntry = { id, tool, args: raw, command: null };
    if (command) {
      const { requestId: _requestId, ...rest } = command;
      entry.command = rest;
      entry.timeoutMs = {
        extension: resolveCommandTimeout(command, 'native-host'),
        headless: resolveCommandTimeout(command, 'headless'),
      };
      entry.headless = headlessTarget(command.action, branches);
    } else if (result.isError) {
      const first = result.content[0];
      entry.refusal = first && first.type === 'text' ? first.text.split('\n')[0] : '';
    }
    entries.push(plain(entry));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Guard decisions
// ---------------------------------------------------------------------------

const GUARD_POLICIES: Record<string, { config: Partial<LoadedSafetyConfig>; tabUrl: string }> = {
  default: { config: {}, tabUrl: PLAIN_URL },
  readOnly: { config: { readOnly: true }, tabUrl: PLAIN_URL },
  scriptsOff: { config: { allowScriptExecution: false }, tabUrl: PLAIN_URL },
  protectedTab: { config: {}, tabUrl: PROTECTED_URL },
  blockedTab: { config: {}, tabUrl: BLOCKED_URL },
  guardOff: { config: { enabled: false }, tabUrl: BLOCKED_URL },
};

type GuardEntry = { id: string; tool: string } & Record<string, string | null>;

function recordGuardDecisions(): GuardEntry[] {
  const guards = Object.entries(GUARD_POLICIES).map(([name, { config, tabUrl }]) => {
    const guard = new SafetyGuard({
      ...DEFAULT_CONFIG,
      ...POLICY,
      auditLog: false,
      maxActionsPerMinute: 0,
      ...config,
    });
    guard.noteUrl({ url: tabUrl }, {}, 'fox_get_page_info');
    return [name, guard] as const;
  });
  return CASES.map(([id, tool, raw]) => {
    const args = parseArgs(tool, raw);
    const entry: GuardEntry = { id, tool };
    for (const [name, guard] of guards) {
      entry[name] = guard.check(tool, args)?.safetyDecision ?? null;
    }
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('golden cases', () => {
  it('cover every tool and have unique ids', () => {
    expect(new Set(CASES.map(([, tool]) => tool))).toEqual(new Set(Object.keys(TOOL_SCHEMAS)));
    expect(new Set(CASES.map(([id]) => id)).size).toBe(CASES.length);
  });
});

describe('BrowserCommand per tool call (tests/golden/tool-commands.json)', () => {
  it('matches the golden file', async () => {
    const actual = await recordCommands();
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
    const actual = recordGuardDecisions();
    if (UPDATE) writeGolden('guard-decisions.json', actual);
    const golden = readGolden('guard-decisions.json') as GuardEntry[];
    expect(actual.map((e) => e.id)).toEqual(golden.map((e) => e.id));
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i], actual[i]!.id).toEqual(golden[i]);
    }
  });
});

// TODO(test): commands with an approval grant (approvedHost) and Extension-side refusals.
// TODO(test): FOX_READ_ONLY / FOX_ALLOW_SCRIPTS env overrides through the handler path.
