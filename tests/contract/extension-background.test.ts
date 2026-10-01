/**
 * Extension background (background.ts and background/*.ts): routing and
 * robustness fixes of WP5 (review 3.A2-A9, 5.2, 5.7, 3.security). Functions
 * of the side-effect-free modules under background/ are imported directly;
 * the rest is checked on the source text (helpers/extension-source.ts).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileUrlRules, type CompiledUrlRule } from '../../packages/extension/src/url-rule.ts';
import { checkListedTarget } from '../../packages/extension/src/background/url-policy.ts';
import {
  reloadMatchingTabs,
  reloadAllTabs,
  reloadTabsByUrl,
} from '../../packages/extension/src/background/reload.ts';
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
import { ACTION_TABLE } from '../../packages/extension/src/background/action-table.ts';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';
import { registerListeners } from '../../packages/extension/src/background/listeners.ts';
import {
  startLoggingOnTab,
  stopLoggingOnTab,
  getLogsOfTab,
  clearLogsOfTab,
} from '../../packages/extension/src/background/logging.ts';
import { LOG_RECORD_MESSAGE, TOP_FRAME_ID } from '../../packages/extension/src/background/constants.ts';
import { readExtensionSource, readExtensionTree } from './helpers/extension-source.js';

const background = readExtensionTree('background');

const NO_LISTS = { blocked: [], allowed: [], allowlistActive: false };

/** A tab with only the fields a test needs. */
const fakeTab = (fields: { id: number; url?: string; cookieStoreId?: string }): browser.tabs.Tab =>
  fields as browser.tabs.Tab;

/** A host rule over a whole domain tree, in the wire form the server sends. */
const hostRule = (host: string): Record<string, unknown> =>
  ({ kind: 'host', source: host, scheme: null, hosts: 'tree', host, path: null, pathMatch: 'loose' });

/** The same, compiled. */
const hostRules = (...hosts: string[]): CompiledUrlRule[] => compileUrlRules(hosts.map(hostRule)).rules;

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
      protectedUrlRules: [hostRule('bank.example.test')],
    });
    expect(result).toMatchObject({ success: true, tab: { id: 1 }, url: agentTab.url });
    expect(sent).toEqual([{ tabId: 1, frameId: 0 }]);
    // The active tab is asked for once; the URL report goes to the pinned id.
    expect(queries()).toBe(1);
  });

  it('refuses on the pinned tab, not on whichever tab became active', async () => {
    const { sent } = dispatcherBrowser([bankTab, agentTab]);
    const result = await handleCommand({
      action: 'click',
      ...scopeMessage,
      protectedUrlRules: [hostRule('bank.example.test')],
    });
    expect(result).toMatchObject({
      success: false,
      safetyDecision: 'confirmation_required',
      url: bankTab.url,
      matchedPattern: 'bank.example.test',
    });
    expect(sent).toEqual([]);
  });

  it('refuses a pinned tab outside the container scope before any handler runs', async () => {
    const { sent } = dispatcherBrowser([outsideTab, agentTab]);
    const result = await handleCommand({ action: 'click', ...scopeMessage });
    expect(result).toMatchObject({ success: false, safetyDecision: 'out_of_scope' });
    expect(result.error).toMatch(/outside the container scope/);
    expect(sent).toEqual([]);
  });
});

describe('WP38 no active tab: a failure result, not a TypeError', () => {
  it('get_page_info and execute_script answer "No target tab" when tabs.query finds none', async () => {
    useFakeBrowser({
      tabs: {
        query: async () => [],
        sendMessage: async () => { throw new Error('nothing may be sent'); },
        executeScript: async () => { throw new Error('nothing may run'); },
      },
    });
    const { getPageInfo, executeScript } = await import('../../packages/extension/src/background/page-actions.ts');
    expect(await getPageInfo(undefined)).toEqual({ success: false, error: 'No target tab' });
    expect(await executeScript(undefined, { script: '1' })).toEqual({ success: false, error: 'No target tab' });
    expect(await handleCommand({ action: 'get_page_info' })).toEqual({ success: false, error: 'No target tab' });
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
    // connectNative() itself no longer resets the counter
    const connect = /function connectNativeHost\(\)[\s\S]*?\n}\n/.exec(background)![0];
    expect(connect).not.toMatch(/reconnectAttempts\s*=\s*0/);
  });
});

