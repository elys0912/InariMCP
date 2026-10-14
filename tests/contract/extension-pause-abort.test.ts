/**
 * Extension: the pause switch stops what is already running. The background
 * looks at the switch again after the checks and answers a running command
 * from the Native Host at once when the pause comes (background/dispatch.ts),
 * and tells the target tab's content script to stop; there the typing loop,
 * the waits and scroll_and_capture end at their next step (content/abort.ts,
 * sleep() of content/dom.ts). Runs against a fake `browser` and, for the
 * content modules, fake DOM globals (no real browser).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ABORT_REQUEST_TYPE } from '../../packages/extension/src/content/constants.ts';

const TAB = { id: 5, url: 'https://app.example.test/page' };
const ABORT_REQUEST = { type: ABORT_REQUEST_TYPE };

/** What a test leaves on globalThis, removed after each test. */
const GLOBALS = ['browser', 'window', 'document', 'KeyboardEvent', 'MutationObserver'] as const;

function setGlobal(name: (typeof GLOBALS)[number], value: unknown): void {
  (globalThis as Record<string, unknown>)[name] = value;
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const name of GLOBALS) delete (globalThis as Record<string, unknown>)[name];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../../packages/extension/src/background/native-connection.ts');
});

// ---------------------------------------------------------------------------
// background/dispatch.ts
// ---------------------------------------------------------------------------

