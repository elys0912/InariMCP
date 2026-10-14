/**
 * Extension: the first-run consent and the pause switch (user-control.ts,
 * background/control-state.ts), against a fake `browser`. Covers
 *   - no Native Messaging connection before the user allowed it, one after,
 *     and none of the reconnect timers once it is withdrawn;
 *   - every command from the Native Host refused while paused (the popup's
 *     own commands still run), and the badge while a command runs;
 *   - who may read or change the consent and the pause switch, and the
 *     consent page opened on the first install only;
 *   - the screenshot entry of the page menu only while the consent is given,
 *     and the privacy policy link in the UI language.
 * Modules with state are loaded afresh per test (vi.resetModules).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_PAGE_PATH, CONTROL_MESSAGE, privacyPolicyUrl, requestControl } from '../../packages/extension/src/user-control.ts';

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
  /** Ids of the context menu entries there are now. */
  menus: string[];
  /** Titles of the OS notifications shown. */
  notifications: string[];
  onMenuClicked: ReturnType<typeof fakeEvent>;
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
    menus: [],
    notifications: [],
    onMenuClicked: fakeEvent(),
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
    contextMenus: {
      create: ({ id }: { id: string }) => {
        if (fake.menus.includes(id)) throw new Error(`duplicate menu id ${id}`);
        fake.menus.push(id);
      },
      remove: async (id: string) => {
        if (!fake.menus.includes(id)) throw new Error(`no menu id ${id}`);
        fake.menus.splice(fake.menus.indexOf(id), 1);
      },
      onClicked: fake.onMenuClicked,
    },
    notifications: {
      create: async ({ title }: { title: string }) => { fake.notifications.push(title); return 'n-1'; },
    },
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
  vi.doUnmock('../../packages/extension/src/background/screenshot.ts');
});

// ---------------------------------------------------------------------------
// native-connection.ts: no connection before consent
// ---------------------------------------------------------------------------

/**
 * Long enough for every reconnect timer of native-connection.ts to have fired
 * several times (the longest are TIMEOUTS.RECONNECT_MAX, 30 s, and
 * TIMEOUTS.RECONNECT_RESTART, 60 s): a port that no timer opened by then is
 * never opened by one.
 */
const PAST_ALL_RECONNECTS_MS = 5 * 60_000;

