/**
 * Extension: the first-run consent and the pause switch (user-control.ts,
 * background/control-state.ts), against a fake `browser`. Covers
 *   - no Native Messaging connection before the user allowed it, one after,
 *     and none of the reconnect timers once it is withdrawn;
 *   - every command from the Native Host refused while paused (the popup's
 *     own commands still run), and the badge while a command runs;
 *   - who may read or change the consent and the pause switch, and the
 *     consent page opened on the first install only.
 * Modules with state are loaded afresh per test (vi.resetModules).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_PAGE_PATH, CONTROL_MESSAGE, requestControl } from '../../packages/extension/src/user-control.ts';
import { readExtensionSource } from './helpers/extension-source.js';

const EXTENSION_ID = 'inari@test';
const BASE_URL = 'moz-extension://inari';
const CONSENT_URL = `${BASE_URL}${CONSENT_PAGE_PATH}`;
const POPUP_URL = `${BASE_URL}/dist/popup/popup.html`;

type Listener = (...args: unknown[]) => unknown;

/** A browser event; `fire` calls every listener added and returns the last answer. */
function fakeEvent() {
  const listeners: Listener[] = [];
  return {
    addListener: (fn: Listener) => { listeners.push(fn); },
    removeListener: (fn: Listener) => { listeners.splice(listeners.indexOf(fn), 1); },
    fire: (...args: unknown[]): unknown => listeners.map((fn) => fn(...args)).at(-1),
  };
}

function fakePort() {
  return {
    posted: [] as Record<string, unknown>[],
    disconnected: false,
    onMessage: fakeEvent(),
    onDisconnect: fakeEvent(),
    postMessage(message: Record<string, unknown>) { this.posted.push(message); },
    disconnect() { this.disconnected = true; },
  };
}
type FakePort = ReturnType<typeof fakePort>;

interface FakeBrowser {
  ports: FakePort[];
  storage: Record<string, unknown>;
  badgeText: string[];
  createdTabs: string[];
  tabQueries: number;
  /** When set, tabs.query waits for this promise (a command that is still running). */
  tabQueryGate: Promise<void> | null;
  onMessage: ReturnType<typeof fakeEvent>;
  onInstalled: ReturnType<typeof fakeEvent>;
}

function installFakeBrowser(stored: Record<string, unknown> = {}): FakeBrowser {
  const fake: FakeBrowser = {
    ports: [],
    storage: { ...stored },
    badgeText: [],
    createdTabs: [],
    tabQueries: 0,
    tabQueryGate: null,
    onMessage: fakeEvent(),
    onInstalled: fakeEvent(),
  };
  (globalThis as { browser?: unknown }).browser = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `${BASE_URL}${path}`,
      connectNative: () => {
        const port = fakePort();
        fake.ports.push(port);
        return port;
      },
      onMessage: fake.onMessage,
      onMessageExternal: fakeEvent(),
      onInstalled: fake.onInstalled,
    },
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in fake.storage).map((k) => [k, fake.storage[k]])),
        set: async (items: Record<string, unknown>) => { Object.assign(fake.storage, items); },
      },
    },
    tabs: {
      create: async ({ url }: { url: string }) => { fake.createdTabs.push(url); return { id: 1 }; },
      query: async () => {
        fake.tabQueries++;
        if (fake.tabQueryGate !== null) await fake.tabQueryGate;
        return [];
      },
      onRemoved: fakeEvent(),
    },
    windows: { getAll: async () => [] },
    i18n: { getMessage: (key: string) => `msg:${key}` },
    browserAction: {
      setBadgeText: async ({ text }: { text: string }) => { fake.badgeText.push(text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  };
  return fake;
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete (globalThis as { browser?: unknown }).browser;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../../packages/extension/src/background/native-connection.ts');
});

// ---------------------------------------------------------------------------
// native-connection.ts: no connection before consent
// ---------------------------------------------------------------------------