describe('dispatch: a pause while a host command is in progress', () => {
  interface FakeTabs {
    /** Every message sent to a content script, with its frame. */
    sent: { tabId: number; message: Record<string, unknown>; frameId: number | undefined }[];
    /** When set, tabs.get waits for it (the checks are still running). */
    getGate: Promise<void> | null;
  }

  async function loadDispatch() {
    const posted: Record<string, unknown>[] = [];
    vi.doMock('../../packages/extension/src/background/native-connection.ts', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      postToHost: (message: Record<string, unknown>) => { posted.push(message); return true; },
    }));
    const tabs: FakeTabs = { sent: [], getGate: null };
    setGlobal('browser', {
      storage: { local: { set: async () => {} } },
      tabs: {
        get: async () => {
          if (tabs.getGate !== null) await tabs.getGate;
          return TAB;
        },
        query: async () => [TAB],
        // A command's answer never comes: the content script is still waiting.
        sendMessage: (tabId: number, message: Record<string, unknown>, options?: { frameId?: number }) => {
          tabs.sent.push({ tabId, message, frameId: options?.frameId });
          return message.type === ABORT_REQUEST_TYPE ? Promise.resolve({ success: true }) : new Promise(() => {});
        },
      },
    });
    const state = await import('../../packages/extension/src/background/control-state.ts');
    const { handleCommand } = await import('../../packages/extension/src/background/dispatch.ts');
    return { state, handleCommand, posted, tabs };
  }

  it('a running wait is answered "paused" at once, and its tab is told to stop', async () => {
    const { state, handleCommand, posted, tabs } = await loadDispatch();
    const running = handleCommand({ action: 'wait_for_element', requestId: 'w-1', data: { selector: '#late' } }, 'host');
    await vi.waitFor(() => expect(tabs.sent).toHaveLength(1));

    await state.setPaused(true);
    await expect(running).resolves.toMatchObject({ success: false, safetyDecision: 'paused' });
    expect(posted).toEqual([expect.objectContaining({ requestId: 'w-1', safetyDecision: 'paused' })]);
    expect(tabs.sent.at(-1)).toEqual({ tabId: TAB.id, message: ABORT_REQUEST, frameId: 0 });
  });

  it('a pause during the checks refuses the command before its handler runs', async () => {
    const { state, handleCommand, posted, tabs } = await loadDispatch();
    let release!: () => void;
    tabs.getGate = new Promise((resolve) => { release = resolve; });
    const running = handleCommand({ action: 'scroll', requestId: 's-1', tabId: TAB.id, data: { direction: 'down' } }, 'host');

    await state.setPaused(true);
    release();
    await expect(running).resolves.toMatchObject({ success: false, safetyDecision: 'paused' });
    expect(tabs.sent).toEqual([]);
    expect(posted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// content/handler.ts, content/abort.ts
// ---------------------------------------------------------------------------

/** A text field that records what was typed into it (enough for performType). */
function fakeField() {
  return {
    localName: 'input',
    tagName: 'INPUT',
    type: 'text',
    value: '',
    closest: () => null,
    getAttribute: () => null,
    focus: () => {},
    scrollIntoView: () => {},
    dispatchEvent: () => true,
  };
}

class FakeKeyboardEvent extends Event {}

type MutationCallback = (records: Partial<MutationRecord>[]) => void;

/** MutationObserver whose changes the test reports (emit); records its disconnect. */
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: MutationCallback) { FakeMutationObserver.instances.push(this); }
  observe(): void {}
  disconnect(): void { this.disconnected = true; }
  emit(...types: MutationRecordType[]): void {
    this.callback(types.map((type) => ({ type, target: { tagName: 'P' } as unknown as Node, addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList })));
  }
}

/** A page that is endlessly long: scroll_and_capture never reaches its end. */
function installEndlessPage(): { scrolls: number } {
  const page = { scrolls: 0 };
  const win = {
    innerHeight: 100,
    innerWidth: 100,
    scrollY: 0,
    scrollTo: () => {},
    scrollBy: ({ top }: { top: number }) => { win.scrollY += top; page.scrolls++; },
  };
  setGlobal('window', win);
  setGlobal('document', {
    body: {},
    documentElement: { scrollHeight: Number.MAX_SAFE_INTEGER },
    querySelectorAll: () => ({ length: 0, item: () => null }),
  });
  return page;
}

async function loadContent() {
  return import('../../packages/extension/src/content/handler.ts');
}

describe('content: the abort of the running commands', () => {
  it('stops the typing loop at its next character', async () => {
    vi.useFakeTimers();
    const field = fakeField();
    setGlobal('document', { activeElement: field, body: {} });
    setGlobal('KeyboardEvent', FakeKeyboardEvent);
    const { handleRequest } = await loadContent();

    const typing = handleRequest({ action: 'type', text: 'abcdefghij', delay: 50 });
    const outcome = typing.then(() => 'typed', (error: Error) => error.message);
    // 100 ms before the first character (scrollIntoView), then 50 ms each.
    await vi.advanceTimersByTimeAsync(100 + 50 * 2);
    expect(await handleRequest(ABORT_REQUEST)).toEqual({ success: true, aborted: true });

    expect(await outcome).toMatch(/^paused: /);
    expect(field.value.length).toBeLessThan(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(field.value.length).toBeLessThan(4);
  });

  it('ends a DOM change wait at once and disconnects its observer', async () => {
    FakeMutationObserver.instances = [];
    setGlobal('document', { body: {} });
    setGlobal('MutationObserver', FakeMutationObserver);
    const { handleRequest } = await loadContent();

    const waiting = handleRequest({ action: 'waitForChange', timeout: 60_000 });
    await handleRequest(ABORT_REQUEST);

    await expect(waiting).rejects.toThrow(/^paused: /);
    expect(FakeMutationObserver.instances.map((o) => o.disconnected)).toEqual([true]);
  });

  it('stops scroll_and_capture at its next step', async () => {
    vi.useFakeTimers();
    const page = installEndlessPage();
    const { handleRequest } = await loadContent();

    const capture = handleRequest({ action: 'scrollAndCapture', delay: 100, maxScrolls: 20 });
    const outcome = capture.then(() => 'completed', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(100 * 3);
    await handleRequest(ABORT_REQUEST);

    expect(await outcome).toMatch(/^paused: /);
    const stoppedAt = page.scrolls;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.scrolls).toBe(stoppedAt);
    expect(stoppedAt).toBeLessThan(20);
  });

  it('a command after the abort runs as usual', async () => {
    vi.useFakeTimers();
    installEndlessPage();
    const { handleRequest } = await loadContent();
    await handleRequest(ABORT_REQUEST);

    const capture = handleRequest({ action: 'scrollAndCapture', delay: 100, maxScrolls: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(capture).resolves.toMatchObject({ completed: true, totalScrolls: 2 });
  });
});

describe('content: waitForChange answers as before', () => {
  async function startWait(options: Record<string, unknown>) {
    FakeMutationObserver.instances = [];
    setGlobal('document', { body: {} });
    setGlobal('MutationObserver', FakeMutationObserver);
    const { handleRequest } = await loadContent();
    const waiting = handleRequest({ action: 'waitForChange', ...options });
    return { waiting, observer: FakeMutationObserver.instances[0]! };
  }

  it('the first change of the changeType ends it', async () => {
    const { waiting, observer } = await startWait({ changeType: 'childList', timeout: 60_000 });
    observer.emit('attributes', 'childList', 'childList');
    await expect(waiting).resolves.toMatchObject({ changed: true, changes: [{ type: 'childList', target: 'p' }] });
    expect(observer.disconnected).toBe(true);
  });

  it('waitForAll collects the changes until the timeout', async () => {
    vi.useFakeTimers();
    const { waiting, observer } = await startWait({ waitForAll: true, timeout: 1_000 });
    observer.emit('attributes');
    observer.emit('characterData');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({
      changed: true,
      changes: [expect.objectContaining({ type: 'attributes' }), expect.objectContaining({ type: 'characterData' })],
      waitedMs: 1_000,
    });
  });

  it('no change until the timeout: timedOut', async () => {
    vi.useFakeTimers();
    const { waiting, observer } = await startWait({ timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({ changed: false, changes: [], waitedMs: 1_000, timedOut: true });
    expect(observer.disconnected).toBe(true);
  });
});

describe('content: scroll_and_capture limits', () => {
  it.each([
    ['the defaults', {}, { delay: 500, maxScrolls: 20 }],
    ['many steps: cut to 50', { maxScrolls: 1_000 }, { delay: 500, maxScrolls: 50 }],
    ['a long delay: cut to 2 s, and to the steps of the 25 s budget', { delay: 60_000, maxScrolls: 50 }, { delay: 2_000, maxScrolls: 12 }],
    ['within the limits: as asked', { delay: 1_000, maxScrolls: 10 }, { delay: 1_000, maxScrolls: 10 }],
  ])('%s', async (_label, options, expected) => {
    const { scrollCaptureLimits } = await import('../../packages/extension/src/content/inspect.ts');
    expect(scrollCaptureLimits(options)).toEqual(expected);
  });

  it('an endless page stops after the most steps', async () => {
    vi.useFakeTimers();
    const page = installEndlessPage();
    const { handleRequest } = await loadContent();

    const capture = handleRequest({ action: 'scrollAndCapture', delay: 10, maxScrolls: 1_000_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(capture).resolves.toMatchObject({ completed: true, totalScrolls: 50 });
    expect(page.scrolls).toBe(50);
  });
});
