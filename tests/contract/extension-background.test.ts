/**
 * Extension background (background.ts and background/*.ts): routing and
 * robustness fixes of WP5 (review 3.A2-A9, 5.2, 5.7, 3.security). Functions
 * of the side-effect-free modules under background/ are imported directly;
 * the rest is checked on the source text (helpers/extension-source.ts).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileUrlRules } from '../../packages/extension/src/url-rule.ts';
import { checkListedTarget } from '../../packages/extension/src/background/url-policy.ts';
import { navigateHistory } from '../../packages/extension/src/background/navigation.ts';
import {
  captureTabsWithin,
  takeScreenshot,
  screenshotAllTabs,
} from '../../packages/extension/src/background/screenshot.ts';
import {
  describeNativeMessage,
  nextReconnectAttempts,
} from '../../packages/extension/src/background/native-connection.ts';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';
import { registerListeners } from '../../packages/extension/src/background/listeners.ts';
import { readExtensionSource, readExtensionTree } from './helpers/extension-source.js';

const background = readExtensionTree('background');

/** A tab with only the fields a test needs. */
const fakeTab = (fields: { id: number; url?: string; cookieStoreId?: string }): browser.tabs.Tab =>
  fields as browser.tabs.Tab;

/** A host rule over a whole domain tree, in the wire form the server sends. */
const hostRule = (host: string): Record<string, unknown> =>
  ({ kind: 'host', source: host, scheme: null, hosts: 'tree', host, path: null, pathMatch: 'loose' });

/** Install a fake `browser` global for one test (afterEach removes it). */
const useFakeBrowser = (fake: unknown): void => {
  (globalThis as { browser?: unknown }).browser = fake;
};

// ---------------------------------------------------------------------------
// Fake browser.tabs events for waitForTabLoad
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

function fakeEvent(): { addListener(fn: Listener): void; removeListener(fn: Listener): void; fire(...a: unknown[]): void; size(): number } {
  const listeners = new Set<Listener>();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    fire: (...a) => { for (const fn of [...listeners]) fn(...a); },
    size: () => listeners.size,
  };
}

function fakeTabs(initial: { status: string; url: string }) {
  const tab = { id: 7, ...initial };
  return {
    tab,
    onUpdated: fakeEvent(),
    onRemoved: fakeEvent(),
    get: vi.fn(async () => ({ ...tab })),
  };
}

type WaitForTabLoad = (
  tabs: unknown,
  tabId: number,
  trigger: () => Promise<unknown>,
  isLoaded: (tab: { status: string }) => boolean,
  options: { timeoutMs: number; settleMs: number; requireLoading: boolean },
) => Promise<'complete' | 'timeout' | 'removed'>;

let waitForTabLoad: WaitForTabLoad;

beforeAll(async () => {
  // Fake tabs / tab objects: typed by the test's own alias.
  waitForTabLoad = (await import('../../packages/extension/src/background/tab-wait.ts')).waitForTabLoad as unknown as WaitForTabLoad;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { browser?: unknown }).browser;
});