describe('3.A3 / 5.1 frame routing', () => {
  it('every tabs.sendMessage call names a frame', () => {
    const calls = [...background.matchAll(/browser\.tabs\s*\.sendMessage\(([\s\S]*?)\)(?:\s*as|\s*\.|;)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [call] of calls) expect(call, call).toMatch(/frameId/);
    expect(background).toMatch(/frameId: number = TOP_FRAME_ID/);
  });
});

describe('3.A4 target tab resolved once', () => {
  it('handleCommand resolves the tab once and hands it to both checks', () => {
    const start = background.indexOf('async function handleCommand(');
    const body = background.slice(start, background.indexOf('\n}\n', start));
    expect(body.match(/resolveTab\(/g)).toHaveLength(2); // the pin + the post-op URL report on the pinned id
    expect(body).toMatch(/enforceContainerScope\(selfScoped, target, containerScope\)/);
    expect(body).toMatch(/checkProtectedTarget\(target, protectedPatterns, approvedHost\)/);
  });
});

describe('3.A5 capture of the target tab', () => {
  it('uses captureTab(tabId), never captureVisibleTab(windowId)', () => {
    expect(background).not.toMatch(/\.captureVisibleTab\(/);
    expect(background).toMatch(/browser\.tabs\.captureTab\(targetTab\.id,/);
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

describe('3.A8 reload_all / reload_by_url skip protected tabs', () => {
  it('reloads only unprotected in-scope tabs and reports the excluded count', async () => {
    const reloaded: number[] = [];
    (globalThis as { browser?: unknown }).browser = {
      tabs: {
        query: async () => [
          { id: 1, url: 'https://news.example.test/' },
          { id: 2, url: 'https://bank.example.test/' },
        ],
        reload: async (id: number) => { reloaded.push(id); },
      },
    };
    try {
      const protectedRules = compileUrlRules([
        { kind: 'host', source: 'bank.example.test', scheme: null, hosts: 'tree', host: 'bank.example.test', path: null, pathMatch: 'loose' },
      ]).rules;
      const result = await reloadMatchingTabs(() => true, false, null, protectedRules, NO_LISTS);
      expect(reloaded).toEqual([1]);
      expect(result).toMatchObject({ success: true, reloadedCount: 1, excludedProtected: 1 });
    } finally {
      delete (globalThis as { browser?: unknown }).browser;
    }
    expect(ACTION_TABLE.get('reloadAll')?.protectedCheck).toBe('handler');
    expect(ACTION_TABLE.get('reloadByUrl')?.protectedCheck).toBe('handler');
  });
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

  it('an invalid urlPattern is a failure result, a valid one is case-sensitive', async () => {
    const { urlPatternArg } = await import('../../packages/extension/src/background/tab-wait.ts');
    expect(urlPatternArg('(')).toMatchObject({ ok: false, result: { success: false, error: expect.stringMatching(/^Invalid urlPattern/) } });
    expect(urlPatternArg(undefined)).toEqual({ ok: true, pattern: null });
    const valid = urlPatternArg('a\\.test');
    expect(valid.ok && valid.pattern!.flags).toBe('');
    // Every RegExp built from an argument goes through urlPatternArg (or
    // its own try/catch in queryNetworkLogs).
    expect(background.match(/new RegExp\(/g)).toHaveLength(2);
  });

  it('close_tab reports the closed tab id; rules are preferred over legacy patterns', () => {
    expect(background).toMatch(/return \{ success: true, closed: tabId \}/);
    expect(background).toMatch(/Array\.isArray\(message\.protectedUrlRules\)\s*\?\s*message\.protectedUrlRules\s*:\s*message\.protectedUrlPatterns/);
  });
  it('url-rule.ts is bundled into background.js and content.js (manifest and early injection load one file)', () => {
    const manifest = JSON.parse(readExtensionSource('../manifest.json')) as {
      background: { scripts: string[] };
      content_scripts: { js: string[] }[];
    };
    expect(manifest.background.scripts).toEqual(['dist/background.js']);
    expect(manifest.content_scripts[0]!.js).toEqual(['dist/content.js']);
    expect(background).toMatch(/^import \{[^}]*\bfindUrlRule\b[^}]*\} from "\.\.?\/url-rule";$/m);
    expect(readExtensionTree('content')).toMatch(/^import \{[^}]*\bfindUrlRule\b[^}]*\} from "\.\.?\/url-rule";$/m);
    // The early injection runs content.js alone, once.
    const files = [...background.matchAll(/executeScript\([^)]*\bfile: "([^"]+)"/g)].map((m) => m[1]);
    expect(files).toEqual(['/dist/content.js']);
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
      protectedUrlRules: [hostRule('bank.test'), 42],
    });
    expect(result).toMatchObject({ success: false, safetyDecision: 'config_error' });
    expect(result.error).toMatch(/1 URL pattern\(s\)/);
  });

  it('checks the blocked / allowed lists before the protected domains', async () => {
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
      protectedUrlRules: [hostRule('bank.test')],
    });
    expect(result).toMatchObject({ success: false, safetyDecision: 'blocked_url' });
  });

  it('screenshot all_tabs and reload_all skip list-violating tabs (excludedBlocked)', async () => {
    const tabs = [
      fakeTab({ id: 1, url: 'https://ok.test/' }),
      fakeTab({ id: 2, url: 'https://blocked.test/' }),
    ];
    const captured: number[] = [];
    const reloaded: number[] = [];
    useFakeBrowser({
      tabs: {
        query: async () => tabs,
        captureTab: async (id: number) => { captured.push(id); return `data:${id}`; },
        reload: async (id: number) => { reloaded.push(id); },
      },
    });
    const blockedUrlRules = [hostRule('blocked.test')];
    expect(await handleCommand({ action: 'screenshot_all_tabs', blockedUrlRules }))
      .toMatchObject({ success: true, count: 1, failed: 0, excludedBlocked: 1, excludedProtected: 0 });
    expect(captured).toEqual([1]);
    expect(await handleCommand({ action: 'reload_all', blockedUrlRules }))
      .toMatchObject({ success: true, reloadedCount: 1, excludedBlocked: 1, excludedProtected: 0 });
    expect(reloaded).toEqual([1]);
  });
});

describe('5.2 log buffers', () => {
  interface LogFns {
    appendLogRecords(target: Record<string, unknown>[], incoming: unknown, limit: number): number;
    queryNetworkLogs(entries: Record<string, unknown>[], options: Record<string, unknown>): Record<string, unknown>;
  }
  let fns: LogFns;
  beforeAll(async () => {
    fns = await import('../../packages/extension/src/background/log-records.ts') as unknown as LogFns;
  });

  it('keeps the newest entries up to the limit, as plain data only', () => {
    const buffer: Record<string, unknown>[] = [{ message: 'old' }];
    fns.appendLogRecords(buffer, [{ message: 'a', fn: () => 1 }, 'junk', { message: 'b' }], 2);
    expect(buffer).toEqual([{ message: 'a' }, { message: 'b' }]);
  });

  it('get_network_logs: an invalid urlPattern is an error, not a throw; matching is case-sensitive', () => {
    expect(fns.queryNetworkLogs([{ url: 'https://a.test/' }], { urlPattern: '(' })).toMatchObject({ success: false });
    const logs = [{ url: 'https://A.test/x' }, { url: 'https://a.test/y' }];
    expect(fns.queryNetworkLogs(logs, { urlPattern: 'a\\.test' }))
      .toMatchObject({ success: true, returnedCount: 1, logs: [{ url: 'https://a.test/y' }] });
  });
});

describe('5.2 log buffers across a navigation', () => {
  type MessageListener = (
    message: unknown,
    sender: browser.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => boolean | void;

  /** registerListeners() on a fake browser; returns the two listeners used here. */
  function loggingBrowser(): { post: (sender: browser.runtime.MessageSender, payload: Record<string, unknown>) => unknown; close: (tabId: number) => void } {
    let onMessage: MessageListener | undefined;
    let onRemoved: ((tabId: number) => void) | undefined;
    useFakeBrowser({
      runtime: {
        id: 'kitsune@test',
        getURL: (path: string) => `moz-extension://kitsune${path}`,
        onMessage: { addListener: (fn: MessageListener) => { onMessage = fn; } },
        onMessageExternal: { addListener: () => {} },
      },
      tabs: {
        get: async (id: number) => fakeTab({ id }),
        // Every content-script round trip (startLogging, flushLogs, ...) answers empty.
        sendMessage: async () => ({}),
        onRemoved: { addListener: (fn: (tabId: number) => void) => { onRemoved = fn; } },
      },
      webNavigation: { onCommitted: { addListener: () => {} } },
    });
    registerListeners();
    return {
      post: (sender, payload) => {
        let answer: unknown;
        onMessage!({ type: LOG_RECORD_MESSAGE, ...payload }, sender, (r) => { answer = r; });
        return answer;
      },
      close: (tabId) => onRemoved!(tabId),
    };
  }

  const sender = (tab: browser.tabs.Tab, frameId: number): browser.runtime.MessageSender =>
    ({ tab, frameId, id: 'kitsune@test', url: tab.url });

  it('takes batches from the top frame of a logging tab only, across navigations', async () => {
    const { post } = loggingBrowser();
    const page = fakeTab({ id: 11, url: 'https://app.test/one' });
    const bank = fakeTab({ id: 11, url: 'https://bank.test/pay' });
    const page2 = fakeTab({ id: 11, url: 'https://app.test/two' });
    const protectedRules = hostRules('bank.test');

    expect(await startLoggingOnTab(page, {}, protectedRules, undefined))
      .toMatchObject({ success: true, consoleLogsCount: 0, networkLogsCount: 0, bufferLimit: 500 });

    expect(post(sender(page, TOP_FRAME_ID), { console: [{ message: 'one' }], network: [{ url: 'https://api.test/' }] }))
      .toEqual({ accepted: true });
    // Not the top frame, and not a tab logging is on for: refused outright.
    expect(post({ ...sender(page, 1), url: 'https://ad.test/' }, { console: [{ message: 'iframe' }] }))
      .toEqual({ accepted: false });
    expect(post(sender(fakeTab({ id: 12, url: 'https://app.test/' }), TOP_FRAME_ID), { console: [{ message: 'other tab' }] }))
      .toEqual({ accepted: false });
    // Navigated to a protected page: the listener takes the batch, the
    // buffer drops it (recording is paused there).
    expect(post(sender(bank, TOP_FRAME_ID), { console: [{ message: 'secret' }] })).toEqual({ accepted: true });
    expect(await getLogsOfTab('getConsoleLogs', bank, {}, []))
      .toMatchObject({ success: true, pausedForProtectedDomain: true, totalCount: 1 });
    // Back on a normal page: the same buffer continues.
    post(sender(page2, TOP_FRAME_ID), { console: [{ message: 'two' }] });
    expect(await getLogsOfTab('getConsoleLogs', page2, {}, [])).toMatchObject({
      success: true,
      loggingEnabled: true,
      pausedForProtectedDomain: false,
      logs: [{ message: 'one' }, { message: 'two' }],
    });

    // stop_logging keeps the buffer readable but takes no further batches.
    expect(await stopLoggingOnTab(page2)).toMatchObject({ success: true, consoleLogsCount: 2, networkLogsCount: 1 });
    expect(post(sender(page2, TOP_FRAME_ID), { console: [{ message: 'late' }] })).toEqual({ accepted: false });
    expect(await getLogsOfTab('getConsoleLogs', page2, {}, []))
      .toMatchObject({ loggingEnabled: false, returnedCount: 2 });

    // clear_logs honours the console / network flags.
    expect(await clearLogsOfTab(page2, { console: false }))
      .toMatchObject({ success: true, consoleLogsCount: 2, networkLogsCount: 0 });
    expect(await clearLogsOfTab(page2, {}))
      .toMatchObject({ success: true, consoleLogsCount: 0, networkLogsCount: 0 });
  });

  it('closing the tab drops its buffer', async () => {
    const { post, close } = loggingBrowser();
    const tab = fakeTab({ id: 13, url: 'https://app.test/' });
    await startLoggingOnTab(tab, {}, [], undefined);
    expect(post(sender(tab, TOP_FRAME_ID), { console: [{ message: 'x' }] })).toEqual({ accepted: true });
    expect(await getLogsOfTab('getConsoleLogs', tab, {}, [])).toMatchObject({ totalCount: 1, loggingEnabled: true });

    close(13);
    expect(await getLogsOfTab('getConsoleLogs', tab, {}, [])).toMatchObject({ totalCount: 0, loggingEnabled: false });
    expect(post(sender(tab, TOP_FRAME_ID), { console: [{ message: 'y' }] })).toEqual({ accepted: false });
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
    expect(all).toMatchObject({ success: true, count: 0, failed: 0, excludedProtected: 0 });
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

describe('WP5 reload_all / reload_by_url arguments', () => {
  /** A fake browser.tabs; the returned array records every reload call. */
  function reloadBrowser(tabs: browser.tabs.Tab[]): { id: number; bypassCache: boolean }[] {
    const calls: { id: number; bypassCache: boolean }[] = [];
    useFakeBrowser({
      tabs: {
        query: async () => tabs,
        reload: async (id: number, o: { bypassCache: boolean }) => { calls.push({ id, bypassCache: o.bypassCache }); },
      },
    });
    return calls;
  }

  const tabs = [
    fakeTab({ id: 1, url: 'https://a.test/app/x' }),
    fakeTab({ id: 2, url: 'https://a.test/other' }),
    fakeTab({ id: 3, url: 'https://A.test/app/y' }),
  ];

  it('`url` is a prefix of the whole URL, urlPattern a case-sensitive regex', async () => {
    let calls = reloadBrowser(tabs);
    expect(await reloadTabsByUrl({ url: 'https://a.test/app' })).toMatchObject({ success: true, reloadedCount: 1 });
    expect(calls.map((c) => c.id)).toEqual([1]);

    calls = reloadBrowser(tabs);
    expect(await reloadTabsByUrl({ urlPattern: '^https://a\\.test/' })).toMatchObject({ reloadedCount: 2 });
    expect(calls.map((c) => c.id)).toEqual([1, 2]);

    // `url` wins: the urlPattern is not even compiled.
    calls = reloadBrowser(tabs);
    expect(await reloadTabsByUrl({ url: 'https://a.test/other', urlPattern: '(' })).toMatchObject({ reloadedCount: 1 });
    expect(calls.map((c) => c.id)).toEqual([2]);

    expect(await reloadTabsByUrl({ urlPattern: '(' }))
      .toMatchObject({ success: false, error: expect.stringMatching(/^Invalid urlPattern/) });
    expect(await reloadTabsByUrl({}))
      .toMatchObject({ success: false, error: 'Must provide url or urlPattern' });
  });

  it('bypassCache defaults: reload_all false, reload_by_url true', async () => {
    const one = [fakeTab({ id: 1, url: 'https://a.test/' })];
    let calls = reloadBrowser(one);
    expect(await reloadAllTabs({})).toMatchObject({ bypassCache: false });
    expect(calls).toEqual([{ id: 1, bypassCache: false }]);

    calls = reloadBrowser(one);
    expect(await reloadAllTabs({ bypassCache: true })).toMatchObject({ bypassCache: true });
    expect(calls).toEqual([{ id: 1, bypassCache: true }]);

    calls = reloadBrowser(one);
    expect(await reloadTabsByUrl({ url: 'https://a.test/' })).toMatchObject({ bypassCache: true });
    expect(calls).toEqual([{ id: 1, bypassCache: true }]);

    calls = reloadBrowser(one);
    expect(await reloadTabsByUrl({ url: 'https://a.test/', bypassCache: false })).toMatchObject({ bypassCache: false });
    expect(calls).toEqual([{ id: 1, bypassCache: false }]);
  });
});

describe('3.security native message logging', () => {
  it('logs action / requestId / key names, never values', async () => {
    const describe_ = describeNativeMessage;
    const line = describe_({ action: 'execute_script', requestId: '9', data: { script: 'secret()' } });
    expect(line).toContain('action=execute_script');
    expect(line).toContain('data=[script]');
    expect(line).not.toContain('secret');
    expect(background).not.toMatch(/console\.log\("\[KitsuneMCP\] Received from native host:", message\)/);
  });

  it('manifest: no redundant activeTab, no web_accessible_resources', () => {
    const manifest = JSON.parse(readExtensionSource('../manifest.json')) as Record<string, unknown>;
    expect(manifest['permissions']).not.toContain('activeTab');
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });
});