describe('native connection before and after consent', () => {
  async function loadNativeConnection() {
    const fake = installFakeBrowser();
    const mod = await import('../../packages/extension/src/background/native-connection.ts');
    const hooks = { onCommand: vi.fn(), onConfirmed: vi.fn(), onDisconnected: vi.fn() };
    mod.setConnectionHooks(hooks);
    return { fake, mod, hooks };
  }

  /** Consent given, the port open with one request waiting, then the consent withdrawn. */
  async function withdrawAfterConnecting() {
    vi.useFakeTimers();
    const loaded = await loadNativeConnection();
    loaded.mod.setConnectionAllowed(true);
    loaded.mod.connectNativeHost();
    const port = loaded.fake.ports[0]!;
    const pending = loaded.mod.sendToNativeHost({ action: 'status' }).then(() => 'resolved', (e: Error) => e.message);

    loaded.mod.setConnectionAllowed(false);
    return { ...loaded, port, pending };
  }

  it('before consent a request is refused without a port', async () => {
    vi.useFakeTimers();
    const { fake, mod } = await loadNativeConnection();
    const request = mod.sendToNativeHost({ action: 'status' }).then(() => 'resolved', (e: Error) => e.message);
    expect(await request).toMatch(/^Not allowed to connect/);
    expect(fake.ports).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(PAST_ALL_RECONNECTS_MS);
    expect(fake.ports).toHaveLength(0);
  });

  it('before consent nothing opens a port: not a connect, a recheck or the timers', async () => {
    vi.useFakeTimers();
    const { fake, mod } = await loadNativeConnection();
    mod.connectNativeHost();
    mod.recheckHost();

    await vi.advanceTimersByTimeAsync(PAST_ALL_RECONNECTS_MS);
    expect(fake.ports).toHaveLength(0);
    expect(mod.hostStatus()).toEqual({ confirmed: false, portOpen: false, lastError: null });
  });

  it('allowing the connection does not connect by itself', async () => {
    const { fake, mod } = await loadNativeConnection();
    mod.setConnectionAllowed(true);
    expect(fake.ports).toHaveLength(0);
  });

  it('after consent the connection opens and pings the host', async () => {
    const { fake, mod } = await loadNativeConnection();
    mod.setConnectionAllowed(true);
    mod.recheckHost();
    expect(fake.ports).toHaveLength(1);
    expect(fake.ports[0]!.posted.map((m) => m.action)).toEqual(['ping']);
  });

  it('withdrawing consent closes the port and reports the disconnect once', async () => {
    const { mod, hooks, port } = await withdrawAfterConnecting();
    expect(port.disconnected).toBe(true);
    expect(hooks.onDisconnected).toHaveBeenCalledTimes(1);
    expect(mod.hostStatus().portOpen).toBe(false);
  });

  it('withdrawing consent fails the requests that wait for the port', async () => {
    const { pending } = await withdrawAfterConnecting();
    expect(await pending).toMatch(/^Not allowed to connect/);
  });

  it('withdrawing consent stops the reconnects, even after a late onDisconnect of the old port', async () => {
    const { fake, port } = await withdrawAfterConnecting();
    port.onDisconnect.fire(port);
    await vi.advanceTimersByTimeAsync(PAST_ALL_RECONNECTS_MS);
    expect(fake.ports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// control-state.ts: storage.local
// ---------------------------------------------------------------------------

describe('control-state: saved choices', () => {
  it.each([
    ['the saved consent and pause switch', { consent: 'granted', paused: true }, { consent: 'granted', paused: true }],
    ['a denied consent', { consent: 'denied', paused: false }, { consent: 'denied', paused: false }],
    ['other values as undecided and not paused', { consent: 'yes', paused: 'true' }, { consent: 'undecided', paused: false }],
    ['nothing saved as undecided and not paused', {}, { consent: 'undecided', paused: false }],
  ])('loads %s', async (_label, stored, expected) => {
    installFakeBrowser(stored);
    const state = await import('../../packages/extension/src/background/control-state.ts');
    expect(await state.loadControlState()).toEqual(expected);
  });

  it('a failed read leaves no consent and pauses', async () => {
    installFakeBrowser();
    (globalThis as { browser: { storage: unknown } }).browser.storage = {
      local: { get: async () => { throw new Error('storage broken'); }, set: async () => {} },
    };
    const state = await import('../../packages/extension/src/background/control-state.ts');
    expect(await state.loadControlState()).toEqual({ consent: 'undecided', paused: true });
  });

  it('after a failed read, allowing again does not lift a saved pause', async () => {
    installFakeBrowser();
    (globalThis as { browser: { storage: unknown } }).browser.storage = {
      local: { get: async () => { throw new Error('storage broken'); }, set: async () => {} },
    };
    const state = await import('../../packages/extension/src/background/control-state.ts');
    await state.loadControlState();
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

  /** control-state.ts with a hook set, and the fake browser it saves to. */
  async function loadWithHook() {
    const fake = installFakeBrowser();
    const state = await import('../../packages/extension/src/background/control-state.ts');
    const hook = vi.fn();
    state.setControlHook(hook);
    return { fake, state, hook };
  }

  it('a change applies before its write settles', async () => {
    const { state } = await loadWithHook();
    const saving = state.setPaused(true);
    expect(state.isPaused()).toBe(true);
    await saving;
  });

  it('each change reaches the hook with the new view and its kind', async () => {
    const { state, hook } = await loadWithHook();
    await state.setPaused(true);
    await state.setConsent(true);
    expect(hook.mock.calls).toEqual([
      [{ consent: 'undecided', paused: true }, 'paused'],
      [{ consent: 'granted', paused: true }, 'consent'],
    ]);
  });

  it('each change is saved in storage.local', async () => {
    const { fake, state } = await loadWithHook();
    await state.setPaused(true);
    await state.setConsent(true);
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

  it("the popup's own commands still run while paused", async () => {
    const { fake, state, handleCommand } = await loadDispatch();
    await state.setPaused(true);
    expect(await handleCommand({ action: 'getTabs' }, 'page')).toMatchObject({ success: true });
    expect(fake.tabQueries).toBe(1);
  });

  it('host commands run again once resumed', async () => {
    const { fake, state, handleCommand } = await loadDispatch();
    await state.setPaused(true);
    await state.setPaused(false);
    expect(await handleCommand({ action: 'get_tabs', requestId: 'r-2' }, 'host')).toMatchObject({ success: true });
    expect(fake.tabQueries).toBe(1);
  });

  it('the badge shows a running host command until it ends', async () => {
    const { fake, handleCommand } = await loadDispatch();
    let release!: () => void;
    fake.tabQueryGate = new Promise((resolve) => { release = resolve; });

    const running = handleCommand({ action: 'get_tabs', requestId: 'r-3' }, 'host');
    await vi.waitFor(() => expect(fake.tabQueries).toBe(1));
    expect(fake.badgeText.at(-1)).toBe('●');
    release();
    await running;
    expect(fake.badgeText.at(-1)).toBe('');
  });

  it('the badge does not show a popup command as running', async () => {
    const { fake, handleCommand } = await loadDispatch();
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

  const pageTab = {
    id: 4,
    url: 'https://app.example.test/',
    active: true,
    windowId: 1,
    index: 0,
    pinned: false,
    status: 'complete',
    discarded: false,
    audible: false,
  };
  const contentScript: browser.runtime.MessageSender = { id: EXTENSION_ID, url: pageTab.url, tab: pageTab };
  const popup: browser.runtime.MessageSender = { id: EXTENSION_ID, url: POPUP_URL };
  const popupInTab: browser.runtime.MessageSender = { ...popup, tab: { ...pageTab, id: 9, url: POPUP_URL } };
  const consentPage: browser.runtime.MessageSender = { id: EXTENSION_ID, url: CONSENT_URL, tab: { ...pageTab, id: 7, url: CONSENT_URL } };
  const REFUSED = { success: false, error: expect.stringMatching(/^Refused/) };

  it.each(['update', 'browser_update'])('does not open the consent page on an install of reason %s', async (reason) => {
    const { fake } = await loadListeners();
    fake.onInstalled.fire({ reason });
    // A tab is opened asynchronously: let the listener's promises settle first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.createdTabs).toEqual([]);
  });

  it('opens the consent page on the first install', async () => {
    const { fake } = await loadListeners();
    fake.onInstalled.fire({ reason: 'install' });
    await vi.waitFor(() => expect(fake.createdTabs).toEqual([CONSENT_URL]));
  });

  it.each([
    ['a content script', contentScript],
    ['the toolbar popup', popup],
    ['the popup opened in a tab', popupInTab],
  ])('%s cannot record the consent', async (_label, sender) => {
    const { state, send } = await loadListeners();
    expect(await send({ type: CONTROL_MESSAGE.SET_CONSENT, granted: true }, sender)).toEqual(REFUSED);
    expect(state.controlView().consent).toBe('undecided');
  });

  it('the consent page cannot record a consent that is not a boolean', async () => {
    const { state, send } = await loadListeners();
    expect(await send({ type: CONTROL_MESSAGE.SET_CONSENT, granted: 'yes' }, consentPage)).toEqual(REFUSED);
    expect(state.controlView().consent).toBe('undecided');
  });

  it.each([
    [true, { consent: 'granted', paused: false, saved: true }],
    [false, { consent: 'denied', paused: false, saved: true }],
  ])('the consent page records the consent %s', async (granted, expected) => {
    const { send } = await loadListeners();
    expect(await send({ type: CONTROL_MESSAGE.SET_CONSENT, granted }, consentPage)).toEqual(expected);
  });

  it.each([
    ['a content script', contentScript],
    ['the popup opened in a tab', popupInTab],
    ['the consent page', consentPage],
  ])('%s cannot switch the pause', async (_label, sender) => {
    const { state, send } = await loadListeners();
    await state.setPaused(true);
    expect(await send({ type: CONTROL_MESSAGE.SET_PAUSED, paused: false }, sender)).toEqual(REFUSED);
    expect(state.isPaused()).toBe(true);
  });

  it('the toolbar popup switches the pause', async () => {
    const { state, send } = await loadListeners();
    await state.setPaused(true);
    expect(await send({ type: CONTROL_MESSAGE.SET_PAUSED, paused: false }, popup)).toEqual({ consent: 'undecided', paused: false, saved: true });
  });

  it('a content script cannot read the choices', async () => {
    const { send } = await loadListeners();
    expect(await send({ type: CONTROL_MESSAGE.GET }, contentScript)).toEqual(REFUSED);
  });

  it('the consent page reads the choices', async () => {
    const { send } = await loadListeners();
    expect(await send({ type: CONTROL_MESSAGE.GET }, consentPage)).toEqual({ consent: 'undecided', paused: false });
  });
});

// ---------------------------------------------------------------------------
// context-menu.ts: the screenshot entry follows the consent
// ---------------------------------------------------------------------------

describe('context menu: the screenshot entry', () => {
  it('appears only while the consent is given, once, and goes when it is withdrawn', async () => {
    const fake = installFakeBrowser();
    const menu = await import('../../packages/extension/src/background/context-menu.ts');
    menu.registerContextMenuListener();
    expect(fake.menus).toEqual([]); // loading adds no entry

    menu.setScreenshotMenu(false); // still undecided or denied: nothing to remove
    menu.setScreenshotMenu(true);
    menu.setScreenshotMenu(true); // granted again (startup, then the page): one entry
    expect(fake.menus).toEqual(['inari-screenshot']);

    menu.setScreenshotMenu(false);
    await vi.waitFor(() => expect(fake.menus).toEqual([]));
  });

  it.each([
    [true, []],
    [false, ['msg:notifyScreenshotNotSentTitle']],
  ])('a click hands the screenshot to the host (connected: %s), or says it was not sent', async (connected, shown) => {
    const posted: Record<string, unknown>[] = [];
    vi.doMock('../../packages/extension/src/background/native-connection.ts', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      postToHost: (message: Record<string, unknown>) => { posted.push(message); return connected; },
    }));
    vi.doMock('../../packages/extension/src/background/screenshot.ts', () => ({
      takeScreenshot: async () => ({ success: true, imageData: 'data:image/png;base64,AA' }),
    }));
    const fake = installFakeBrowser();
    const menu = await import('../../packages/extension/src/background/context-menu.ts');
    menu.registerContextMenuListener();

    fake.onMenuClicked.fire({ menuItemId: 'inari-screenshot' }, { id: 3, url: 'https://a.test/', title: 'A' });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ action: 'screenshotTaken', data: 'data:image/png;base64,AA', tab: { id: 3 } });
    await vi.waitFor(() => expect(fake.notifications).toEqual(shown));
  });
});

// ---------------------------------------------------------------------------
// user-control.ts: the privacy policy linked from the consent page
// ---------------------------------------------------------------------------

describe('privacy policy link', () => {
  it.each([
    ['ja', 'PRIVACY.ja.md'],
    ['ja-JP', 'PRIVACY.ja.md'],
    ['en-US', 'PRIVACY.md'],
    ['jam', 'PRIVACY.md'],
    ['', 'PRIVACY.md'],
  ])('UI language %j links %s on main', (lang, file) => {
    expect(privacyPolicyUrl(lang)).toBe(`https://github.com/elys0912/InariMCP/blob/main/docs/${file}`);
  });
});

// ---------------------------------------------------------------------------
// background.ts: the startup (the entry loaded against the fake browser)
// ---------------------------------------------------------------------------

describe('background.ts startup', () => {
  /** background.ts loaded with `stored` saved, its startup (loadControlState, applyConsent) run. */
  async function startBackground(stored: Record<string, unknown>): Promise<FakeBrowser> {
    vi.useFakeTimers();
    const fake = installFakeBrowser(stored);
    await import('../../packages/extension/src/background.ts');
    await vi.advanceTimersByTimeAsync(0);
    return fake;
  }

  it('connects with the saved consent', async () => {
    const fake = await startBackground({ consent: 'granted' });
    expect(fake.ports).toHaveLength(1);
  });

  it('adds the screenshot menu entry with the saved consent', async () => {
    const fake = await startBackground({ consent: 'granted' });
    expect(fake.menus).toEqual(['inari-screenshot']);
  });

  it.each([
    ['nothing saved', {}],
    ['a denied consent', { consent: 'denied' }],
  ])('opens no port with %s, also after the reconnect timers', async (_label, stored) => {
    const fake = await startBackground(stored);
    await vi.advanceTimersByTimeAsync(PAST_ALL_RECONNECTS_MS);
    expect(fake.ports).toHaveLength(0);
    expect(fake.menus).toEqual([]);
  });
});
