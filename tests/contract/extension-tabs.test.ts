/**
 * Extension background/tabs.ts: the tab tools under container scope
 * (Layer 0), against a fake `browser`. Tabs outside the agent container
 * must not show up, and a tab the agent creates must be born inside it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeTab,
  createNewTab,
  findTabs,
  findText,
  focusTab,
  getAllTabs,
  getTabInfo,
} from '../../packages/extension/src/background/tabs.ts';

type Tab = browser.tabs.Tab;

const tab = (fields: Partial<Tab> & { id: number }): Tab =>
  ({ windowId: 1, active: false, status: 'complete', ...fields }) as Tab;

const AGENT = 'c-agent';
const TABS: Tab[] = [
  tab({ id: 1, url: 'https://app.example.test/a', title: 'App A', cookieStoreId: AGENT, active: true, windowId: 1 }),
  tab({ id: 2, url: 'https://app.example.test/b', title: 'App B', cookieStoreId: AGENT, windowId: 2, status: 'loading' }),
  tab({ id: 3, url: 'https://mail.example.test/', title: 'Personal mail', cookieStoreId: 'firefox-default', windowId: 3 }),
];
const SCOPE = { containerName: 'agent', cookieStoreId: AGENT };

/** A fake `browser` over TABS; returns the spies a test looks at. */
function installFakeBrowser(overrides: Record<string, unknown> = {}) {
  const spies = {
    query: vi.fn(async (q: { currentWindow?: boolean }) => (q.currentWindow ? TABS.filter((t) => t.windowId === 1) : TABS)),
    create: vi.fn(async (props: { url: string }) => tab({ id: 9, url: props.url })),
    remove: vi.fn(async (_id: number) => {}),
    update: vi.fn(async (id: number) => tab({ id, windowId: 2 })),
    windowsUpdate: vi.fn(async () => ({})),
    createContainer: vi.fn(async () => ({ cookieStoreId: 'c-new' })),
    find: vi.fn(async () => ({ count: 2, rangeData: [{}, {}], rectData: [{ r: 1 }] })),
  };
  (globalThis as { browser?: unknown }).browser = {
    tabs: {
      query: spies.query,
      create: spies.create,
      remove: spies.remove,
      update: spies.update,
      get: async (id: number) => TABS.find((t) => t.id === id) ?? Promise.reject(new Error(`Invalid tab ID: ${id}`)),
      sendMessage: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true }, { id: 2, focused: false }, { id: 3, focused: false }],
      get: async (id: number) => ({ id, focused: true, state: 'normal', type: 'normal' }),
      update: spies.windowsUpdate,
    },
    contextualIdentities: { query: async () => [], create: spies.createContainer },
    find: { find: spies.find },
    ...overrides,
  };
  return spies;
}

afterEach(() => {
  delete (globalThis as { browser?: unknown }).browser;
});

