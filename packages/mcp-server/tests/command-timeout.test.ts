import { describe, expect, it } from 'vitest';
import type { BrowserAction, BrowserCommand } from '@inari-mcp/shared';
import { maxCommandTimeoutMs, resolveCommandTimeout } from '../src/connection/manager.js';

function command(action: BrowserAction, data?: Record<string, unknown>): BrowserCommand {
  return { action, requestId: '1', ...(data ? { data } : {}) };
}

describe('resolveCommandTimeout', () => {
  it('uses the per-transport default for ordinary actions', () => {
    expect(resolveCommandTimeout(command('click'), 'native-host')).toBe(30_000);
    expect(resolveCommandTimeout(command('click'), 'headless')).toBe(35_000);
  });

  it('uses the per-action value for human waits on both transports', () => {
    for (const kind of ['native-host', 'headless'] as const) {
      expect(resolveCommandTimeout(command('request_approval'), kind)).toBe(90_000);
      expect(resolveCommandTimeout(command('solve_captcha'), kind)).toBe(200_000);
    }
  });

  it('returns max(base, argument + 5 s) for timeout', () => {
    expect(resolveCommandTimeout(command('click', { timeout: 1_000 }), 'native-host')).toBe(30_000);
    expect(resolveCommandTimeout(command('click', { timeout: 60_000 }), 'native-host')).toBe(65_000);
    expect(resolveCommandTimeout(command('click', { timeout: 60_000 }), 'headless')).toBe(65_000);
    expect(
      resolveCommandTimeout(command('solve_captcha', { timeout: 300_000 }), 'native-host'),
    ).toBe(305_000);
  });

  // The key of the removed fox_wait_and_act: no tool has it any more.
  it('ignores timeoutMs', () => {
    expect(resolveCommandTimeout(command('click', { timeoutMs: 90_000 }), 'native-host')).toBe(30_000);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000', null])(
    'ignores a non-positive / non-finite / non-number argument (%s)',
    (value) => {
      expect(resolveCommandTimeout(command('click', { timeout: value }), 'native-host')).toBe(30_000);
    },
  );
});

describe('maxCommandTimeoutMs', () => {
  it('is the largest base timeout without arguments', () => {
    expect(maxCommandTimeoutMs({})).toBe(200_000);
  });

  it('honours timeout with the same 5 s margin', () => {
    expect(maxCommandTimeoutMs({ timeout: 600_000 })).toBe(605_000);
    expect(maxCommandTimeoutMs({ timeout: 1_000 })).toBe(200_000);
  });
});