describe('native connection before and after consent', () => {
  async function loadNativeConnection() {
    const fake = installFakeBrowser();
    const mod = await import('../../packages/extension/src/background/native-connection.ts');
    const hooks = { onCommand: vi.fn(), onConfirmed: vi.fn(), onDisconnected: vi.fn() };
    mod.setConnectionHooks(hooks);
    return { fake, mod, hooks };
  }

  it('before consent nothing opens a port: not a connect, a recheck, a request or the timers', async () => {
    vi.useFakeTimers();
    const { fake, mod } = await loadNativeConnection();
    mod.connectNativeHost();
    mod.recheckHost();
    const request = mod.sendToNativeHost({ action: 'status' }).then(() => 'resolved', (e: Error) => e.message);
    expect(await request).toMatch(/^Not allowed to connect/);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fake.ports).toHaveLength(0);
    expect(mod.hostStatus()).toEqual({ confirmed: false, portOpen: false, lastError: null });
  });

  it('after consent the connection opens and pings the host', async () => {
    const { fake, mod } = await loadNativeConnection();
    mod.setConnectionAllowed(true);
    expect(fake.ports).toHaveLength(0); // allowing does not connect by itself
    mod.recheckHost();
    expect(fake.ports).toHaveLength(1);
    expect(fake.ports[0]!.posted.map((m) => m.action)).toEqual(['ping']);
  });

  it('withdrawing consent closes the port, fails its requests and stops the reconnects', async () => {
    vi.useFakeTimers();
    const { fake, mod, hooks } = await loadNativeConnection();
    mod.setConnectionAllowed(true);
    mod.connectNativeHost();
    const port = fake.ports[0]!;
    const pending = mod.sendToNativeHost({ action: 'status' }).then(() => 'resolved', (e: Error) => e.message);

    mod.setConnectionAllowed(false);
    expect(port.disconnected).toBe(true);
    expect(await pending).toMatch(/^Not allowed to connect/);
    expect(hooks.onDisconnected).toHaveBeenCalledTimes(1);
    expect(mod.hostStatus().portOpen).toBe(false);

    // A late onDisconnect of the old port schedules nothing either.
    port.onDisconnect.fire(port);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fake.ports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// control-state.ts: storage.local
// ---------------------------------------------------------------------------

describe('control-state: saved choices', () => {
  it('loads the saved consent and pause switch; anything else is undecided and not paused', async () => {
    installFakeBrowser({ consent: 'granted', paused: true });
    const state = await import('../../packages/extension/src/background/control-state.ts');
    expect(await state.loadControlState()).toEqual({ consent: 'granted', paused: true });

    vi.resetModules();
    installFakeBrowser({ consent: 'yes', paused: 'true' });
    const fresh = await import('../../packages/extension/src/background/control-state.ts');
    expect(await fresh.loadControlState()).toEqual({ consent: 'undecided', paused: false });
  });

  it('a failed read leaves no consent and pauses, so allowing again does not lift a saved pause', async () => {
    installFakeBrowser();
    (globalThis as { browser: { storage: unknown } }).browser.storage = {
      local: { get: async () => { throw new Error('storage broken'); }, set: async () => {} },
    };
    const state = await import('../../packages/extension/src/background/control-state.ts');
    expect(await state.loadControlState()).toEqual({ consent: 'undecided', paused: true });

    await state.setConsent(true);
    expect(state.isPaused()).toBe(true);
  });

  it('a failed write is in effect all the same, and the reply says it was not saved', async () => {
    installFakeBrowser();
    (globalThis as { browser: { storage: unknown } }).browser.storage = {
      local: { set: async () => { throw new Error('storage full'); } },
    };
    const state = await import('../../packages/extension/src/background/control-state.ts');
    expect(await state.setPaused(true)).toEqual({ consent: 'undecided', paused: true, saved: false });
    expect(state.isPaused()).toBe(true);
    expect(await state.setConsent(true)).toEqual({ consent: 'granted', paused: true, saved: false });
  });

  it.each([
    ['an unsaved change', { consent: 'granted', paused: true, saved: false }, { consent: 'granted', paused: true, saved: false }],
    ['a saved change', { consent: 'granted', paused: true, saved: true }, { consent: 'granted', paused: true, saved: true }],
    ['GET (nothing written)', { consent: 'granted', paused: true }, { consent: 'granted', paused: true, saved: true }],
    ['a refusal', { success: false, error: 'Refused' }, null],
  ])('the pages read the reply to %s (requestControl)', async (_label, reply, expected) => {
    (globalThis as { browser?: unknown }).browser = { runtime: { sendMessage: async () => reply } };
    expect(await requestControl({ type: CONTROL_MESSAGE.GET })).toEqual(expected);
  });

  it('a failed control request reads as null', async () => {
    (globalThis as { browser?: unknown }).browser = { runtime: { sendMessage: async () => { throw new Error('no background'); } } };
    expect(await requestControl({ type: CONTROL_MESSAGE.GET })).toBeNull();
  });

  it('a change applies at once, reaches the hook with its kind and is saved', async () => {
    const fake = installFakeBrowser();
    const state = await import('../../packages/extension/src/background/control-state.ts');
    const hook = vi.fn();
    state.setControlHook(hook);

    const saving = state.setPaused(true);
    expect(state.isPaused()).toBe(true); // before the write settles
    await saving;
    await state.setConsent(true);
    expect(hook.mock.calls).toEqual([
      [{ consent: 'undecided', paused: true }, 'paused'],
      [{ consent: 'granted', paused: true }, 'consent'],
    ]);
    expect(fake.storage).toEqual({ consent: 'granted', paused: true });
  });
});

// ---------------------------------------------------------------------------
// dispatch.ts: the pause switch and the running-command badge
// ---------------------------------------------------------------------------

describe('dispatch: paused and running commands', () => {
  async function loadDispatch() {
    const posted: Record<string, unknown>[] = [];
    vi.doMock('../../packages/extension/src/background/native-connection.ts', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      postToHost: (message: Record<string, unknown>) => { posted.push(message); return true; },
    }));
    const fake = installFakeBrowser();
    const state = await import('../../packages/extension/src/background/control-state.ts');
    const { handleCommand } = await import('../../packages/extension/src/background/dispatch.ts');
    await state.setConsent(true);
    return { fake, state, handleCommand, posted };
  }

  it('while paused every command from the host is refused with "paused", before any handler runs', async () => {
    const { fake, state, handleCommand, posted } = await loadDispatch();
    await state.setPaused(true);

    const result = await handleCommand({ action: 'get_tabs', requestId: 'r-1' }, 'host');
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^paused: /) });
    expect(posted).toEqual([{ requestId: 'r-1', success: false, error: result.error, safetyDecision: 'paused' }]);
    expect(fake.tabQueries).toBe(0);
    // A refused command is not shown as running.
    expect(fake.badgeText).not.toContain('●');
  });

  it("the popup's own commands still run while paused, and host commands again once resumed", async () => {
    const { fake, state, handleCommand } = await loadDispatch();
    await state.setPaused(true);
    expect(await handleCommand({ action: 'getTabs' }, 'page')).toMatchObject({ success: true });
    expect(fake.tabQueries).toBe(1);

    await state.setPaused(false);
    expect(await handleCommand({ action: 'get_tabs', requestId: 'r-2' }, 'host')).toMatchObject({ success: true });
    expect(fake.tabQueries).toBe(2);
  });

  it('the badge shows a running host command until it ends, not a popup command', async () => {
    const { fake, handleCommand } = await loadDispatch();
    let release!: () => void;
    fake.tabQueryGate = new Promise((resolve) => { release = resolve; });

    const running = handleCommand({ action: 'get_tabs', requestId: 'r-3' }, 'host');
    await vi.waitFor(() => expect(fake.tabQueries).toBe(1));
    expect(fake.badgeText.at(-1)).toBe('●');
    release();
    await running;
    expect(fake.badgeText.at(-1)).toBe('');

    fake.tabQueryGate = null;
    const before = fake.badgeText.length;
    await handleCommand({ action: 'getTabs' }, 'page');
    expect(fake.badgeText.slice(before)).not.toContain('●');
  });
});

