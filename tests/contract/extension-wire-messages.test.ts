/**
 * Extension: messages between the background and content scripts. A
 * command's data cannot replace the action the background checked (WP45
 * A-03): content messages are built as `{ ...data, action }`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';

describe('A-03 data.action does not replace the content action', () => {
  afterEach(() => {
    delete (globalThis as { browser?: unknown }).browser;
  });

  it.each([
    ['click', 'click'],
    ['hover', 'hover'],
    ['solve_captcha', 'solveCaptcha'],
  ])('%s with data.action "setValue" sends action %s', async (wireName, contentAction) => {
    const sent: Record<string, unknown>[] = [];
    (globalThis as { browser?: unknown }).browser = {
      i18n: { getMessage: () => '' },
      runtime: { getURL: (p: string) => `moz-extension://test/${p}` },
      tabs: {
        query: async () => [{ id: 1, url: 'https://app.example.test/' }],
        get: async (id: number) => ({ id, url: 'https://app.example.test/' }),
        sendMessage: async (_tabId: number, message: Record<string, unknown>) => {
          sent.push(message);
          return {};
        },
      },
    };
    await handleCommand({
      action: wireName,
      data: { action: 'setValue', selector: '#a', detectOnly: true },
      // click is an acting command: approved for the tab's site.
      approvedHost: 'app.example.test',
    }, 'host');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: contentAction, selector: '#a' });
  });
});