describe('3.A6 / 5.11 waitForTabLoad', () => {
  it('ignores a "complete" left over from the previous page and fails on timeout', async () => {
    vi.useFakeTimers();
    const tabs = fakeTabs({ status: 'complete', url: 'https://old.test/' });
    const done = waitForTabLoad(tabs, 7, async () => {
      // stale event of the old document, before the new load starts
      tabs.onUpdated.fire(7, { status: 'complete' }, { ...tabs.tab });
      tabs.tab.status = 'loading';
    }, (t) => t.status === 'complete', { timeoutMs: 5_000, settleMs: 1_000, requireLoading: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toBe('timeout');
    expect(tabs.onUpdated.size()).toBe(0);
    expect(tabs.onRemoved.size()).toBe(0);
  });

  it('completes after loading → complete, and reports a closed tab as removed', async () => {
    const tabs = fakeTabs({ status: 'complete', url: 'https://old.test/' });
    const opts = { timeoutMs: 5_000, settleMs: 1_000, requireLoading: true };
    const loaded = waitForTabLoad(tabs, 7, async () => {
      tabs.onUpdated.fire(7, { status: 'loading' }, { ...tabs.tab, status: 'loading' });
      tabs.onUpdated.fire(7, { status: 'complete' }, { ...tabs.tab, status: 'complete' });
    }, (t) => t.status === 'complete', opts);
    await expect(loaded).resolves.toBe('complete');

    const closed = waitForTabLoad(tabs, 7, async () => {
      tabs.onUpdated.fire(7, { status: 'loading' }, { ...tabs.tab, status: 'loading' });
      tabs.onRemoved.fire(7, {});
    }, (t) => t.status === 'complete', opts);
    await expect(closed).resolves.toBe('removed');
  });

  it('settles on the current state when no load starts within settleMs', async () => {
    vi.useFakeTimers();
    const opts = { timeoutMs: 5_000, settleMs: 1_000, requireLoading: true };
    // Same-document navigation: nothing loads, the tab is already complete.
    const settled = fakeTabs({ status: 'complete', url: 'https://same.test/#a' });
    const done = waitForTabLoad(settled, 7, async () => {}, (t) => t.status === 'complete', opts);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBe('complete');
    expect(settled.onUpdated.size()).toBe(0);

    // Still loading at the settle point: the wait runs into its timeout.
    const slow = fakeTabs({ status: 'loading', url: 'https://slow.test/' });
    const late = waitForTabLoad(slow, 7, async () => {}, (t) => t.status === 'complete', opts);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(late).resolves.toBe('timeout');
  });

  it('requireLoading false: the current state counts at once', async () => {
    const tabs = fakeTabs({ status: 'complete', url: 'https://new.test/' });
    const done = waitForTabLoad(tabs, 7, async () => {}, (t) => t.status === 'complete', {
      timeoutMs: 5_000, settleMs: 1_000, requireLoading: false,
    });
    await expect(done).resolves.toBe('complete');
    expect(tabs.get).toHaveBeenCalledTimes(1);
    expect(tabs.onUpdated.size()).toBe(0);
  });

  it('a trigger that rejects rejects the wait and removes the listeners', async () => {
    const tabs = fakeTabs({ status: 'complete', url: 'https://x.test/' });
    const done = waitForTabLoad(tabs, 7, async () => { throw new Error('tabs.reload failed'); },
      (t) => t.status === 'complete', { timeoutMs: 5_000, settleMs: 1_000, requireLoading: true });
    await expect(done).rejects.toThrow('tabs.reload failed');
    expect(tabs.onUpdated.size()).toBe(0);
    expect(tabs.onRemoved.size()).toBe(0);
  });
});

describe('3.A4 handleCommand end to end (fake browser)', () => {
  const agentTab = fakeTab({ id: 1, url: 'https://app.example.test/page', cookieStoreId: 'c-agent' });
  const bankTab = fakeTab({ id: 2, url: 'https://bank.example.test/', cookieStoreId: 'c-agent' });
  const outsideTab = fakeTab({ id: 3, url: 'https://app.example.test/other', cookieStoreId: 'firefox-default' });
  const scopeMessage = { containerScope: { containerName: 'agent' } };

  /**
   * A `browser` whose active tab is `active[0]` for the first query and
   * `active[1]` afterwards -- the tab the agent targets moves away right
   * after handleCommand pinned it.
   */
  function dispatcherBrowser(active: browser.tabs.Tab[]): {
    sent: { tabId: number; frameId: number }[];
    queries: () => number;
  } {
    const sent: { tabId: number; frameId: number }[] = [];
    let queries = 0;
    useFakeBrowser({
      contextualIdentities: { query: async () => [{ name: 'agent', cookieStoreId: 'c-agent' }] },
      tabs: {
        query: async () => [active[Math.min(queries++, active.length - 1)]],
        get: async (id: number) => [agentTab, bankTab, outsideTab].find((t) => t.id === id),
        sendMessage: async (tabId: number, _m: unknown, o: { frameId: number }) => {
          sent.push({ tabId, frameId: o.frameId });
          return {};
        },
      },
    });
    return { sent, queries: () => queries };
  }

  it('pins the target tab: checks, handler and URL report use it after the active tab changed', async () => {
    const { sent, queries } = dispatcherBrowser([agentTab, bankTab]);
    const result = await handleCommand({
      action: 'get_page_info',
      ...scopeMessage,
      confirmReadUrlRules: [hostRule('bank.example.test')],
    }, 'host');
    expect(result).toMatchObject({ success: true, tab: { id: 1 }, url: agentTab.url });
    expect(sent).toEqual([{ tabId: 1, frameId: 0 }]);
    // The active tab is asked for once; the URL report goes to the pinned id.
    expect(queries()).toBe(1);
  });

  it('refuses on the pinned tab, not on whichever tab became active', async () => {
    const { sent } = dispatcherBrowser([bankTab, agentTab]);
    // Approved for the site of the tab that becomes active, not the pinned one.
    const result = await handleCommand({
      action: 'click',
      ...scopeMessage,
      approvedHost: 'app.example.test',
    }, 'host');
    expect(result).toMatchObject({
      success: false,
      safetyDecision: 'confirmation_required',
      url: bankTab.url,
    });
    expect(sent).toEqual([]);
  });

  it('refuses a pinned tab outside the container scope before any handler runs', async () => {
    const { sent } = dispatcherBrowser([outsideTab, agentTab]);
    const result = await handleCommand({ action: 'click', ...scopeMessage }, 'host');
    expect(result).toMatchObject({ success: false, safetyDecision: 'out_of_scope' });
    expect(result.error).toMatch(/outside the container scope/);
    expect(sent).toEqual([]);
  });

  // approvedHost lets one approved call through on exactly that host.
  describe('approvedHost (a human approved this call for one hostname)', () => {
    const subdomainTab = fakeTab({ id: 4, url: 'https://pay.bank.example.test/', cookieStoreId: 'c-agent' });
    // An acting command: the Extension asks for the approval itself, no rule attached.
    const actingMessage = { ...scopeMessage };

    /** dispatcherBrowser, with the subdomain tab known to tabs.get as well. */
    function approvalBrowser(active: browser.tabs.Tab): { tabId: number; frameId: number }[] {
      const { sent } = dispatcherBrowser([active]);
      const fake = (globalThis as unknown as { browser: { tabs: { get: (id: number) => Promise<unknown> } } }).browser;
      const get = fake.tabs.get;
      fake.tabs.get = async (id: number) => (id === subdomainTab.id ? subdomainTab : get(id));
      return sent;
    }

    it('the approved host: the handler runs on that tab', async () => {
      const sent = approvalBrowser(bankTab);
      const result = await handleCommand({ action: 'click', ...actingMessage, approvedHost: 'bank.example.test' }, 'host');
      expect(result.safetyDecision).toBeUndefined();
      expect(sent).toEqual([{ tabId: 2, frameId: 0 }]);
    });

    it('a subdomain or another host: confirmation_required, no handler', async () => {
      for (const [active, approvedHost] of [
        [subdomainTab, 'bank.example.test'],
        [bankTab, 'pay.bank.example.test'],
        [bankTab, 'other.example.test'],
        [bankTab, 'example.test'],
      ] as const) {
        const sent = approvalBrowser(active);
        const result = await handleCommand({ action: 'click', ...actingMessage, approvedHost }, 'host');
        expect(result, `${active.url} / ${approvedHost}`).toMatchObject({
          success: false,
          safetyDecision: 'confirmation_required',
          url: active.url,
        });
        expect(sent).toEqual([]);
      }
    });

  });
});

describe('WP38 no active tab: a failure result, not a TypeError', () => {
  it('get_page_info answers "No target tab" when tabs.query finds none', async () => {
    useFakeBrowser({
      tabs: {
        query: async () => [],
        sendMessage: async () => { throw new Error('nothing may be sent'); },
      },
    });
    const { getPageInfo } = await import('../../packages/extension/src/background/page-actions.ts');
    expect(await getPageInfo(undefined)).toEqual({ success: false, error: 'No target tab' });
    expect(await handleCommand({ action: 'get_page_info' }, 'host')).toEqual({ success: false, error: 'No target tab' });
  });
});

describe('E-21 get_page_info fails like the other content script tools', () => {
  const pageTab = { id: 1, url: 'https://app.example.test/', title: 'App' };
  const failingSend = (message: string) => ({
    tabs: {
      query: async () => [pageTab],
      get: async () => pageTab,
      sendMessage: async () => { throw new Error(message); },
    },
  });

  it('no content script: the same explanation as get_elements', async () => {
    useFakeBrowser(failingSend('Could not establish connection. Receiving end does not exist.'));
    const { getPageInfo } = await import('../../packages/extension/src/background/page-actions.ts');
    const pageInfo = await getPageInfo(undefined);
    expect(pageInfo).toMatchObject({ success: false, error: expect.stringMatching(/^Inari MCP cannot reach this page/) });
    expect(pageInfo).toEqual(await handleCommand({ action: 'get_elements' }, 'host'));
  });

  it('any other failure keeps its own text', async () => {
    useFakeBrowser(failingSend('Message manager disconnected'));
    const { getPageInfo } = await import('../../packages/extension/src/background/page-actions.ts');
    expect(await getPageInfo(undefined)).toEqual({ success: false, error: 'Message manager disconnected' });
  });
});

describe('WP30 go_back / go_forward wait for the load like navigate', () => {
  it('returns the URL after the history load completes, not after a fixed delay', async () => {
    vi.useFakeTimers();
    const tabs = fakeTabs({ status: 'complete', url: 'https://b.test/' });
    const goBack = vi.fn(async () => {
      tabs.tab.status = 'loading';
      tabs.tab.url = 'https://a.test/';
      tabs.onUpdated.fire(7, { status: 'loading' }, { ...tabs.tab });
    });
    (globalThis as { browser?: unknown }).browser = {
      tabs: { ...tabs, query: async () => [{ ...tabs.tab, active: true }], goBack },
    };
    try {
      let settled = false;
      const run = navigateHistory(7, 'back').finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(5_000); // slow page: still loading
      expect(settled).toBe(false);
      tabs.tab.status = 'complete';
      tabs.onUpdated.fire(7, { status: 'complete' }, { ...tabs.tab });
      await expect(run).resolves.toMatchObject({ success: true, url: 'https://a.test/' });
      expect(goBack).toHaveBeenCalledWith(7);
      expect(tabs.onUpdated.size()).toBe(0);
    } finally {
      delete (globalThis as { browser?: unknown }).browser;
    }
  });
});

describe('3.A2 reconnect backoff', () => {
  it('starts over only after a confirmed connection stayed up for the stable period', async () => {
    const next = nextReconnectAttempts;
    expect(next(4, null, 10_000)).toBe(4); // host never answered
    expect(next(4, 2_000, 10_000)).toBe(4); // crashed right after answering
    expect(next(4, 10_000, 10_000)).toBe(0);
    // That connectNative() itself does not reset the counter is run on fake
    // ports in extension-background-async.test.ts (E-7).
  });
});

describe('3.A3 / 5.1 frame routing', () => {
  it('every tabs.sendMessage call names the top frame, the only one with the content script', () => {
    const calls = [...background.matchAll(/browser\.tabs\s*\.sendMessage\(([\s\S]*?)\)(?:\s*as|\s*\.|;)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [call] of calls) expect(call, call).toMatch(/\{ frameId: TOP_FRAME_ID \}/);
  });
});

describe('3.A5 capture of the target tab', () => {
  // takeScreenshot itself is run in 'WP30 screenshot of a background tab' below.
  it('no background source calls captureVisibleTab(windowId)', () => {
    expect(background).not.toMatch(/\.captureVisibleTab\(/);
  });
});

describe('WP30 screenshot of a background tab keeps the active tab', () => {
  it('captures the tabId given without tabs.update; a discarded tab fails', async () => {
    const update = vi.fn(async () => ({}));
    const captureTab = vi.fn(async (id: number) => `data:image/png;base64,${id}`);
    const tabsById: Record<number, Record<string, unknown>> = {
      1: { id: 1, url: 'https://a.test/', active: true, discarded: false },
      2: { id: 2, url: 'https://b.test/', active: false, discarded: false },
      3: { id: 3, url: 'https://c.test/', active: false, discarded: true },
    };
    (globalThis as { browser?: unknown }).browser = {
      tabs: {
        query: async () => [tabsById[1]],
        get: async (id: number) => tabsById[id],
        update,
        captureTab,
      },
    };
    try {
      const shot = await takeScreenshot(2, {});
      expect(shot).toMatchObject({ success: true, type: 'visible', tab: { id: 2 } });
      expect(captureTab).toHaveBeenCalledWith(2, expect.anything());
      const discarded = await takeScreenshot(3, {});
      expect(discarded).toMatchObject({ success: false, error: expect.stringMatching(/discarded/) });
      expect(captureTab).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { browser?: unknown }).browser;
    }
  });
  // TODO(test): in a real Firefox: captureTab of a loaded background tab
  //   (same / other window) returns that tab's image, not a blank one.
});

describe('WP5b URL rules and urlPattern arguments', () => {
  it('refuses a target tab on a blocked or not allowlisted site, fails closed without a tab', async () => {
    const host = (h: string, pathMatch: string) =>
      ({ kind: 'host', source: h, scheme: null, hosts: 'tree', host: h, path: null, pathMatch });
    const lists = {
      blocked: compileUrlRules([host('blocked.test', 'loose')]).rules,
      allowed: compileUrlRules([host('ok.test', 'strict')]).rules,
      allowlistActive: true,
    };
    expect(checkListedTarget(fakeTab({ id: 1, url: 'https://www.blocked.test/x' }), lists))
      .toMatchObject({ success: false, safetyDecision: 'blocked_url', url: 'https://www.blocked.test/x' });
    expect(checkListedTarget(fakeTab({ id: 1, url: 'https://other.test/' }), lists))
      .toMatchObject({ success: false, safetyDecision: 'not_allowlisted' });
    expect(checkListedTarget(fakeTab({ id: 1, url: 'https://ok.test/' }), lists)).toBeNull();
    expect(checkListedTarget(fakeTab({ id: 1, url: 'about:blank' }), lists)).toBeNull();
    expect(checkListedTarget(undefined, lists)).toMatchObject({ success: false });
  });

  it('urlPatternArg: an invalid urlPattern is a failure result, a valid one is case-sensitive', async () => {
    const { urlPatternArg } = await import('../../packages/extension/src/background/tab-wait.ts');
    expect(urlPatternArg('(')).toMatchObject({ ok: false, result: { success: false, error: expect.stringMatching(/^Invalid urlPattern/) } });
    expect(urlPatternArg(undefined)).toEqual({ ok: true, pattern: null });
    const valid = urlPatternArg('a\\.test');
    expect(valid.ok && valid.pattern?.flags).toBe('');
  });

  it('close_tab reports the closed tab id, without a URL', async () => {
    const tab = fakeTab({ id: 5, url: 'https://ok.test/' });
    const removed: number[] = [];
    useFakeBrowser({
      tabs: {
        get: async () => tab,
        remove: async (id: number) => { removed.push(id); },
      },
    });
    expect(await handleCommand({ action: 'close_tab', tabId: 5, approvedHost: 'ok.test' }, 'host'))
      .toEqual({ success: true, closed: 5 });
    expect(removed).toEqual([5]);
  });
  it('url-rule.ts is bundled into background.js, which the manifest loads; nothing injects content.js', () => {
    const manifest = JSON.parse(readExtensionSource('../manifest.json')) as {
      background: { scripts: string[] };
      content_scripts: { js: string[] }[];
    };
    expect(manifest.background.scripts).toEqual(['dist/background.js']);
    expect(manifest.content_scripts[0]!.js).toEqual(['dist/content.js']);
    expect(background).toMatch(/^import \{[^}]*\bfindUrlRule\b[^}]*\} from "\.\.?\/url-rule";$/m);
    // The content script only answers commands: it checks no URL rule itself.
    expect(readExtensionTree('content')).not.toMatch(/from "\.\.?\/url-rule"/);
    expect(background).not.toMatch(/\.executeScript\(/);
  });

  it('refuses a command whose URL rules could not all be used (config_error)', async () => {
    const tab = fakeTab({ id: 1, url: 'https://ok.test/' });
    useFakeBrowser({
      tabs: {
        query: async () => [tab],
        get: async () => tab,
        sendMessage: async () => { throw new Error('the handler must not run'); },
      },
    });
    const result = await handleCommand({
      action: 'click',
      // 42 is not a rule: an unusable entry must not silently narrow the policy.
      confirmReadUrlRules: [hostRule('bank.test'), 42],
    }, 'host');
    expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
    expect(result.error).toMatch(/1 URL pattern\(s\)/);
  });

  it('checks the blocked / allowed lists before the approval', async () => {
    const tab = fakeTab({ id: 1, url: 'https://bank.test/pay' });
    useFakeBrowser({
      tabs: {
        query: async () => [tab],
        get: async () => tab,
        sendMessage: async () => { throw new Error('the handler must not run'); },
      },
    });
    const result = await handleCommand({
      action: 'click',
      blockedUrlRules: [hostRule('bank.test')],
    }, 'host');
    expect(result).toMatchObject({ success: false, safetyDecision: 'blocked_url' });
  });

  it('screenshot all_tabs skips list-violating tabs (excludedBlocked)', async () => {
    const tabs = [
      fakeTab({ id: 1, url: 'https://ok.test/' }),
      fakeTab({ id: 2, url: 'https://blocked.test/' }),
    ];
    const captured: number[] = [];
    useFakeBrowser({
      tabs: {
        query: async () => tabs,
        captureTab: async (id: number) => { captured.push(id); return `data:${id}`; },
      },
    });
    const blockedUrlRules = [hostRule('blocked.test')];
    expect(await handleCommand({ action: 'screenshot_all_tabs', blockedUrlRules }, 'host'))
      .toMatchObject({ success: true, count: 1, failed: 0, excludedBlocked: 1, excludedReadSites: 0 });
    expect(captured).toEqual([1]);
  });

  it('WP38 both excluded counts are always there, 0 included', async () => {
    const tabs = [fakeTab({ id: 1, url: 'https://ok.test/' })];
    useFakeBrowser({
      tabs: {
        query: async () => tabs,
        captureTab: async (id: number) => `data:${id}`,
      },
    });
    const result = await handleCommand({ action: 'screenshot_all_tabs' }, 'host');
    expect(result).toMatchObject({ success: true, excludedBlocked: 0, excludedReadSites: 0 });
    expect(result).not.toHaveProperty('excludedBlockedReason');
    expect(result).not.toHaveProperty('excludedReadSitesReason');
  });

  it('screenshot all_tabs skips confirm_read_sites tabs with excludedReadSitesReason', async () => {
    const tabs = [
      fakeTab({ id: 1, url: 'https://ok.test/' }),
      fakeTab({ id: 2, url: 'https://bank.test/' }),
    ];
    const captured: number[] = [];
    useFakeBrowser({
      tabs: {
        query: async () => tabs,
        captureTab: async (id: number) => { captured.push(id); return `data:${id}`; },
      },
    });
    const result = await handleCommand({ action: 'screenshot_all_tabs', confirmReadUrlRules: [hostRule('bank.test')] }, 'host');
    expect(result).toMatchObject({
      success: true,
      count: 1,
      excludedBlocked: 0,
      excludedReadSites: 1,
      excludedReadSitesReason: expect.stringContaining('confirm_read_sites'),
    });
    expect(result).not.toHaveProperty('excludedReason');
    expect(captured).toEqual([1]);
  });
});

describe('E-4 runtime.onMessage sender checks (fake browser)', () => {
  const EXTENSION_ID = 'inari@test';
  const POPUP_URL = 'moz-extension://inari/popup/popup.html';
  type Listener = (message: unknown, sender: browser.runtime.MessageSender, sendResponse: (r: unknown) => void) => boolean | void;

  /** registerListeners() on a fake browser; `send` / `sendExternal` call its two message listeners. */
  function listenersBrowser(): {
    send: (message: unknown, sender: browser.runtime.MessageSender) => Promise<unknown>;
    sendExternal: (message: unknown, sender: browser.runtime.MessageSender) => unknown;
    tabQueries: () => number;
  } {
    let onMessage: Listener | undefined;
    let onExternal: Listener | undefined;
    let queries = 0;
    useFakeBrowser({
      runtime: {
        id: EXTENSION_ID,
        getURL: (p: string) => `moz-extension://inari${p}`,
        onMessage: { addListener: (fn: Listener) => { onMessage = fn; } },
        onMessageExternal: { addListener: (fn: Listener) => { onExternal = fn; } },
        onInstalled: { addListener: () => {} },
      },
      tabs: {
        query: async () => { queries++; return []; },
      },
    });
    registerListeners();
    const call = (fn: Listener | undefined, message: unknown, sender: browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (!fn) return reject(new Error('listener not registered'));
        fn(message, sender, resolve);
      });
    return {
      send: (message, sender) => call(onMessage, message, sender),
      sendExternal: (message, sender) => call(onExternal, message, sender),
      tabQueries: () => queries,
    };
  }

  const pageTab = fakeTab({ id: 4, url: 'https://app.example.test/' });
  /** A content script: this extension's id, but the web page's URL. */
  const contentScript: browser.runtime.MessageSender = { id: EXTENSION_ID, url: pageTab.url, tab: pageTab };
  /** The toolbar popup: an extension page outside any tab. */
  const popup: browser.runtime.MessageSender = { id: EXTENSION_ID, url: POPUP_URL };
  /** The popup page opened in a tab. */
  const popupInTab: browser.runtime.MessageSender = { ...popup, tab: fakeTab({ id: 9, url: POPUP_URL }) };

  const APPROVALS_REFUSED = { success: false, error: 'Approval requests are answered in the Inari MCP toolbar popup' };
  const COMMAND_REFUSED = { success: false, error: 'Background commands are only accepted from extension pages' };

  it('a content script can neither list nor decide approvals, nor drive the dispatcher', async () => {
    const { send, tabQueries } = listenersBrowser();
    expect(await send({ type: 'inari:approvals:list' }, contentScript)).toEqual(APPROVALS_REFUSED);
    expect(await send({ type: 'inari:approvals:decide', id: 'a', approved: true }, contentScript)).toEqual(APPROVALS_REFUSED);
    expect(await send({ target: 'background', action: 'noSuchAction' }, contentScript)).toEqual(COMMAND_REFUSED);
    // The dispatcher never ran: it would have looked for the target tab.
    expect(tabQueries()).toBe(0);
  });

  it('an extension page in a tab may list approvals but not decide one', async () => {
    const { send } = listenersBrowser();
    expect(await send({ type: 'inari:approvals:list' }, popupInTab)).toEqual({ success: true, approvals: [] });
    expect(await send({ type: 'inari:approvals:decide', id: 'a', approved: true }, popupInTab)).toEqual(APPROVALS_REFUSED);
  });

  it('the toolbar popup decides approvals and drives the dispatcher', async () => {
    const { send, tabQueries } = listenersBrowser();
    expect(await send({ type: 'inari:approvals:decide', id: 'a', approved: true }, popup))
      .toEqual({ success: false, error: 'This request is no longer pending' });
    // An unknown action gets the strictest row: the approval check (here
    // without any tab) refuses it before its handler would.
    expect(await send({ target: 'background', action: 'noSuchAction' }, popup))
      .toEqual({ success: false, error: 'Could not resolve the target tab for the approval check' });
    expect(tabQueries()).toBe(1);
  });

  it('a page with another extension id is not an extension page of ours', async () => {
    const { send } = listenersBrowser();
    expect(await send({ type: 'inari:approvals:list' }, { ...popup, id: 'other@test' })).toEqual(APPROVALS_REFUSED);
  });

  it('every external message is refused', async () => {
    const { sendExternal } = listenersBrowser();
    expect(await sendExternal({ target: 'background', action: 'status' }, { id: 'other@test' }))
      .toEqual({ success: false, error: 'External messages are not accepted' });
  });
});

describe('dispatcher refusals without a handler', () => {
  it('a known wire action the extension does not implement', async () => {
    useFakeBrowser({ tabs: { query: async () => { throw new Error('no tab lookup expected'); } } });
    expect(await handleCommand({ action: 'snapshot' }, 'host'))
      .toEqual({ success: false, error: 'Not implemented in extension: snapshot' });
  });

  it('a needsTabId action without an explicit tabId does not fall back to the active tab', async () => {
    const active = fakeTab({ id: 3, url: 'https://ok.test/' });
    const removed: number[] = [];
    useFakeBrowser({
      tabs: {
        query: async () => [active],
        get: async () => active,
        remove: async (id: number) => { removed.push(id); },
      },
    });
    expect(await handleCommand({ action: 'close_tab', approvedHost: 'ok.test' }, 'host'))
      .toEqual({ success: false, error: 'tabId is required' });
    expect(removed).toEqual([]);
  });
});

describe('5.7 screenshot all_tabs', () => {
  it('bounds each capture and skips tabs once the budget is used up', async () => {
    vi.useFakeTimers();
    const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }].map(fakeTab);
    const run = captureTabsWithin(
      tabs,
      (tab) => (tab.id === 1 ? new Promise<string>(() => {}) : Promise.resolve(`data:${tab.id}`)),
      { perTabMs: 3_000, budgetMs: 3_000, keepData: true },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const results = await run;
    expect(results[0]).toMatchObject({ tabId: 1, success: false, error: expect.stringMatching(/timed out/) });
    expect(results[1]).toMatchObject({ tabId: 2, success: false, skipped: true });
    expect(results[2]).toMatchObject({ tabId: 3, success: false, skipped: true });
  });

  it('saveToFile false: nothing is captured, every entry says imageSaved false', async () => {
    const tabs = [fakeTab({ id: 1, url: 'https://a.test/' }), fakeTab({ id: 2, url: 'https://b.test/' })];
    let captures = 0;
    useFakeBrowser({
      tabs: {
        query: async () => tabs,
        get: async (id: number) => tabs.find((t) => t.id === id),
        captureTab: async () => { captures++; return 'data:x'; },
      },
    });
    const all = await screenshotAllTabs({ saveToFile: false });
    expect(all).toMatchObject({ success: true, count: 0, failed: 0, excludedReadSites: 0 });
    expect(all.screenshots).toEqual([
      { tabId: 1, url: 'https://a.test/', title: '', imageSaved: false },
      { tabId: 2, url: 'https://b.test/', title: '', imageSaved: false },
    ]);
    expect(all.note).toMatch(/resource_link/);

    expect(await takeScreenshot(undefined, { saveToFile: false }))
      .toMatchObject({ success: true, type: 'visible', imageSaved: false, tab: { id: 1 } });
    expect(await takeScreenshot(2, { saveToFile: false, fullPage: true }))
      .toMatchObject({ success: true, type: 'fullPage', imageSaved: false, tab: { id: 2 } });
    expect(captures).toBe(0);
  });

  it('all_tabs fails when no tab could be captured, succeeds when there was none', async () => {
    const tabs = [fakeTab({ id: 1, url: 'https://a.test/' }), fakeTab({ id: 2, url: 'https://b.test/' })];
    useFakeBrowser({ tabs: { query: async () => tabs, captureTab: async () => { throw new Error('nope'); } } });
    const failedRun = await screenshotAllTabs({});
    expect(failedRun).toMatchObject({
      success: false, count: 0, failed: 2, error: expect.stringMatching(/No tab could be captured/),
    });
    expect(failedRun.screenshots).toMatchObject([{ success: false, error: 'nope' }, { success: false, error: 'nope' }]);

    useFakeBrowser({ tabs: { query: async () => [], captureTab: async () => 'data:x' } });
    expect(await screenshotAllTabs({})).toMatchObject({ success: true, count: 0, failed: 0 });
  });
});

