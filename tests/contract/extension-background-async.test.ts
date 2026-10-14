/**
 * Extension background: asynchronous edges and small input checks of R2-C
 * WP-B (review E-02, E-07, E-10, E-11, E-14, E-17, E-23, E-24, A-04,
 * A-05). The modules are imported directly with a fake `browser` global;
 * modules with state (native-connection.ts, setup-badge.ts) are loaded
 * afresh per test (vi.resetModules).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForNavigation } from '../../packages/extension/src/background/tab-wait.ts';
import { getAllTabs, findText } from '../../packages/extension/src/background/tabs.ts';
import { registerListeners } from '../../packages/extension/src/background/listeners.ts';
import { clipApprovalText, isApprovedSite } from '../../packages/extension/src/approval.ts';
import { clipText } from '../../packages/extension/src/text-clip.ts';
import { LIMITS, TIMEOUTS } from '../../packages/extension/src/background/constants.ts';
import {
  setupStateOfReply,
  setupStateOfFailure,
} from '../../packages/extension/src/popup/setup-status.ts';

const useFakeBrowser = (fake: unknown): void => {
  (globalThis as { browser?: unknown }).browser = fake;
};

afterEach(() => {
  delete (globalThis as { browser?: unknown }).browser;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Listener = (...args: unknown[]) => void;

/** A browser event; `added` keeps every listener ever added, removed or not. */
function fakeEvent() {
  const listeners = new Set<Listener>();
  const added: Listener[] = [];
  return {
    added,
    addListener: (fn: Listener) => { listeners.add(fn); added.push(fn); },
    removeListener: (fn: Listener) => { listeners.delete(fn); },
    fire: (...a: unknown[]) => { for (const fn of [...listeners]) fn(...a); },
    size: () => listeners.size,
  };
}

// ---------------------------------------------------------------------------
// native-connection.ts (E-02, E-24)
// ---------------------------------------------------------------------------

function fakePort() {
  const port = {
    error: undefined as { message: string } | undefined,
    posted: [] as Record<string, unknown>[],
    failPost: false,
    disconnected: false,
    onMessage: fakeEvent(),
    onDisconnect: fakeEvent(),
    postMessage(m: Record<string, unknown>) {
      if (port.failPost) throw new Error('Attempt to postMessage on disconnected port');
      port.posted.push(m);
    },
    disconnect() { port.disconnected = true; },
  };
  return port;
}
type FakePort = ReturnType<typeof fakePort>;

async function loadNativeConnection() {
  vi.resetModules();
  const ports: FakePort[] = [];
  useFakeBrowser({
    runtime: {
      connectNative: () => {
        const p = fakePort();
        ports.push(p);
        return p;
      },
    },
  });
  const mod = await import('../../packages/extension/src/background/native-connection.ts');
  const hooks = { onCommand: vi.fn(), onConfirmed: vi.fn(), onDisconnected: vi.fn() };
  mod.setConnectionHooks(hooks);
  // The user's consent (background.ts sets it from control-state.ts).
  mod.setConnectionAllowed(true);
  return { mod, ports, hooks };
}

/** Answer the last request posted on `port`. */
const answerLast = (port: FakePort, reply: Record<string, unknown> = {}): void => {
  const last = port.posted.at(-1)!;
  port.onMessage.fire({ requestId: last.requestId, success: true, ...reply });
};

