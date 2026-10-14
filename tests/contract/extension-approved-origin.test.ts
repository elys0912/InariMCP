/**
 * Extension: an acting command runs only on the page it was approved for.
 * The background checks the approval against the target tab's URL and puts
 * that URL's origin (scheme, host and port: site-origin.ts) into the command
 * for the content script (background/action-table.ts toContentScript); the
 * content script refuses it when its page is no longer on that origin, just
 * before it would act (content/handler.ts). Runs against a fake `browser`
 * and, for the content script, a fake `window` / `document`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_TABLE } from '../../packages/extension/src/background/action-table.ts';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';
import { approvalOriginOf } from '../../packages/extension/src/site-origin.ts';

const TAB = { id: 3, url: 'https://app.example.test:8443/form?step=2' };

/** Messages the background handed to the content script. */
let sent: Record<string, unknown>[] = [];

beforeEach(() => {
  sent = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  (globalThis as { browser?: unknown }).browser = {
    tabs: {
      query: async () => [TAB],
      get: async () => TAB,
      sendMessage: async (_id: number, message: Record<string, unknown>) => {
        sent.push(message);
        return {};
      },
    },
  };
});
afterEach(() => {
  for (const name of ['browser', 'window', 'document']) delete (globalThis as Record<string, unknown>)[name];
  vi.restoreAllMocks();
});

describe('site-origin.ts approvalOriginOf', () => {
  it.each([
    ['https://App.Example.test/a?b#c', 'https://app.example.test'],
    ['HTTPS://APP.example.test/', 'https://app.example.test'],
    ['https://Bücher.example/', 'https://xn--bcher-kva.example'],
    ['blob:https://app.example.test/0b1c', 'blob://'],
    ['data:text/html,x', 'data://'],
    ['https://app.example.test:443/', 'https://app.example.test'],
    ['http://localhost:3000/x', 'http://localhost:3000'],
    ['file:///home/page.html', 'file://'],
    ['about:blank', 'about://'],
    ['not a url', null],
    [undefined, null],
  ])('%s → %s', (url, origin) => {
    expect(approvalOriginOf(url)).toBe(origin);
  });
});

describe('background: the origin an acting command was approved on', () => {
  it('an acting command carries the origin of the tab it was approved on', async () => {
    const result = await handleCommand(
      { action: 'click', requestId: 'c-1', data: { selector: '#go' }, approvedHost: 'app.example.test' },
      'host',
    );
    expect(result).toMatchObject({ success: true });
    expect(sent).toEqual([{ selector: '#go', approvedOrigin: 'https://app.example.test:8443', pauseCount: 0, action: 'click' }]);
  });

  it("the command's data cannot set it", async () => {
    await handleCommand(
      { action: 'type', requestId: 't-1', data: { text: 'x', approvedOrigin: 'https://evil.test' }, approvedHost: 'app.example.test' },
      'host',
    );
    expect(sent[0]).toMatchObject({ approvedOrigin: 'https://app.example.test:8443' });

    await handleCommand({ action: 'scroll', requestId: 's-1', data: { approvedOrigin: 'https://evil.test' } }, 'host');
    expect(sent[1]!.approvedOrigin).toBeUndefined();
  });

  it('a command that does not act carries none', async () => {
    await handleCommand({ action: 'wait_for_element', requestId: 'w-1', data: { selector: '#x' } }, 'host');
    expect(sent[0]!.approvedOrigin).toBeUndefined();
  });

  // Every "act" row that goes to the content script carries it: the content
  // script checks only what carries one, so a row that lost it would act
  // unchecked.
  const ACT_ROWS = [...ACTION_TABLE].filter(([, row]) => row.approval === 'act').map(([name]) => name);

  it.each(ACT_ROWS)('the "act" row %s: a content script command carries the origin', async (action) => {
    await handleCommand({ action, tabId: TAB.id, data: { selector: '#go', text: 'x' }, approvedHost: 'app.example.test' }, 'page');
    for (const message of sent) expect(message).toMatchObject({ approvedOrigin: 'https://app.example.test:8443' });
  });

  it('the rows that reach the content script are the acting ones it knows', async () => {
    const reached: string[] = [];
    for (const action of ACT_ROWS) {
      sent = [];
      await handleCommand({ action, tabId: TAB.id, data: { selector: '#go' }, approvedHost: 'app.example.test' }, 'page');
      if (sent.length > 0) reached.push(action);
    }
    expect(reached).toEqual(expect.arrayContaining(['click', 'type', 'setValue', 'selectOption', 'clickAndWait', 'pressKey']));
  });
});

describe('content: an acting command on a page that left the approved origin', () => {
  /** The content script of a page at `href` (captureFullPage reads only the sizes). */
  async function contentAt(href: string) {
    (globalThis as Record<string, unknown>).window = { location: { href }, innerHeight: 600, innerWidth: 800 };
    (globalThis as Record<string, unknown>).document = { documentElement: { scrollHeight: 1_000, scrollWidth: 800 } };
    const { handleRequest } = await import('../../packages/extension/src/content/handler.ts');
    return handleRequest;
  }

  it.each([
    ['another host', 'https://other.example.test:8443/form'],
    ['another port', 'https://app.example.test:9443/form'],
    ['another scheme', 'http://app.example.test:8443/form'],
  ])('%s: refused before it acts, with the page it is on now', async (_label, href) => {
    const handleRequest = await contentAt(href);
    const result = await handleRequest({ action: 'captureFullPage', approvedOrigin: 'https://app.example.test:8443' });
    expect(result).toEqual({
      success: false,
      safetyDecision: 'confirmation_required',
      error: expect.stringMatching(/^Human approval required: /),
      url: href,
    });
  });

  it('the same origin (any path): it runs', async () => {
    const handleRequest = await contentAt('https://app.example.test:8443/other?page=3');
    await expect(handleRequest({ action: 'captureFullPage', approvedOrigin: 'https://app.example.test:8443' }))
      .resolves.toEqual({ scrollHeight: 1_000, scrollWidth: 800, viewportHeight: 600, viewportWidth: 800 });
  });

  it('a malformed origin is refused', async () => {
    const handleRequest = await contentAt('https://app.example.test:8443/');
    await expect(handleRequest({ action: 'captureFullPage', approvedOrigin: 42 })).resolves
      .toMatchObject({ success: false, safetyDecision: 'confirmation_required' });
  });

  it('a command without an origin (not an acting one) is not checked', async () => {
    const handleRequest = await contentAt('https://app.example.test:8443/');
    await expect(handleRequest({ action: 'captureFullPage' })).resolves.toMatchObject({ scrollHeight: 1_000 });
  });
});