describe('3.security native message logging', () => {
  it('logs action / requestId / key names, never values', async () => {
    const describe_ = describeNativeMessage;
    const line = describe_({ action: 'type', requestId: '9', data: { text: 'secret' } });
    expect(line).toContain('action=type');
    expect(line).toContain('data=[text]');
    expect(line).not.toContain('secret');
  });

  it('manifest: no redundant activeTab, no web_accessible_resources', () => {
    const manifest = JSON.parse(readExtensionSource('../manifest.json')) as Record<string, unknown>;
    expect(manifest['permissions']).not.toContain('activeTab');
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });

  it('manifest: the content script runs in the top frame only and puts no stylesheet into pages', () => {
    const manifest = JSON.parse(readExtensionSource('../manifest.json')) as {
      content_scripts: Record<string, unknown>[];
    };
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0]).toMatchObject({ all_frames: false });
    expect(manifest.content_scripts[0]).not.toHaveProperty('css');
    // The highlight overlay is styled on the element itself (no class to probe for).
    expect(readExtensionTree('content')).not.toMatch(/\.className\s*=(?!=)|classList\.add\(/);
  });

  it('manifest: declares websiteContent, browsingActivity and websiteActivity', () => {
    const manifest = JSON.parse(readExtensionSource('../manifest.json')) as {
      browser_specific_settings: { gecko: { data_collection_permissions: { required: string[] } } };
    };
    // Page text and form values, the URLs and tab list, and the clicks and typing it performs.
    expect([...manifest.browser_specific_settings.gecko.data_collection_permissions.required].sort())
      .toEqual(['browsingActivity', 'websiteActivity', 'websiteContent']);
  });
});
