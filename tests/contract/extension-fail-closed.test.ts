/**
 * R2-C WP-A: the Extension's dispatcher fails closed on safety metadata it
 * cannot use (review E-01 / A-02, E-03, A-01, E-16). A command whose
 * containerScope or URL rules are there but unusable is refused with
 * safetyDecision "config_error" before any handler runs; the MCP Server
 * refuses the settings that would produce them. Runs handleCommand
 * (background/dispatch.ts) against a fake `browser`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BrowserCommandSchema } from '@inari-mcp/shared';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';
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

describe('E-01 / A-02 containerScope', () => {
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

  for (const field of ['protectedUrlRules', 'blockedUrlRules', 'allowedUrlRules', 'protectedUrlPatterns']) {
    it.each(NOT_ARRAYS)(`${field} as %s is refused as config_error`, async (_label, value) => {
      installBrowser();
      const result = await handleCommand({ action: 'get_page_info', [field]: value }, 'host');
      expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
      expect(sent).toEqual([]);
    });
  }

  it('an unusable protectedUrlRules does not fall back to the legacy protectedUrlPatterns', async () => {
    installBrowser();
    const result = await handleCommand({
      action: 'get_page_info',
      protectedUrlRules: 'bank.test',
      protectedUrlPatterns: ['bank\\.test'],
    }, 'host');
    expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
  });

  it('the legacy protectedUrlPatterns alone (older servers) still works', async () => {
    installBrowser();
    expect(await handleCommand({ action: 'get_page_info', protectedUrlPatterns: ['app\\.example\\.test'] }, 'host'))
      .toMatchObject({ success: false, safetyDecision: 'confirmation_required' });
    expect(await handleCommand({ action: 'get_page_info', protectedUrlPatterns: ['bank\\.test'] }, 'host'))
      .toMatchObject({ success: true });
  });
});

describe('A-01 a host rule path with a query or fragment', () => {
  it.each(['protectedUrlRules', 'blockedUrlRules', 'allowedUrlRules'])('in %s is refused as config_error', async (field) => {
    installBrowser();
    const result = await handleCommand({ action: 'get_page_info', [field]: [hostRule('app.example.test', '/page?x=1')] }, 'host');
    expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
    expect(result.error).toMatch(/1 URL pattern\(s\)/);
    expect(sent).toEqual([]);
  });

  it('the guard puts such a safety.json pattern in the config-error state', () => {
    for (const list of ['blockedUrlPatterns', 'allowedUrlPatterns', 'protectedUrlPatterns'] as const) {
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
