/**
 * Extension background (background.ts and background/*.ts): routing and
 * robustness fixes of WP5 (review 3.A2-A9, 5.2, 5.7, 3.security). Functions
 * of the side-effect-free modules under background/ are imported directly,
 * a few are still cut out of the source (helpers/extension-source.ts); the
 * rest is checked on the source text.
 *
 * TODO(test): handleCommand end to end with a fake `browser` (target tab
 *   resolved once: scope check, protected check, handler and URL report on
 *   the same tab while the active tab changes in between).
 * TODO(test): takeScreenshot / screenshotAllTabs with saveToFile false (no
 *   capture, imageSaved false) and all_tabs with every capture failing
 *   (success false), against a fake browser.tabs.
 * TODO(test): log buffers across a simulated navigation (LOG_RECORD_MESSAGE
 *   from frame 0 only, dropped for frames != 0, for tabs without logging,
 *   and for protected sender URLs; stop_logging keeps the buffer; tab close
 *   drops it; clear_logs honours console / network flags).
 * TODO(test): waitForTabLoad settle path (no "loading" within settleMs →
 *   current state decides), trigger rejection, requireLoading false.
 * TODO(test): reload_by_url with `url` prefix vs urlPattern, bypassCache
 *   defaults (reload_all false, reload_by_url true).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileUrlRules } from '../../packages/extension/src/url-rule.ts';
import { checkListedTarget } from '../../packages/extension/src/background/url-policy.ts';
import { reloadMatchingTabs } from '../../packages/extension/src/background/reload.ts';
import { captureTabsWithin } from '../../packages/extension/src/background/screenshot.ts';
import {
  loadExtensionFunction,
  readExtensionSource,
  readExtensionTree,
} from './helpers/extension-source.js';

const background = readExtensionTree('background');

const NO_LISTS = { blocked: [], allowed: [], allowlistActive: false };

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
  ({ waitForTabLoad } = await import('../../packages/extension/src/background/tab-wait.ts'));
});

afterEach(() => {
  vi.useRealTimers();
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
});

describe('3.A2 reconnect backoff', () => {
  it('starts over only after a confirmed connection stayed up for the stable period', async () => {
    const next = await loadExtensionFunction<(a: number, c: number | null, s: number) => number>(
      'background.ts', 'nextReconnectAttempts');
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
    expect(body).toMatch(/enforceContainerScope\(action, target, containerScope\)/);
    expect(body).toMatch(/checkProtectedTarget\(target, protectedPatterns, approvedHost\)/);
  });
});

describe('3.A5 capture of the target tab', () => {
  it('uses captureTab(tabId), never captureVisibleTab(windowId)', () => {
    expect(background).not.toMatch(/\.captureVisibleTab\(/);
    expect(background).toMatch(/browser\.tabs\.captureTab\(targetTab\.id,/);
  });
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
    expect(background).toMatch(/SELF_PROTECTED_ACTIONS[^;]*"reloadAll",\s*"reloadByUrl"/);
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
    expect(checkListedTarget({ id: 1, url: 'https://www.blocked.test/x' }, lists))
      .toMatchObject({ success: false, safetyDecision: 'blocked_url', url: 'https://www.blocked.test/x' });
    expect(checkListedTarget({ id: 1, url: 'https://other.test/' }, lists))
      .toMatchObject({ success: false, safetyDecision: 'not_allowlisted' });
    expect(checkListedTarget({ id: 1, url: 'https://ok.test/' }, lists)).toBeNull();
    expect(checkListedTarget({ id: 1, url: 'about:blank' }, lists)).toBeNull();
    expect(checkListedTarget(undefined, lists)).toMatchObject({ success: false });
  });

  it('an invalid urlPattern is a failure result, a valid one is case-sensitive', async () => {
    const { urlPatternArg } = await import('../../packages/extension/src/background/tab-wait.ts');
    expect(urlPatternArg('(')).toMatchObject({ ok: false, result: { success: false, error: expect.stringMatching(/^Invalid urlPattern/) } });
    expect(urlPatternArg(undefined)).toEqual({ ok: true, pattern: null });
    expect(urlPatternArg('a\\.test').pattern!.flags).toBe('');
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

  // TODO(test): handleCommand with a fake browser: invalid rule entries are
  //   refused (config_error), list check before the protected check,
  //   screenshot all_tabs / reload skip list-violating tabs (excludedBlocked).
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

describe('5.7 screenshot all_tabs', () => {
  it('bounds each capture and skips tabs once the budget is used up', async () => {
    vi.useFakeTimers();
    const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }];
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
});

describe('3.security native message logging', () => {
  it('logs action / requestId / key names, never values', async () => {
    const describe_ = await loadExtensionFunction<(m: unknown) => string>('background.ts', 'describeNativeMessage');
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