describe('native connection: a replaced port (E-02, E-24)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a failed post drops the old port and retries on a new one; the old port no longer counts', async () => {
    const { mod, ports, hooks } = await loadNativeConnection();
    mod.connectNativeHost();
    const port1 = ports[0]!;
    answerLast(port1); // ping
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.hostStatus()).toMatchObject({ confirmed: true, portOpen: true });

    // A request already waiting on port1 when it breaks.
    const earlier = mod.sendToNativeHost({ action: 'status' });
    const earlierResult = earlier.then(() => 'resolved', (e: Error) => e.message);

    port1.failPost = true;
    const message = { action: 'status' };
    const pending = mod.sendToNativeHost(message);
    let settled: unknown = 'pending';
    pending.then((v) => { settled = v; }, (e: Error) => { settled = e.message; });

    // port1 is released at once: listeners off, disconnected, its request failed.
    expect(port1.disconnected).toBe(true);
    expect(port1.onMessage.size()).toBe(0);
    expect(port1.onDisconnect.size()).toBe(0);
    expect(await earlierResult).toMatch(/disconnected/);
    expect(hooks.onDisconnected).toHaveBeenCalledTimes(1);

    // Retry: a new port, then the request on it.
    await vi.advanceTimersByTimeAsync(1500);
    expect(ports).toHaveLength(2);
    const port2 = ports[1]!;
    const sent = port2.posted.find((m) => m.action === 'status')!;
    expect(sent).toBeDefined();

    // Firefox reports port1's disconnect late (a listener registered before
    // it was removed): port2 and its request must survive.
    port1.error = { message: 'gone' };
    port1.onDisconnect.added[0]!(port1);
    expect(mod.hostStatus().portOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe('pending');
    expect(hooks.onDisconnected).toHaveBeenCalledTimes(1);

    port2.onMessage.fire({ requestId: sent.requestId, success: true, ok: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toMatchObject({ ok: 1 });
    // No third port: no second reconnect was started.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports).toHaveLength(2);
    // E-24: the caller's object is not given a requestId.
    expect(message).toEqual({ action: 'status' });
  });

  it('a disconnect of the current port still fails its requests and reconnects', async () => {
    const { mod, ports, hooks } = await loadNativeConnection();
    mod.connectNativeHost();
    const port1 = ports[0]!;
    answerLast(port1);
    const pending = mod.sendToNativeHost({ action: 'status' }).then(() => 'resolved', (e: Error) => e.message);
    port1.onDisconnect.fire(port1);
    expect(await pending).toMatch(/disconnected/);
    expect(hooks.onDisconnected).toHaveBeenCalledTimes(1);
    expect(mod.hostStatus().portOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });

  it('a post failing on every retry still drops the last port and reconnects (R3 #7)', async () => {
    const { mod, ports, hooks } = await loadNativeConnection();
    mod.connectNativeHost();
    answerLast(ports[0]!);
    ports[0]!.failPost = true;
    const pending = mod.sendToNativeHost({ action: 'status' }).then(() => 'resolved', (e: Error) => e.message);
    // Each retry opens a new port (after the retry delay); it breaks before
    // the request is posted on it (the connect settle time).
    const RETRIES = LIMITS.SEND_RETRIES;
    for (let i = 1; i <= RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(TIMEOUTS.SEND_RETRY_DELAY);
      expect(ports).toHaveLength(i + 1);
      ports[i]!.failPost = true;
      await vi.advanceTimersByTimeAsync(TIMEOUTS.CONNECT_SETTLE);
    }
    expect(await pending).toBe('Attempt to postMessage on disconnected port');
    const last = ports[RETRIES]!;
    expect(last.disconnected).toBe(true);
    expect(last.onDisconnect.size()).toBe(0);
    expect(mod.hostStatus().portOpen).toBe(false);
    expect(hooks.onDisconnected).toHaveBeenCalledTimes(RETRIES + 1);
    // The reconnect is scheduled without waiting for an onDisconnect.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.length).toBeGreaterThan(RETRIES + 1);
  });

  it('a failed post reports the loss like a disconnect: lastError and the reconnect counter (E-7)', async () => {
    const { mod, ports } = await loadNativeConnection();
    // Two hosts that exit without answering: the backoff counter reaches 2.
    mod.connectNativeHost();
    ports[0]!.onDisconnect.fire(ports[0]!);
    expect(mod.hostStatus().lastError).toBe('Native host exited without answering');
    await vi.advanceTimersByTimeAsync(TIMEOUTS.RECONNECT_INITIAL);
    ports[1]!.onDisconnect.fire(ports[1]!);
    await vi.advanceTimersByTimeAsync(TIMEOUTS.RECONNECT_INITIAL * 1.5);
    expect(ports).toHaveLength(3);
    // The third host answers and stays up past the stable period.
    answerLast(ports[2]!);
    expect(mod.hostStatus()).toMatchObject({ confirmed: true, lastError: null });
    await vi.advanceTimersByTimeAsync(10_000);

    ports[2]!.failPost = true;
    const pending = mod.sendToNativeHost({ action: 'status' }).then(() => 'resolved', (e: Error) => e.message);
    expect(mod.hostStatus()).toMatchObject({
      confirmed: false,
      portOpen: false,
      lastError: 'Attempt to postMessage on disconnected port',
    });
    // The retry opens a new port; that host exits without answering.
    await vi.advanceTimersByTimeAsync(TIMEOUTS.SEND_RETRY_DELAY + TIMEOUTS.CONNECT_SETTLE);
    expect(ports).toHaveLength(4);
    ports[3]!.onDisconnect.fire(ports[3]!);
    expect(await pending).toMatch(/disconnected/);
    // The stable connection started the counter over: the next attempt
    // comes after the initial delay, not after 1.5^2 of it.
    await vi.advanceTimersByTimeAsync(TIMEOUTS.RECONNECT_INITIAL);
    expect(ports).toHaveLength(5);
  });

  it('a malformed frame is dropped, not taken as an answer or a command (E-9)', async () => {
    const { mod, ports, hooks } = await loadNativeConnection();
    mod.connectNativeHost();
    const pending = mod.sendToNativeHost({ action: 'status' }, { timeoutMs: 5_000 })
      .then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(0);
    const last = ports[0]!.posted.at(-1)!;
    ports[0]!.onMessage.fire({ requestId: last.requestId, error: { code: 1 } });
    ports[0]!.onMessage.fire({ action: 'click', requestId: 'r1', data: 'not an object' });
    ports[0]!.onMessage.fire(['click']);
    expect(hooks.onCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe('Request timeout');

    expect(mod.parseNativeMessage({ action: 'click', requestId: 'r2', tabId: 3, data: { selector: '#a' } }))
      .toEqual({ action: 'click', requestId: 'r2', tabId: 3, data: { selector: '#a' } });
    expect(mod.parseNativeMessage({ requestId: 4, data: [] })).toBeNull();
    expect(mod.parseNativeMessage({ action: 'click', tabId: '3' })).toBeNull();
  });

  it('timeoutMs bounds how long a posted request stays pending', async () => {
    const { mod, ports } = await loadNativeConnection();
    mod.connectNativeHost();
    answerLast(ports[0]!);
    const pending = mod.sendToNativeHost({ action: 'status' }, { timeoutMs: 5_000 })
      .then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe('Request timeout');
  });
});

// ---------------------------------------------------------------------------
// setup-badge.ts (A-04)
// ---------------------------------------------------------------------------

describe('setup state: overlapping refreshes (A-04)', () => {
  type Deferred = { resolve(v: unknown): void; reject(e: Error): void };

  async function loadSetupBadge() {
    vi.resetModules();
    const requests: { options: unknown; deferred: Deferred }[] = [];
    vi.doMock('../../packages/extension/src/background/control-state.ts', () => ({
      controlView: () => ({ consent: 'granted', paused: false }),
    }));
    vi.doMock('../../packages/extension/src/background/native-connection.ts', () => ({
      hostStatus: () => ({ confirmed: true, portOpen: true, lastError: null }),
      sendToNativeHost: (_m: unknown, options: unknown) =>
        new Promise((resolve, reject) => { requests.push({ options, deferred: { resolve, reject } }); }),
    }));
    const badgeTexts: string[] = [];
    useFakeBrowser({
      i18n: { getMessage: () => '' },
      browserAction: {
        setBadgeBackgroundColor: async () => {},
        setBadgeText: async ({ text }: { text: string }) => { badgeTexts.push(text); },
        setTitle: async () => {},
      },
    });
    const mod = await import('../../packages/extension/src/background/setup-badge.ts');
    return { mod, requests, badgeTexts };
  }

  afterEach(() => {
    vi.doUnmock('../../packages/extension/src/background/control-state.ts');
    vi.doUnmock('../../packages/extension/src/background/native-connection.ts');
  });

  const READY = { mcp_server: { available: true, relays: 1 } };

  it('an older result arriving after a newer one does not overwrite it', async () => {
    vi.useFakeTimers();
    const { mod, requests, badgeTexts } = await loadSetupBadge();
    const first = mod.refreshSetupState();
    const second = mod.refreshSetupState();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    // The status request itself gives up after the setup timeout.
    expect(requests[0]!.options).toEqual({ timeoutMs: 5_000 });

    requests[1]!.deferred.resolve(READY);
    expect(await second).toMatchObject({ kind: 'ready' });
    requests[0]!.deferred.reject(new Error('Native host disconnected - reconnecting...'));
    // The stale call reports the newer state, and the badge keeps it.
    expect(await first).toMatchObject({ kind: 'ready' });
    expect(badgeTexts.at(-1)).toBe('');
    // The race timers were cleared.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('results in call order are all applied', async () => {
    const { mod, requests, badgeTexts } = await loadSetupBadge();
    const first = mod.refreshSetupState();
    const second = mod.refreshSetupState();
    await Promise.resolve();
    requests[0]!.deferred.reject(new Error('boom'));
    expect(await first).toMatchObject({ kind: 'hostError', error: 'boom' });
    expect(badgeTexts.at(-1)).toBe('!');
    requests[1]!.deferred.resolve(READY);
    expect(await second).toMatchObject({ kind: 'ready' });
    expect(badgeTexts.at(-1)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// tab-wait.ts (E-07)
// ---------------------------------------------------------------------------

describe('waitForNavigation: tab closed right after the navigation (E-07)', () => {
  it('still succeeds, without a title', async () => {
    const onCompleted = fakeEvent();
    let gets = 0;
    useFakeBrowser({
      tabs: {
        get: async (id: number) => {
          gets++;
          if (gets > 1) throw new Error(`Invalid tab ID: ${id}`);
          return { id, url: 'https://a.test/', status: 'complete' };
        },
        query: async () => [{ id: 1, url: 'https://a.test/', active: true }],
      },
      webNavigation: { onCompleted, onDOMContentLoaded: fakeEvent() },
    });
    const waiting = waitForNavigation(1, { timeout: 1_000 });
    await vi.waitFor(() => expect(onCompleted.size()).toBe(1));
    onCompleted.fire({ tabId: 1, frameId: 0, url: 'https://a.test/next' });
    const result = await waiting;
    expect(result).toEqual({ success: true, url: 'https://a.test/next', title: undefined });
  });
});

// ---------------------------------------------------------------------------
// tabs.ts (E-10, E-11)
// ---------------------------------------------------------------------------

describe('getAllTabs limit and findText query (E-10, E-11)', () => {
  const tabs = [1, 2, 3].map((id) => ({ id, url: `https://t${id}.test/`, windowId: 1 }));

  beforeEach(() => {
    useFakeBrowser({
      tabs: { query: async () => tabs },
      windows: { getAll: async () => [{ id: 1, focused: true }] },
      find: { find: vi.fn(async () => ({ count: 2, rangeData: [] })) },
    });
  });

  it.each([0, -1, 1.5])('limit %s falls back to the default', async (limit) => {
    const result = await getAllTabs({ limit });
    expect(result).toMatchObject({ success: true, returnedTabs: 3, truncated: false });
  });

  it('a positive limit still cuts the list', async () => {
    expect(await getAllTabs({ limit: 2 })).toMatchObject({ returnedTabs: 2, truncated: true, totalTabs: 3 });
  });

  const target = { id: 1 } as browser.tabs.Tab;

  it.each([undefined, {}, { query: '' }, { query: 3 }])('findText refuses data %j', async (data) => {
    const result = await findText(target, data as Record<string, unknown> | undefined);
    expect(result).toEqual({ success: false, error: 'query is required (a non-empty string)' });
    expect((globalThis as unknown as { browser: { find: { find: ReturnType<typeof vi.fn> } } }).browser.find.find)
      .not.toHaveBeenCalled();
  });

  it('findText passes only boolean true options', async () => {
    const result = await findText(target, { query: 'x', caseSensitive: 'yes', entireWord: true });
    expect(result).toMatchObject({ success: true, count: 2 });
    const find = (globalThis as unknown as { browser: { find: { find: ReturnType<typeof vi.fn> } } }).browser.find.find;
    expect(find).toHaveBeenCalledWith('x', expect.objectContaining({ caseSensitive: false, entireWord: true }));
  });
});

// ---------------------------------------------------------------------------
// listeners.ts (E-23)
// ---------------------------------------------------------------------------

describe('runtime.onMessage: messages that are not objects (E-23)', () => {
  it.each([null, undefined, 'text', 42])('%j is ignored without throwing', (message) => {
    const onMessage = fakeEvent();
    useFakeBrowser({
      runtime: {
        onMessage,
        onMessageExternal: fakeEvent(),
        onInstalled: fakeEvent(),
        id: 'ext',
        getURL: (p: string) => `moz-extension://x${p}`,
      },
    });
    registerListeners();
    const sendResponse = vi.fn();
    expect(() => onMessage.added[0]!(message, { id: 'ext' }, sendResponse)).not.toThrow();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// popup/setup-status.ts (E-14)
// ---------------------------------------------------------------------------

describe('popup status reply (E-14)', () => {
  it('a reply with a setup state is that state', () => {
    expect(setupStateOfReply({ success: true, setup: { kind: 'ready', relays: 2 } }))
      .toEqual({ kind: 'ready', relays: 2 });
  });

  it('no reply or no state is still connecting (the popup polls again)', () => {
    expect(setupStateOfReply(undefined)).toEqual({ kind: 'connecting' });
    expect(setupStateOfReply({ success: true })).toEqual({ kind: 'connecting' });
  });

  it('a failed reply or no answer is an error with its text, not connecting', () => {
    expect(setupStateOfReply({ success: false, error: 'Unknown action' }))
      .toEqual({ kind: 'hostError', error: 'Unknown action' });
    expect(setupStateOfFailure(new Error('Could not establish connection')))
      .toEqual({ kind: 'hostError', error: 'The extension background did not answer: Could not establish connection' });
  });
});

// ---------------------------------------------------------------------------
// approval.ts (A-05) and text clipping (E-17)
// ---------------------------------------------------------------------------

describe('isApprovedSite: trailing dot (A-05)', () => {
  it('a hostname with a trailing dot is the approved host', () => {
    expect(isApprovedSite('https://bank.example.test./x', 'bank.example.test')).toBe(true);
    expect(isApprovedSite('https://bank.example.test/x', 'bank.example.test.')).toBe(true);
  });

  it('still exact otherwise', () => {
    expect(isApprovedSite('https://evil.bank.example.test./', 'bank.example.test')).toBe(false);
    expect(isApprovedSite('https://bank.example.test/', '.')).toBe(false);
  });
});

describe('clipping never splits a surrogate pair (E-17)', () => {
  const FOX = '\u{1F98A}'; // 2 code units

  it('clipText', () => {
    expect(clipText(`ab${FOX}`, 3)).toBe('ab');
    expect(clipText(`ab${FOX}`, 4)).toBe(`ab${FOX}`);
    expect(clipText('abcdef', 3)).toBe('abc');
    expect(clipText('abc', 5)).toBe('abc');
    expect(clipText('abc', 0)).toBe('');
  });

  it('approval text', () => {
    expect(clipApprovalText(`${'a'.repeat(499)}${FOX}x`, 500)).toBe(`${'a'.repeat(499)}…`);
  });
});