// ---------------------------------------------------------------------------
// listeners.ts: who may read or change the choices; the first install
// ---------------------------------------------------------------------------

describe('listeners: consent page and pause switch messages', () => {
  async function loadListeners() {
    const fake = installFakeBrowser();
    const { registerListeners } = await import('../../packages/extension/src/background/listeners.ts');
    const state = await import('../../packages/extension/src/background/control-state.ts');
    registerListeners();
    const send = (message: unknown, sender: browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => { fake.onMessage.fire(message, sender, resolve); });
    return { fake, state, send };
  }

  const pageTab = { id: 4, url: 'https://app.example.test/', active: true, windowId: 1, index: 0, pinned: false, status: 'complete', discarded: false, audible: false };
  const contentScript: browser.runtime.MessageSender = { id: EXTENSION_ID, url: pageTab.url, tab: pageTab };
  const popup: browser.runtime.MessageSender = { id: EXTENSION_ID, url: POPUP_URL };
  const popupInTab: browser.runtime.MessageSender = { ...popup, tab: { ...pageTab, id: 9, url: POPUP_URL } };
  const consentPage: browser.runtime.MessageSender = { id: EXTENSION_ID, url: CONSENT_URL, tab: { ...pageTab, id: 7, url: CONSENT_URL } };
  const REFUSED = { success: false, error: expect.stringMatching(/^Refused/) };

  it('opens the consent page on the first install only', async () => {
    const { fake } = await loadListeners();
    fake.onInstalled.fire({ reason: 'update' });
    fake.onInstalled.fire({ reason: 'browser_update' });
    expect(fake.createdTabs).toEqual([]);
    fake.onInstalled.fire({ reason: 'install' });
    await vi.waitFor(() => expect(fake.createdTabs).toEqual([CONSENT_URL]));
  });

  it('only the consent page records the consent', async () => {
    const { state, send } = await loadListeners();
    for (const sender of [contentScript, popup, popupInTab]) {
      expect(await send({ type: CONTROL_MESSAGE.SET_CONSENT, granted: true }, sender)).toEqual(REFUSED);
    }
    expect(await send({ type: CONTROL_MESSAGE.SET_CONSENT, granted: 'yes' }, consentPage)).toEqual(REFUSED);
    expect(state.controlView().consent).toBe('undecided');

    expect(await send({ type: CONTROL_MESSAGE.SET_CONSENT, granted: true }, consentPage)).toEqual({ consent: 'granted', paused: false, saved: true });
    expect(await send({ type: CONTROL_MESSAGE.SET_CONSENT, granted: false }, consentPage)).toEqual({ consent: 'denied', paused: false, saved: true });
  });

  it('only the toolbar popup switches the pause, and a content script cannot read either', async () => {
    const { state, send } = await loadListeners();
    await state.setPaused(true);
    for (const sender of [contentScript, popupInTab, consentPage]) {
      expect(await send({ type: CONTROL_MESSAGE.SET_PAUSED, paused: false }, sender)).toEqual(REFUSED);
    }
    expect(state.isPaused()).toBe(true);
    expect(await send({ type: CONTROL_MESSAGE.GET }, contentScript)).toEqual(REFUSED);

    expect(await send({ type: CONTROL_MESSAGE.SET_PAUSED, paused: false }, popup)).toEqual({ consent: 'undecided', paused: false, saved: true });
    expect(await send({ type: CONTROL_MESSAGE.GET }, consentPage)).toEqual({ consent: 'undecided', paused: false });
  });
});

// ---------------------------------------------------------------------------
// background.ts: the startup order (source check: the entry cannot be imported)
// ---------------------------------------------------------------------------

describe('background.ts startup', () => {
  const entry = readExtensionSource('background.ts');

  it('connects only through the saved consent, never unconditionally at load time', () => {
    expect(entry).not.toMatch(/^connectNativeHost\(\);$/m);
    expect(entry).toMatch(/^void loadControlState\(\)\.then\(/m);
    expect(entry).toContain('setConnectionAllowed(allowed);');
  });
});
