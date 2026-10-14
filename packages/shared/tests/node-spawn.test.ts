/**
 * node/spawn.ts: the detached daemon start shared by the relays and the
 * Native Host. child_process.spawn is replaced (nothing is started); the
 * log file is real, in a temp directory.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  unref: ReturnType<typeof vi.fn>;
}

const spawned = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; options: Record<string, unknown> }[],
  next: null as unknown,
  throws: null as Error | null,
}));

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    if (spawned.throws) throw spawned.throws;
    spawned.calls.push({ command, args, options });
    return spawned.next;
  },
}));

const { spawnDetachedDaemon } = await import('../src/node/spawn.js');

let dir: string;
let child: FakeChild;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-spawn-'));
  child = Object.assign(new EventEmitter(), { pid: 4321 as number | undefined, unref: vi.fn() });
  spawned.calls = [];
  spawned.next = child;
  spawned.throws = null;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('spawnDetachedDaemon', () => {
  it('starts `node <entry> --daemon` detached and hidden, stderr appended to the log', () => {
    const logPath = path.join(dir, 'logs', 'daemon.log');
    expect(spawnDetachedDaemon({ entry: '/app/dist/index.js', logPath })).toBe(4321);

    const { command, args, options } = spawned.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/app/dist/index.js', '--daemon']);
    expect(options).toMatchObject({ detached: true, windowsHide: true, env: process.env });
    expect(options).not.toHaveProperty('cwd');
    const stdio = options['stdio'] as unknown[];
    expect(stdio.slice(0, 2)).toEqual(['ignore', 'ignore']);
    expect(typeof stdio[2]).toBe('number'); // a file descriptor of the log
    expect(fs.existsSync(logPath)).toBe(true); // log directory created on demand
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('passes env and cwd when given', () => {
    const env = { FOX_TEST: '1' };
    spawnDetachedDaemon({ entry: 'e.js', logPath: path.join(dir, 'd.log'), env, cwd: dir });
    expect(spawned.calls[0]!.options).toMatchObject({ env, cwd: dir });
  });

  it('still starts the daemon when the log cannot be opened (stderr ignored)', () => {
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    expect(spawnDetachedDaemon({ entry: 'e.js', logPath: path.join(blocker, 'daemon.log') })).toBe(4321);
    expect((spawned.calls[0]!.options['stdio'] as unknown[])[2]).toBe('ignore');
  });

  it('reports a later spawn error through onError, and returns undefined without a PID', () => {
    child.pid = undefined;
    const onError = vi.fn();
    expect(spawnDetachedDaemon({ entry: 'e.js', logPath: path.join(dir, 'd.log'), onError })).toBeUndefined();
    const err = new Error('spawn ENOENT');
    child.emit('error', err);
    expect(onError).toHaveBeenCalledWith(err);
    // without onError, the error is swallowed (no unhandled 'error' event)
    child = Object.assign(new EventEmitter(), { pid: 1 as number | undefined, unref: vi.fn() });
    spawned.next = child;
    spawnDetachedDaemon({ entry: 'e.js', logPath: path.join(dir, 'd.log') });
    expect(() => child.emit('error', new Error('late'))).not.toThrow();
  });

  it('throws a synchronous spawn failure to the caller', () => {
    spawned.throws = new Error('EINVAL');
    const logPath = path.join(dir, 'd.log');
    expect(() => spawnDetachedDaemon({ entry: 'e.js', logPath })).toThrow('EINVAL');
    expect(spawned.calls).toEqual([]);
  });
});
