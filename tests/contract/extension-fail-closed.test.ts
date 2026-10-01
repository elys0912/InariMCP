/**
 * R2-C WP-A: the Extension's dispatcher fails closed on safety metadata it
 * cannot use (review E-01 / A-02, E-03, A-01, E-16). A command whose
 * containerScope or URL rules are there but unusable is refused with
 * safetyDecision "config_error" before any handler runs; the MCP Server
 * refuses the settings that would produce them. Runs handleCommand
 * (background/dispatch.ts) against a fake `browser`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BrowserCommandSchema } from '@kitsune-mcp/shared';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';

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
    const result = await handleCommand({ action: 'get_page_info', containerScope });
    expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
    expect(result.error).toMatch(/container scope/);
    expect(sent).toEqual([]);
  });

  it('absent: no scope check, the handler runs', async () => {
    installBrowser();
    expect(await handleCommand({ action: 'get_page_info' })).toMatchObject({ success: true });
    expect(sent).toHaveLength(1);
  });

  it('a usable scope is still enforced', async () => {
    installBrowser();
    expect(await handleCommand({ action: 'get_page_info', containerScope: { containerName: 'agent' } }))
      .toMatchObject({ success: true });
    expect(await handleCommand({ action: 'get_page_info', containerScope: { containerName: 'other' } }))
      .toMatchObject({ success: false, safetyDecision: 'out_of_scope' });
  });

  it('the wire schema refuses an empty container name', () => {
    const base = { action: 'click', requestId: 'r1' };
    expect(BrowserCommandSchema.safeParse({ ...base, containerScope: { containerName: '' } }).success).toBe(false);
    expect(BrowserCommandSchema.safeParse({ ...base, containerScope: { containerName: 'agent' } }).success).toBe(true);
  });
});
