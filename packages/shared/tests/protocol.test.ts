import { describe, expect, it } from 'vitest';
import {
  BROWSER_ACTIONS,
  BrowserActionSchema,
  ENV_DEFAULTS,
  parseBrowserResponse,
} from '@kitsune-mcp/shared';

describe('BROWSER_ACTIONS', () => {
  it('has no duplicate entries', () => {
    expect(new Set(BROWSER_ACTIONS).size).toBe(BROWSER_ACTIONS.length);
  });

  it('BrowserActionSchema accepts every action and rejects tool names', () => {
    for (const action of BROWSER_ACTIONS) {
      expect(BrowserActionSchema.safeParse(action).success).toBe(true);
    }
    expect(BrowserActionSchema.safeParse('fox_click').success).toBe(false);
  });
});

describe('ENV_DEFAULTS native messaging limits', () => {
  it('host → extension is 1 MiB, extension → host is capped at 64 MiB', () => {
    expect(ENV_DEFAULTS.NATIVE_MSG_MAX_SIZE).toBe(1024 * 1024);
    expect(ENV_DEFAULTS.NATIVE_MSG_MAX_INCOMING_SIZE).toBe(64 * 1024 * 1024);
  });
});

describe('parseBrowserResponse', () => {
  it('accepts a valid response and keeps data whole', () => {
    const parsed = parseBrowserResponse({
      requestId: '1',
      success: true,
      data: { url: 'https://example.test/', nested: { a: 1 } },
      extra: 'stripped',
    });
    expect(parsed).toEqual({
      ok: true,
      response: {
        requestId: '1',
        success: true,
        data: { url: 'https://example.test/', nested: { a: 1 } },
      },
    });
  });

  it('recovers a string requestId from an invalid frame', () => {
    const parsed = parseBrowserResponse({ requestId: '7', success: 'yes' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.requestId).toBe('7');
    expect(parsed.error).toMatch(/^Invalid browser response: success:/);
  });

  it('returns requestId undefined when none can be recovered', () => {
    const parsed = parseBrowserResponse({ requestId: 7, success: true });
    expect(parsed).toMatchObject({ ok: false, requestId: undefined });
    expect(parseBrowserResponse(null)).toMatchObject({ ok: false, requestId: undefined });
  });
});