describe('background/tabs.ts', () => {
  it('getAllTabs lists the current window by default, with summary and limit', async () => {
    const spies = installFakeBrowser();
    const r = await getAllTabs();
    expect(spies.query).toHaveBeenCalledWith({ currentWindow: true });
    expect(r).toMatchObject({ success: true, scope: 'current_window', windowCount: 3, totalTabs: 1, truncated: false });

    const all = await getAllTabs({ currentWindowOnly: false, limit: 2, includeFavicon: true });
    expect(all).toMatchObject({ scope: 'all_windows', totalTabs: 3, returnedTabs: 2, truncated: true });
    expect(all['summary']).toEqual({ active: 1, loading: 1, discarded: 0, audible: 0 });
    const first = (all['tabs'] as Record<string, unknown>[])[0]!;
    expect(first).toHaveProperty('favIconUrl');
    expect(first['windowFocused']).toBe(true);
  });

  it('getAllTabs under container scope hides other tabs and the windows holding only them', async () => {
    installFakeBrowser();
    const r = await getAllTabs({ currentWindowOnly: false }, SCOPE);
    expect((r['tabs'] as { id: number }[]).map((t) => t.id)).toEqual([1, 2]);
    expect(r['windowCount']).toBe(2); // window 3 holds only the personal tab
    // a scope whose container does not exist matches nothing
    const none = await getAllTabs({ currentWindowOnly: false }, { containerName: 'agent', cookieStoreId: null });
    expect(none).toMatchObject({ success: true, totalTabs: 0, windowCount: 0 });
  });

  it('getAllTabs / findTabs filter by a case-sensitive urlPattern and refuse an invalid one', async () => {
    installFakeBrowser();
    const r = await getAllTabs({ currentWindowOnly: false, urlPattern: '/b$' });
    expect((r['tabs'] as { id: number }[]).map((t) => t.id)).toEqual([2]);
    expect((await getAllTabs({ currentWindowOnly: false, urlPattern: 'APP' }))['totalTabs']).toBe(0);
    expect(await getAllTabs({ urlPattern: '(' })).toMatchObject({ success: false, error: expect.stringMatching(/^Invalid urlPattern/) });
    expect(await findTabs({ urlPattern: '[' })).toMatchObject({ success: false });
  });

  it('findTabs combines url prefix, title (any case), active and the scope', async () => {
    installFakeBrowser();
    expect((await findTabs({ url: 'https://app.' }))['count']).toBe(2);
    expect((await findTabs({ title: 'MAIL' }))['count']).toBe(1);
    expect((await findTabs({ title: 'mail' }, SCOPE))['count']).toBe(0);
    const active = await findTabs({ active: true }, SCOPE);
    expect((active['tabs'] as { id: number }[]).map((t) => t.id)).toEqual([1]);
  });

  it('createNewTab puts the tab into the scope container, creating it when missing', async () => {
    const spies = installFakeBrowser();
    await createNewTab({ url: 'https://app.example.test/' }, SCOPE);
    expect(spies.create).toHaveBeenLastCalledWith({ url: 'https://app.example.test/', active: true, cookieStoreId: AGENT });

    await createNewTab({ active: false }, { containerName: 'agent', cookieStoreId: null });
    expect(spies.createContainer).toHaveBeenCalledTimes(1);
    expect(spies.create).toHaveBeenLastCalledWith({ url: 'about:blank', active: false, cookieStoreId: 'c-new' });

    const plain = await createNewTab({});
    expect(spies.create).toHaveBeenLastCalledWith({ url: 'about:blank', active: true });
    expect(plain).toMatchObject({ success: true, tab: { id: 9 }, url: 'about:blank' });
  });

  it('closeTab reports the closed id, and a failure as a result', async () => {
    const spies = installFakeBrowser();
    expect(await closeTab(2)).toEqual({ success: true, closed: 2 });
    expect(spies.remove).toHaveBeenCalledWith(2);
    spies.remove.mockRejectedValueOnce(new Error('Invalid tab ID: 99'));
    expect(await closeTab(99)).toEqual({ success: false, error: 'Invalid tab ID: 99' });
  });

  it('focusTab activates the tab and focuses its window; getTabInfo survives a missing content script', async () => {
    const spies = installFakeBrowser();
    expect(await focusTab(2)).toEqual({ success: true });
    expect(spies.update).toHaveBeenCalledWith(2, { active: true });
    expect(spies.windowsUpdate).toHaveBeenCalledWith(2, { focused: true });

    const info = await getTabInfo(1);
    expect(info).toMatchObject({ success: true, tab: { id: 1, url: 'https://app.example.test/a' }, window: { id: 1 } });
    expect(info['pageInfo']).toEqual({ error: 'Content script not available' });
    expect(await getTabInfo(99)).toMatchObject({ success: false, error: 'Invalid tab ID: 99' });
  });

  it('findText searches the pinned tab, and fails without one', async () => {
    const spies = installFakeBrowser();
    expect(await findText(undefined, { query: 'x' })).toEqual({ success: false, error: 'No target tab' });
    const r = await findText(TABS[0], { query: 'Buy' });
    expect(spies.find).toHaveBeenCalledWith('Buy', {
      tabId: 1, caseSensitive: false, entireWord: false, includeRangeData: true, includeRectData: false,
    });
    expect(r).toMatchObject({ success: true, count: 2, rectData: undefined });
    const withRects = await findText(TABS[0], { query: 'Buy', includeRectData: true });
    expect(withRects['rectData']).toEqual([{ r: 1 }]);
  });
});
