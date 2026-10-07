/**
 * Extension: messages between the background and content scripts.
 *   - The message types and log limits both sides use come from one module
 *     (packages/extension/src/wire-messages.ts, WP45 E-09).
 *   - A command's data cannot replace the action the background checked
 *     (WP45 A-03): content messages are built as `{ ...data, action }`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as wire from '../../packages/extension/src/wire-messages.ts';
import * as backgroundConstants from '../../packages/extension/src/background/constants.ts';
import * as contentConstants from '../../packages/extension/src/content/constants.ts';
import { handleCommand } from '../../packages/extension/src/background/dispatch.ts';

const SHARED = ['LOG_RECORD_MESSAGE', 'LOGGING_STATE_QUERY', 'LOG_ENTRY_LIMIT', 'LOG_TEXT_LIMIT'] as const;

describe('E-09 shared message types and log limits', () => {
  it.each(SHARED)('%s: background and content use the value of wire-messages.ts', (name) => {
    expect(wire[name]).toBeDefined();
    expect(backgroundConstants[name]).toBe(wire[name]);
    expect(contentConstants[name]).toBe(wire[name]);
  });

  it('keeps the values on the wire', () => {
    expect(wire.LOG_RECORD_MESSAGE).toBe('kitsune:logRecords');
    expect(wire.LOGGING_STATE_QUERY).toBe('kitsune:loggingState');
    expect(wire.LOG_ENTRY_LIMIT).toBe(500);
    expect(wire.LOG_TEXT_LIMIT).toBe(5000);
  });
});

describe('A-03 data.action does not replace the content action', () => {
  afterEach(() => {
    delete (globalThis as { browser?: unknown }).browser;
  });

  it.each([
    ['click', 'click'],
    ['hover', 'hover'],
    ['solve_captcha', 'solveCaptcha'],
  ])('%s with data.action "clearLogs" sends action %s', async (wireName, contentAction) => {
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
      data: { action: 'clearLogs', selector: '#a', detectOnly: true },
    }, 'host');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: contentAction, selector: '#a' });
  });
});
