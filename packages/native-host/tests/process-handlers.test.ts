import { describe, expect, it } from 'vitest';
import { createProcessHandlers, stdoutErrorAction } from '../src/process-handlers.js';

function errWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function harness(): { handlers: ReturnType<typeof createProcessHandlers>; exits: number[]; lines: string[] } {
  const exits: number[] = [];
  const lines: string[] = [];
  return { handlers: createProcessHandlers({ exit: (c) => exits.push(c), log: (l) => lines.push(l) }), exits, lines };
}

describe('Native Host process handlers', () => {
  it('uncaughtException logs and exits 1', () => {
    const h = harness();
    h.handlers.uncaughtException(new Error('boom'));
    expect(h.exits).toEqual([1]);
    expect(h.lines[0]).toMatch(/FATAL uncaughtException: boom/);
  });

  it('unhandledRejection logs and keeps running', () => {
    const h = harness();
    h.handlers.unhandledRejection(new Error('lost'));
    expect(h.exits).toEqual([]);
    expect(h.lines).toHaveLength(1);
  });

  it('EPIPE on stdout (Firefox closed the pipe) exits 0', () => {
    const h = harness();
    h.handlers.stdoutError(errWithCode('EPIPE'));
    expect(h.exits).toEqual([0]);
  });

  it('other stdout errors exit 1 (the Extension cannot be answered)', () => {
    const h = harness();
    h.handlers.stdoutError(errWithCode('EIO'));
    expect(h.exits).toEqual([1]);
    expect(stdoutErrorAction(new Error('no code'))).toBe('exit-error');
  });
});
