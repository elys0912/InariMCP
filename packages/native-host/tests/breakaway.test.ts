/**
 * breakaway.ts: starting the daemon outside Firefox's job object through
 * PowerShell. child_process.spawn is replaced, so nothing is started; the
 * tests check what would be run and how its outcome is read.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStream extends EventEmitter {
  setEncoding: ReturnType<typeof vi.fn>;
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  kill: ReturnType<typeof vi.fn>;
}

const spawned = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; options: Record<string, unknown> }[],
  child: null as unknown,
}));

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawned.calls.push({ command, args, options });
    return spawned.child;
  },
}));

const { spawnDaemonBreakaway } = await import('../src/breakaway.js');

function fakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.setEncoding = vi.fn();
  return stream;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.kill = vi.fn();
  return child;
}

let child: FakeChild;
beforeEach(() => {
  spawned.calls = [];
  child = fakeChild();
  spawned.child = child;
});
afterEach(() => { vi.useRealTimers(); });

/** The PowerShell script of the last spawn, decoded from -EncodedCommand. */
function decodedScript(): string {
  const args = spawned.calls.at(-1)!.args;
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');
}

const ENTRY = 'C:\\Program Files\\Kitsune "x"\\dist\\index.js';
const LOG = 'C:\\Users\\someone\\.kitsune-mcp\\logs\\daemon.log';

describe('spawnDaemonBreakaway', () => {
  it('runs a non-interactive PowerShell and passes the paths through the environment only', async () => {
    const started = spawnDaemonBreakaway(ENTRY, LOG);
    child.stdout.emit('data', '4242\r\n');
    child.emit('close', 0);
    await expect(started).resolves.toBe(4242);

    const { command, args, options } = spawned.calls[0]!;
    expect(command).toBe('powershell.exe');
    expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    // no path (with its quotes) ever reaches the command line or the script
    expect(args.join(' ')).not.toContain('Kitsune');
    expect(decodedScript()).not.toContain('Kitsune "x"');
    expect(decodedScript()).toContain('$env:KITSUNE_DAEMON_ENTRY');
    expect(decodedScript()).toContain('CREATE_BREAKAWAY_FROM_JOB');
    const env = options['env'] as Record<string, string>;
    expect(env['KITSUNE_DAEMON_ENTRY']).toBe(ENTRY);
    expect(env['KITSUNE_DAEMON_LOG']).toBe(LOG);
    expect(env['KITSUNE_DAEMON_NODE']).toBe(process.execPath);
    expect(options).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(options).not.toHaveProperty('cwd');
  });

  it('starts PowerShell in the given cwd (the daemon inherits it)', async () => {
    const started = spawnDaemonBreakaway(ENTRY, LOG, 'C:\\work');
    child.stdout.emit('data', '7');
    child.emit('close', 0);
    await expect(started).resolves.toBe(7);
    expect(spawned.calls[0]!.options['cwd']).toBe('C:\\work');
  });

  it('rejects with the exit code and the first stderr lines when PowerShell fails', async () => {
    const started = spawnDaemonBreakaway(ENTRY, LOG);
    child.stderr.emit('data', 'Exception calling "Start"\r\nAccess is denied\r\nline 3\r\nline 4\r\n');
    child.emit('close', 1);
    await expect(started).rejects.toThrow('exit code 1: Exception calling "Start" Access is denied line 3');
    await expect(started).rejects.not.toThrow(/line 4/);
  });

  it('rejects when PowerShell exits 0 without a usable PID', async () => {
    for (const out of ['', 'abc', '0', '-5', '1.5']) {
      child = fakeChild();
      spawned.child = child;
      const started = spawnDaemonBreakaway(ENTRY, LOG);
      child.stdout.emit('data', out);
      child.emit('close', 0);
      await expect(started, `stdout ${JSON.stringify(out)}`).rejects.toThrow(/^exit code 0$/);
    }
  });

  it('rejects when powershell.exe cannot be started (blocked by policy)', async () => {
    const started = spawnDaemonBreakaway(ENTRY, LOG);
    child.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
    await expect(started).rejects.toThrow('ENOENT');
  });

  it('kills a PowerShell that does not finish in 20 s and rejects', async () => {
    vi.useFakeTimers();
    const started = spawnDaemonBreakaway(ENTRY, LOG);
    const outcome = started.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(String(await outcome)).toContain('PowerShell did not finish in time');
  });
});
