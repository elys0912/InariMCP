/**
 * The Extension's dispatcher fails closed on safety metadata it cannot use.
 * A command whose containerScope or URL rules are there but unusable is
 * refused with safetyDecision "config_error" before any handler runs; the
 * MCP Server refuses the settings that would produce them. Runs
 * handleCommand (background/dispatch.ts) against a fake `browser`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BrowserCommandSchema } from '@inari-mcp/shared';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';
import { checkApproval } from '../../packages/extension/src/background/url-policy.ts';
import { resolveWireAction } from '../../packages/extension/src/background/wire.ts';
import { SafetyGuard } from '../../packages/mcp-server/src/safety/guard.js';
import { DEFAULT_CONFIG } from '../../packages/mcp-server/src/safety/config.js';

const tab = { id: 1, url: 'https://app.example.test/page', cookieStoreId: 'c-agent' } as browser.tabs.Tab;

/** Messages the background handed to a content script (the handler ran). */
let sent: unknown[] = [];

function installBrowser(): void {
  sent = [];
  (globalThis as { browser?: unknown }).browser = {
    contextualIdentities: {
      query: async (q: { name?: string }) =>
        [{ name: 'agent', cookieStoreId: 'c-agent' }].filter((c) => q.name === undefined || c.name === q.name),
    },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      sendMessage: async (_id: number, m: unknown) => {
        sent.push(m);
        return {};
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as { browser?: unknown }).browser;
});

const hostRule = (host: string, path: string | null = null): Record<string, unknown> =>
  ({ kind: 'host', source: host, scheme: null, hosts: 'tree', host, port: null, path, pathMatch: 'loose' });

describe('containerScope', () => {
  it.each([
    ['an empty name', { containerName: '' }],
    ['a string', 'agent'],
    ['a number', 42],
    ['null', null],
    ['an array', [{ containerName: 'agent' }]],
    ['no containerName', {}],
    ['a non-string name', { containerName: 7 }],
  ])('%s is refused as config_error before the handler runs', async (_label, containerScope) => {
    installBrowser();
    const result = await handleCommand({ action: 'get_page_info', containerScope }, 'host');
    expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
    expect(result.error).toMatch(/container scope/);
    expect(sent).toEqual([]);
  });

  it('absent: no scope check, the handler runs', async () => {
    installBrowser();
    expect(await handleCommand({ action: 'get_page_info' }, 'host')).toMatchObject({ success: true });
    expect(sent).toHaveLength(1);
  });

  it('a usable scope is still enforced', async () => {
    installBrowser();
    expect(await handleCommand({ action: 'get_page_info', containerScope: { containerName: 'agent' } }, 'host'))
      .toMatchObject({ success: true });
    expect(await handleCommand({ action: 'get_page_info', containerScope: { containerName: 'other' } }, 'host'))
      .toMatchObject({ success: false, safetyDecision: 'out_of_scope' });
  });

  it('the wire schema refuses an empty container name', () => {
    const base = { action: 'click', requestId: 'r1' };
    expect(BrowserCommandSchema.safeParse({ ...base, containerScope: { containerName: '' } }).success).toBe(false);
    expect(BrowserCommandSchema.safeParse({ ...base, containerScope: { containerName: 'agent' } }).success).toBe(true);
  });
});

describe('E-03 URL rule fields that are not arrays', () => {
  const NOT_ARRAYS: [string, unknown][] = [['a string', 'https://a.example'], ['an object', {}], ['null', null], ['a number', 1]];

  for (const field of ['confirmReadUrlRules', 'blockedUrlRules', 'allowedUrlRules']) {
    it.each(NOT_ARRAYS)(`${field} as %s is refused as config_error`, async (_label, value) => {
      installBrowser();
      const result = await handleCommand({ action: 'get_page_info', [field]: value }, 'host');
      expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
      expect(sent).toEqual([]);
    });
  }

  it('confirmReadUrlRules: a read of a matching tab needs the approval of its site', async () => {
    installBrowser();
    const rules = [hostRule('app.example.test')];
    expect(await handleCommand({ action: 'get_page_info', confirmReadUrlRules: rules }, 'host')).toMatchObject({
      success: false, safetyDecision: 'confirmation_required',
      url: 'https://app.example.test/page', matchedPattern: 'app.example.test',
    });
    expect(sent).toEqual([]);
    expect(await handleCommand({ action: 'get_page_info', confirmReadUrlRules: [hostRule('bank.test')] }, 'host'))
      .toMatchObject({ success: true });
    expect(await handleCommand(
      { action: 'get_page_info', confirmReadUrlRules: rules, approvedHost: 'app.example.test' }, 'host',
    )).toMatchObject({ success: true });
  });
});

