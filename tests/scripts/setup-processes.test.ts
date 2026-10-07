/**
 * Finding and stopping the Kitsune processes (scripts/lib/core.mjs /
 * scripts/lib/system.mjs). Processes are stubbed or started by the test itself.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyProcesses, parsePsOutput, parseTabOutput,
} from '../../scripts/lib/core.mjs';
import { defaultDeps, listNodeProcesses, stopProcess } from '../../scripts/lib/system.mjs';

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

describe('process list parsing', () => {
  it('parsePsOutput reads "<pid> <args>" and keeps the spaces of the command line', () => {
    const text = [
      '  1234 /usr/bin/node /r/packages/mcp-server/dist/index.js --daemon',
      ' 5678 /usr/bin/node /r/packages/native-host/dist/index.js',
      '',
      'not a process line',
      '  91011  node  with   doubled   spaces',
    ].join('\n');
    expect(parsePsOutput(text)).toEqual([
      { pid: 1234, cmd: '/usr/bin/node /r/packages/mcp-server/dist/index.js --daemon' },
      { pid: 5678, cmd: '/usr/bin/node /r/packages/native-host/dist/index.js' },
      { pid: 91011, cmd: 'node  with   doubled   spaces' },
    ]);
    expect(parsePsOutput('')).toEqual([]);
  });

  it('parseTabOutput reads "<pid>\\t<command line>" (CRLF too)', () => {
    const text = '1234\t"C:\\node\\node.exe" "C:\\r\\dist\\index.js"\r\n5678\t\r\nheader line\r\n';
    expect(parseTabOutput(text)).toEqual([
      { pid: 1234, cmd: '"C:\\node\\node.exe" "C:\\r\\dist\\index.js"' },
      { pid: 5678, cmd: '' },
    ]);
  });
});

describe('classifyProcesses', () => {
  const ctx = {
    hostEntry: '/r/packages/native-host/dist/index.js',
    serverEntry: '/r/packages/mcp-server/dist/index.js',
    platform: 'linux',
    selfPid: 999,
  };
  const list = [
    { pid: 1, cmd: 'node /r/packages/native-host/dist/index.js' },
    { pid: 2, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon' },
    { pid: 3, cmd: 'node /r/packages/mcp-server/dist/index.js' },
    { pid: 4, cmd: 'node /other/clone/packages/mcp-server/dist/index.js --daemon' },
    { pid: 5, cmd: 'node /other/clone/packages/native-host/dist/index.js' },
    { pid: 6, cmd: 'node /somewhere/unrelated/server.js' },
    { pid: 999, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon' },
  ];

  it('sorts hosts, daemons, relays and other checkouts, and skips its own pid', () => {
    const c = classifyProcesses(list, ctx);
    expect(c.hosts.map((x: { pid: number }) => x.pid)).toEqual([1]);
    expect(c.daemons.map((x: { pid: number }) => x.pid)).toEqual([2]);
    expect(c.relays.map((x: { pid: number }) => x.pid)).toEqual([3]);
    expect(c.others.map((x: { pid: number }) => x.pid)).toEqual([4, 5]);
  });

  it('only treats "--daemon" as its own argument as the daemon', () => {
    const c = classifyProcesses([
      { pid: 1, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon' },
      { pid: 2, cmd: 'node /r/packages/mcp-server/dist/index.js --daemonize' },
      { pid: 3, cmd: 'node /r/packages/mcp-server/dist/index.js --daemon --verbose' },
      { pid: 4, cmd: 'node /r/packages/mcp-server/dist/index.js --no-daemon' },
    ], ctx);
    expect(c.daemons.map((x: { pid: number }) => x.pid)).toEqual([1, 3]);
    expect(c.relays.map((x: { pid: number }) => x.pid)).toEqual([2, 4]);
  });

  it('ignores case and slash direction on Windows but not on linux', () => {
    const win = {
      hostEntry: 'C:\\Repo\\packages\\native-host\\dist\\index.js',
      serverEntry: 'C:\\Repo\\packages\\mcp-server\\dist\\index.js',
      platform: 'win32',
      selfPid: 0,
    };
    const c = classifyProcesses([
      { pid: 1, cmd: '"C:\\node.exe" "c:/repo/packages/native-host/dist/index.js"' },
      { pid: 2, cmd: '"C:\\node.exe" "C:\\REPO\\packages\\mcp-server\\dist\\index.js" --daemon' },
    ], win);
    expect(c.hosts.map((x: { pid: number }) => x.pid)).toEqual([1]);
    expect(c.daemons.map((x: { pid: number }) => x.pid)).toEqual([2]);

    // same input classified as linux: the case difference makes them foreign checkouts
    const asLinux = classifyProcesses([
      { pid: 1, cmd: 'node /Repo/packages/native-host/dist/index.js' },
    ], { ...ctx, hostEntry: '/repo/packages/native-host/dist/index.js' });
    expect(asLinux.hosts).toEqual([]);
    expect(asLinux.others.map((x: { pid: number }) => x.pid)).toEqual([1]);
  });

  it('returns four empty lists for an empty process list', () => {
    expect(classifyProcesses([], ctx)).toEqual({ hosts: [], daemons: [], relays: [], others: [] });
  });
});

describe('listNodeProcesses', () => {
  const noFs = { writeFileSync: () => {}, unlinkSync: () => {} };

  it('unix: runs ps and parses it, and returns null when ps fails', () => {
    const calls: string[][] = [];
    const deps = (result: object) => ({
      platform: 'linux',
      fs: noFs,
      run: (file: string, args: string[]) => {
        calls.push([file, ...args]);
        return { status: 0, stdout: '', stderr: '', error: undefined, ...result };
      },
    });
    expect(listNodeProcesses(deps({ stdout: ' 42 node /r/dist/index.js\n' })))
      .toEqual([{ pid: 42, cmd: 'node /r/dist/index.js' }]);
    expect(calls[0]).toEqual(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'args=']);
    expect(listNodeProcesses(deps({ status: 1 }))).toBeNull();
    expect(listNodeProcesses(deps({ error: new Error('ENOENT') }))).toBeNull();
  });

  it('win32: reads the UTF-16 output of the cscript WMI query', () => {
    const calls: string[][] = [];
    const out = listNodeProcesses({
      platform: 'win32',
      fs: noFs,
      run: (file: string, args: string[]) => {
        calls.push([file, ...args]);
        return {
          status: 0,
          stdout: Buffer.from('1234\t"C:\\node.exe" "C:\\r\\dist\\index.js"\r\n', 'utf16le'),
          stderr: '',
          error: undefined,
        };
      },
    });
    expect(out).toEqual([{ pid: 1234, cmd: '"C:\\node.exe" "C:\\r\\dist\\index.js"' }]);
    expect(calls[0][0]).toBe('cscript.exe');
    expect(calls[0]).toContain('//E:jscript');
    expect(calls).toHaveLength(1); // no wmic fallback needed
  });

  it('win32: falls back to the wmic CSV output, and returns null when that fails too', () => {
    const run = (result: object) => {
      const calls: string[][] = [];
      const deps = {
        platform: 'win32',
        fs: noFs,
        run: (file: string, args: string[]) => {
          calls.push([file, ...args]);
          if (file === 'cscript.exe') return { status: 1, stdout: Buffer.alloc(0), stderr: '', error: undefined };
          return { status: 0, stdout: '', stderr: '', error: undefined, ...result };
        },
      };
      return { out: listNodeProcesses(deps), calls };
    };

    const csv = [
      'Node,CommandLine,ProcessId',
      'HOST1,"C:\\node.exe" "C:\\r\\packages\\mcp-server\\dist\\index.js" --daemon,2345',
      'HOST1,,6789', // a process whose command line WMI does not show
      '',
    ].join('\r\n');
    const ok = run({ stdout: csv });
    expect(ok.out).toEqual([
      { pid: 2345, cmd: '"C:\\node.exe" "C:\\r\\packages\\mcp-server\\dist\\index.js" --daemon' },
      { pid: 6789, cmd: '' },
    ]);
    expect(ok.calls[1][0]).toBe('wmic.exe');
    expect(ok.calls[1]).toContain('/format:csv');

    expect(run({ status: 1 }).out).toBeNull();
    expect(run({ error: new Error('ENOENT') }).out).toBeNull();
  });
});

describe('stopProcess', () => {
  /** A process that is alive until `kill` is told to stop it. */
  function fakeProcess(opts: { alive?: boolean; diesOn?: string | null; throwOn?: Record<string, string> } = {}) {
    const state = { alive: opts.alive ?? true, signals: [] as string[], sleeps: 0 };
    const deps = {
      isAlive: () => state.alive,
      kill: (_pid: number, signal: string) => {
        state.signals.push(signal);
        const code = opts.throwOn?.[signal];
        if (code) {
          const err: NodeJS.ErrnoException = new Error(code);
          err.code = code;
          throw err;
        }
        if (opts.diesOn === signal) state.alive = false;
      },
      sleep: async () => {
        state.sleeps++;
      },
    };
    return { state, deps };
  }

  it('returns "gone" without signalling a process that is not there any more', async () => {
    const { state, deps } = fakeProcess({ alive: false });
    expect(await stopProcess(deps, 4242, 5000)).toBe('gone');
    expect(state.signals).toEqual([]);
  });

  it('returns "stopped" when SIGTERM is honoured', async () => {
    const { state, deps } = fakeProcess({ diesOn: 'SIGTERM' });
    expect(await stopProcess(deps, 4242, 5000)).toBe('stopped');
    expect(state.signals).toEqual(['SIGTERM']);
  });

  it('sends SIGKILL after the grace period', async () => {
    const { state, deps } = fakeProcess({ diesOn: 'SIGKILL' });
    expect(await stopProcess(deps, 4242, 500)).toBe('killed');
    expect(state.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(state.sleeps).toBe(500 / 100); // the grace period is waited out in 100 ms steps
  });

  it('does not wait at all with --grace 0', async () => {
    const { state, deps } = fakeProcess({ diesOn: 'SIGKILL' });
    expect(await stopProcess(deps, 4242, 0)).toBe('killed');
    expect(state.sleeps).toBe(0);
    expect(state.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('treats ESRCH as the process having gone away', async () => {
    const term = fakeProcess({ throwOn: { SIGTERM: 'ESRCH' } });
    expect(await stopProcess(term.deps, 4242, 500)).toBe('gone');

    const kill = fakeProcess({ throwOn: { SIGKILL: 'ESRCH' } });
    expect(await stopProcess(kill.deps, 4242, 200)).toBe('stopped');
    expect(kill.state.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports a failure when the signal is refused (EPERM) or the process survives SIGKILL', async () => {
    const perm = fakeProcess({ throwOn: { SIGTERM: 'EPERM' } });
    expect(await stopProcess(perm.deps, 4242, 500)).toBe('failed');

    const permKill = fakeProcess({ throwOn: { SIGKILL: 'EPERM' } });
    expect(await stopProcess(permKill.deps, 4242, 200)).toBe('failed');

    const survivor = fakeProcess({ diesOn: null });
    expect(await stopProcess(survivor.deps, 4242, 200)).toBe('failed');
    expect(survivor.state.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops a real child process with the real dependencies', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
      const deps = defaultDeps();
      expect(deps.isAlive(child.pid)).toBe(true);
      expect(await stopProcess(deps, child.pid, 5000)).toBe('stopped');
      expect(deps.isAlive(child.pid)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 20_000);

  it('isAlive answers for a live and for an exited process', () => {
    const deps = defaultDeps();
    expect(deps.isAlive(process.pid)).toBe(true);
    const gone = spawnSync(process.execPath, ['-e', '0']);
    expect(deps.isAlive(gone.pid)).toBe(false);
  });
});
