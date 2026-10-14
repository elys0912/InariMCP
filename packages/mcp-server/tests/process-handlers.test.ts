import { describe, expect, it } from 'vitest';
import { createProcessHandlers, stdoutErrorAction } from '../src/utils/process-handlers.js';

function errWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function harness(role: 'daemon' | 'relay'): {
  handlers: ReturnType<typeof createProcessHandlers>;
  exits: number[];
  lines: string[];
} {
  const exits: number[] = [];
  const lines: string[] = [];
  const handlers = createProcessHandlers(role, { exit: (c) => exits.push(c), log: (l) => lines.push(l) });
  return { handlers, exits, lines };
}

describe('process handlers (4.A8)', () => {
  it('uncaughtException logs and exits 1 in both roles', () => {
    for (const role of ['daemon', 'relay'] as const) {
      const h = harness(role);
      h.handlers.uncaughtException(new Error('boom'));
      expect(h.exits).toEqual([1]);
      expect(h.lines[0]).toMatch(new RegExp(`\\[InariMCP:${role}\\] FATAL uncaughtException: boom`));
    }
  });

  it('unhandledRejection logs and keeps running', () => {
    const h = harness('daemon');
    h.handlers.unhandledRejection(new Error('lost'));
    h.handlers.unhandledRejection('plain reason');
    expect(h.exits).toEqual([]);
    expect(h.lines).toHaveLength(2);
  });

  it('relay: EPIPE on stdout (client gone) exits 0; other stdout errors exit 1', () => {
    const clean = harness('relay');
    clean.handlers.stdoutError(errWithCode('EPIPE'));
    expect(clean.exits).toEqual([0]);

    const bad = harness('relay');
    bad.handlers.stdoutError(errWithCode('EIO'));
    expect(bad.exits).toEqual([1]);
  });

  it('daemon: stdout errors are only logged (stdout is discarded)', () => {
    const h = harness('daemon');
    h.handlers.stdoutError(errWithCode('EPIPE'));
    expect(h.exits).toEqual([]);
    expect(h.lines).toHaveLength(1);
  });

  it.each(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])('%s counts as "client gone"', (code) => {
    expect(stdoutErrorAction('relay', errWithCode(code))).toBe('exit-clean');
  });
});