// Whether an acting command needs a human approval is the Extension's
// own rule, not a value the host sends: with nothing attached it is refused.
describe('acting commands need an approval of their site', () => {
  it('a click without approvedHost is refused before the handler runs, naming the tab URL', async () => {
    installBrowser();
    const result = await handleCommand({ action: 'click', data: { selector: '#a' } }, 'host');
    expect(result).toMatchObject({
      success: false, safetyDecision: 'confirmation_required', url: 'https://app.example.test/page',
    });
    expect(sent).toEqual([]);
  });

  it('runs with the approval of the tab\'s site only', async () => {
    installBrowser();
    expect(await handleCommand({ action: 'click', data: { selector: '#a' }, approvedHost: 'other.test' }, 'host'))
      .toMatchObject({ success: false, safetyDecision: 'confirmation_required' });
    expect(await handleCommand({ action: 'click', data: { selector: '#a' }, approvedHost: 'example.test' }, 'host'))
      .toMatchObject({ success: false, safetyDecision: 'confirmation_required' });
    expect(sent).toEqual([]);
    expect(await handleCommand({ action: 'click', data: { selector: '#a' }, approvedHost: 'APP.example.test.' }, 'host'))
      .toMatchObject({ success: true });
    expect(sent).toHaveLength(1);
  });

  it('a command from the popup gets no exception', async () => {
    installBrowser();
    expect(await handleCommand({ action: 'click', data: { selector: '#a' } }, 'page'))
      .toMatchObject({ success: false, safetyDecision: 'confirmation_required' });
  });

  it('an opening command is approved for the URL it opens (a blank tab: about:)', () => {
    const t = tab;
    expect(checkApproval('actOnUrl', t, { url: 'https://new.test/a' }, [], 'new.test')).toBeNull();
    expect(checkApproval('actOnUrl', t, { url: 'https://new.test/a' }, [], 'app.example.test'))
      .toMatchObject({ safetyDecision: 'confirmation_required', url: 'https://new.test/a' });
    expect(checkApproval('actOnUrl', undefined, {}, [], 'about:')).toBeNull();
    expect(checkApproval('actOnUrl', undefined, {}, [], undefined))
      .toMatchObject({ safetyDecision: 'confirmation_required', url: 'about:blank' });
  });

  it('a tab that cannot be resolved fails closed', () => {
    expect(checkApproval('act', undefined, {}, [], 'app.example.test')).toMatchObject({ success: false });
    expect(checkApproval('act', undefined, {}, [], 'app.example.test')).not.toHaveProperty('safetyDecision');
  });
});

describe('a host rule path with a query or fragment', () => {
  it.each(['confirmReadUrlRules', 'blockedUrlRules', 'allowedUrlRules'])('in %s is refused as config_error', async (field) => {
    installBrowser();
    const result = await handleCommand({ action: 'get_page_info', [field]: [hostRule('app.example.test', '/page?x=1')] }, 'host');
    expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
    expect(result.error).toMatch(/1 URL pattern\(s\)/);
    expect(sent).toEqual([]);
  });

  it('the guard puts such a safety.json pattern in the config-error state', () => {
    for (const list of ['blockedUrlPatterns', 'allowedUrlPatterns', 'confirmReadSites'] as const) {
      const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, [list]: ['example.test/a?x=1'] });
      expect(g.check('fox_screenshot', {})?.safetyDecision, list).toBe('config_error');
    }
  });
});

describe('E-16 action names from the Native Host', () => {
  it('a name outside the wire table is unknown when it comes from the host', () => {
    expect(resolveWireAction('getPageInfo', true)).toEqual({ kind: 'unknown', wireName: 'getPageInfo' });
    expect(resolveWireAction('status', true)).toEqual({ kind: 'unknown', wireName: 'status' });
    expect(resolveWireAction('get_page_info', true)).toEqual({ kind: 'action', action: 'getPageInfo' });
    // The Extension's own pages keep using internal names.
    expect(resolveWireAction('status', false)).toEqual({ kind: 'action', action: 'status' });
  });

  it('handleCommand from the host refuses an internal name without running its handler', async () => {
    installBrowser();
    const result = await handleCommand({ action: 'getPageInfo', requestId: 'r1' }, 'host');
    expect(result).toEqual({ success: false, error: 'Unknown action: getPageInfo' });
    expect(sent).toEqual([]);
    expect(await handleCommand({ action: 'get_page_info', requestId: 'r2' }, 'host'))
      .toMatchObject({ success: true });
  });
});
