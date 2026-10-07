import { describe, expect, it } from 'vitest';
import {
  BROWSER_ACTIONS,
  BrowserActionSchema,
  ENV_DEFAULTS,
  errnoCode,
  formatZodIssues,
  parseBrowserResponse,
  shortId,
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

describe('util helpers (R2-A)', () => {
  it('errnoCode returns a string code only', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errnoCode({ code: 1 })).toBeUndefined();
    expect(errnoCode(new Error('x'))).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode('ENOENT')).toBeUndefined();
  });

  it('formatZodIssues joins path: message pairs, (root) for an empty path', () => {
    expect(formatZodIssues([
      { path: ['data', 0, 'x'], message: 'Required' },
      { path: [], message: 'Expected object' },
    ])).toBe('data.0.x: Required; (root): Expected object');
    expect(formatZodIssues([])).toBe('');
  });

  it('shortId gives exactly 6 base-36 characters (R3 N-9)', () => {
    expect(shortId()).toMatch(/^[a-z0-9]{6}$/);
  });
});
