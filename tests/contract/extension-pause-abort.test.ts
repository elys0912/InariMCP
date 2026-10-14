/**
 * Extension: the pause switch stops what is already running. The background
 * looks at the switch again after the checks and answers a running command
 * from the Native Host at once when the pause comes (background/dispatch.ts),
 * and tells the target tab's content script to stop; there the typing loop,
 * the waits and scroll_and_capture end at their next step (content/abort.ts,
 * sleep() of content/dom.ts). A command sent before a pause is refused even
 * when it reaches the content script after the abort (its pause count). A
 * pending approval request ends as "cancelled". Runs against a fake `browser`
 * and, for the content modules, fake DOM globals (no real browser).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ABORT_REQUEST_TYPE } from '../../packages/extension/src/content/constants.ts';

const TAB = { id: 5, url: 'https://app.example.test/page' };
/** The abort the background sends at the first pause. */
const ABORT_REQUEST = { type: ABORT_REQUEST_TYPE, pauseCount: 1 };

/** What a test leaves on globalThis, removed after each test. */
const GLOBALS = ['browser', 'window', 'document', 'KeyboardEvent'] as const;

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
    /** Tab lookups (tabs.get and tabs.query) so far. */
    lookups: number;
    /** Lookup number (1-based) → what it waits for before it answers. */
    lookupGates: Map<number, Promise<void>>;
  }

  async function loadDispatch() {
    const posted: Record<string, unknown>[] = [];
    vi.doMock('../../packages/extension/src/background/native-connection.ts', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      postToHost: (message: Record<string, unknown>) => { posted.push(message); return true; },
    }));
    const tabs: FakeTabs = { sent: [], lookups: 0, lookupGates: new Map() };
    const lookUp = async (): Promise<void> => {
      tabs.lookups++;
      await tabs.lookupGates.get(tabs.lookups);
    };
    setGlobal('browser', {
      storage: { local: { set: async () => {} } },
      tabs: {
        get: async () => { await lookUp(); return TAB; },
        query: async () => { await lookUp(); return [TAB]; },
        // A command's answer never comes: the content script is still waiting.
        sendMessage: (tabId: number, message: Record<string, unknown>, options?: { frameId?: number }) => {
          tabs.sent.push({ tabId, message, frameId: options?.frameId });
          return message.type === ABORT_REQUEST_TYPE ? Promise.resolve({ success: true }) : new Promise(() => {});
        },
      },
    });
    const state = await import('../../packages/extension/src/background/control-state.ts');
    const approvals = await import('../../packages/extension/src/background/approvals.ts');
    // As background.ts does: a pause withdraws the open approval requests.
    state.setControlHook((view, change) => { if (change === 'paused' && view.paused) approvals.cancelAllApprovals(); });
    const { handleCommand } = await import('../../packages/extension/src/background/dispatch.ts');
    return { state, approvals, handleCommand, posted, tabs };
  }

  /** A promise and what settles it. */
  function gate(): { opened: Promise<void>; open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  }

  it('a running wait is answered "paused" at once', async () => {
    const { state, handleCommand, posted, tabs } = await loadDispatch();
    const running = handleCommand({ action: 'wait_for_element', requestId: 'w-1', data: { selector: '#late' } }, 'host');
    await vi.waitFor(() => expect(tabs.sent).toHaveLength(1));

    await state.setPaused(true);
    await expect(running).resolves.toMatchObject({ success: false, safetyDecision: 'paused' });
    expect(posted).toEqual([expect.objectContaining({ requestId: 'w-1', safetyDecision: 'paused' })]);
  });

  it('a pause while a command runs tells its tab to stop, with the count of pauses', async () => {
    const { state, handleCommand, tabs } = await loadDispatch();
    void handleCommand({ action: 'wait_for_element', requestId: 'w-2', data: { selector: '#late' } }, 'host');
    await vi.waitFor(() => expect(tabs.sent).toHaveLength(1));
    expect(tabs.sent[0]!.message).toMatchObject({ action: 'waitForElement', pauseCount: 0 });

    await state.setPaused(true);
    expect(tabs.sent.at(-1)).toEqual({ tabId: TAB.id, message: ABORT_REQUEST, frameId: 0 });
  });

  it('a pause during the checks refuses the command before its handler runs', async () => {
    const { state, handleCommand, posted, tabs } = await loadDispatch();
    const checks = gate();
    tabs.lookupGates.set(1, checks.opened);
    const running = handleCommand({ action: 'scroll', requestId: 's-1', data: { direction: 'down' } }, 'host');

    await state.setPaused(true);
    checks.open();
    await expect(running).resolves.toMatchObject({ success: false, safetyDecision: 'paused' });
    expect(tabs.sent).toEqual([]);
    expect(posted).toHaveLength(1);
  });

  it('a pause while the handler finds its tab: the command never reaches the content script', async () => {
    const { state, handleCommand, tabs } = await loadDispatch();
    // Lookup 1: the checks pin the tab. Lookup 2: the handler looks it up again.
    const handlerLookup = gate();
    tabs.lookupGates.set(2, handlerLookup.opened);
    const running = handleCommand({ action: 'scroll', requestId: 's-2', data: { direction: 'down' } }, 'host');
    await vi.waitFor(() => expect(tabs.lookups).toBe(2));

    await state.setPaused(true);
    await expect(running).resolves.toMatchObject({ safetyDecision: 'paused' });
    handlerLookup.open();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tabs.sent.map((s) => s.message)).toEqual([ABORT_REQUEST]);
  });

  it('a pending approval request ends as cancelled, which withdraws it on the MCP Server', async () => {
    const { state, approvals, handleCommand, posted } = await loadDispatch();
    const asking = handleCommand({ action: 'request_approval', requestId: 'a-1', data: { message: 'Proceed?' } }, 'host');
    await vi.waitFor(() => expect(approvals.listApprovals()).toHaveLength(1));

    await state.setPaused(true);
    await expect(asking).resolves.toMatchObject({ success: true, approved: false, cancelled: true });
    expect(posted).toEqual([expect.objectContaining({ requestId: 'a-1', success: true, data: expect.objectContaining({ cancelled: true }) })]);
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

/** A page that is endlessly long: scroll_and_capture never reaches its end. */
function installEndlessPage(): { scrolls: number; scrolledTo: number[] } {
  const page = { scrolls: 0, scrolledTo: [] as number[] };
  const win = {
    innerHeight: 100,
    innerWidth: 100,
    scrollY: 250,
    scrollTo: ({ top }: { top: number }) => { win.scrollY = top; page.scrolledTo.push(top); },
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

    const typing = handleRequest({ action: 'type', text: 'abcdefghij', delay: 50, pauseCount: 0 });
    const outcome = typing.then(() => 'typed', (error: Error) => error.message);
    // 100 ms before the first character (scrollIntoView), then 50 ms each:
    // 'a' at 100 ms, 'b' at 150 ms, 'c' at 200 ms.
    await vi.advanceTimersByTimeAsync(100 + 50 * 2);
    expect(await handleRequest(ABORT_REQUEST)).toEqual({ success: true, aborted: true });

    expect(await outcome).toMatch(/^paused: /);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(field.value).toBe('abc');
  });

  it('ends a DOM change wait at once and disconnects its observer', async () => {
    const observers: { disconnected: boolean }[] = [];
    setGlobal('document', { body: {} });
    vi.stubGlobal('MutationObserver', class {
      disconnected = false;
      constructor() { observers.push(this); }
      observe(): void {}
      disconnect(): void { this.disconnected = true; }
    });
    const { handleRequest } = await loadContent();

    const waiting = handleRequest({ action: 'waitForChange', timeout: 60_000 });
    await handleRequest(ABORT_REQUEST);

    await expect(waiting).rejects.toThrow(/^paused: /);
    expect(observers.map((o) => o.disconnected)).toEqual([true]);
    vi.unstubAllGlobals();
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

  it('scroll_and_capture stopped by the pause puts the page back where it was', async () => {
    vi.useFakeTimers();
    const page = installEndlessPage();
    const { handleRequest } = await loadContent();

    const capture = handleRequest({ action: 'scrollAndCapture', delay: 100, maxScrolls: 20 });
    const outcome = capture.then(() => 'completed', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(100 * 3);
    await handleRequest(ABORT_REQUEST);

    expect(await outcome).toMatch(/^paused: /);
    expect(page.scrolledTo).toEqual([0, 250]);
  });

  it('a command sent before the pause and arriving after its abort is refused before it starts', async () => {
    vi.useFakeTimers();
    const page = installEndlessPage();
    const { handleRequest } = await loadContent();
    await handleRequest(ABORT_REQUEST);

    const late = await handleRequest({ action: 'scrollAndCapture', delay: 100, maxScrolls: 2, pauseCount: 0 });
    expect(late).toMatchObject({ success: false, safetyDecision: 'paused', error: expect.stringMatching(/^paused: /) });
    expect(page.scrolledTo).toEqual([]);
  });

  it('a command sent after the pause was lifted runs as usual', async () => {
    vi.useFakeTimers();
    installEndlessPage();
    const { handleRequest } = await loadContent();
    await handleRequest(ABORT_REQUEST);

    const capture = handleRequest({ action: 'scrollAndCapture', delay: 100, maxScrolls: 2, pauseCount: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(capture).resolves.toMatchObject({ completed: true, totalScrolls: 2 });
  });
});

describe('content: scroll_and_capture limits', () => {
  it.each([
    ['the defaults', {}, { delay: 500, maxScrolls: 20 }],
    ['many steps: cut to 50', { delay: 100, maxScrolls: 1_000 }, { delay: 100, maxScrolls: 50 }],
    ['the 25 s budget counts the first delay too: (49 + 1) x 500 ms', { maxScrolls: 1_000 }, { delay: 500, maxScrolls: 49 }],
    ['a long delay: cut to 2 s, and to the steps of the budget', { delay: 60_000, maxScrolls: 50 }, { delay: 2_000, maxScrolls: 11 }],
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
