/**
 * Extension background: asynchronous edges of R2-C WP-B (review E-02,
 * E-24, A-04). The modules are imported directly with a fake `browser` global;
 * modules with state (native-connection.ts, setup-badge.ts) are loaded
 * afresh per test (vi.resetModules).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
