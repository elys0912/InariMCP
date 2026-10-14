/**
 * index.ts: the Native Host entry point (startup order, shutdown on stdin
 * EOF and on signals, the fatal path). Every module it wires together is
 * replaced by a mock, and process.exit is stubbed; each test loads the entry
 * afresh. The daemon itself is never stopped by the Native Host.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const stdinLoop: (isRunning: () => boolean) => Promise<void> = () => new Promise<void>(() => {});
  const state = {
    ensureRunning: (): Promise<void> => Promise.resolve(),
    stdinLoop,
    launcherThrows: false,
    pruned: 0,
    connections: [] as { handler: (cmd: Record<string, unknown>) => void; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
    monitors: [] as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
    isRunning: null as (() => boolean) | null,
  };
  return {
    state,
    log: vi.fn(),
    installProcessHandlers: vi.fn(),
    handleServerCommand: vi.fn(),
  };
});

vi.mock('../src/server-launcher.js', () => ({
  ServerLauncher: class {
    host = '127.0.0.1';
    httpPort = 1;
    wsPort = 2;
    constructor() { if (m.state.launcherThrows) throw new Error('bad config'); }
    ensureRunning(): Promise<void> { return m.state.ensureRunning(); }
  },
  daemonLogPath: () => 'daemon.log',
}));
vi.mock('../src/ws-client.js', () => ({
  ServerConnection: class {
    start = vi.fn();
    stop = vi.fn();
    reconnectNow = vi.fn();
    constructor(_target: unknown, public handler: (cmd: Record<string, unknown>) => void) {
      m.state.connections.push(this);
    }
  },
}));
vi.mock('../src/health-monitor.js', () => ({
  HealthMonitor: class {
    start = vi.fn();
    stop = vi.fn();
    constructor() { m.state.monitors.push(this); }
  },
}));
vi.mock('../src/host.js', () => ({
  handleServerCommand: m.handleServerCommand,
  runStdinLoop: (_l: unknown, _c: unknown, isRunning: () => boolean) => {
    m.state.isRunning = isRunning;
    return m.state.stdinLoop(isRunning);
  },
}));
vi.mock('../src/logger.js', () => ({ activeLogPath: () => null, log: m.log, rotateIfLarge: vi.fn() }));
vi.mock('../src/screenshot-store.js', () => ({
  pruneScreenshots: () => m.state.pruned,
  screenshotsDirNeedsAclCheck: () => false,
  getScreenshotsDir: () => 'shots',
}));
vi.mock('../src/process-handlers.js', () => ({ installProcessHandlers: m.installProcessHandlers }));
vi.mock('../src/version.js', () => ({ HOST_VERSION: '0.0.0-test' }));

let exit: ReturnType<typeof vi.spyOn>;
let signalsBefore: Record<'SIGINT' | 'SIGTERM', ReturnType<typeof process.listeners>>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  m.state.ensureRunning = () => Promise.resolve();
  m.state.stdinLoop = () => new Promise<void>(() => {});
  m.state.launcherThrows = false;
  m.state.pruned = 0;
  m.state.connections = [];
  m.state.monitors = [];
  m.state.isRunning = null;
  m.log.mockClear();
  m.installProcessHandlers.mockClear();
  m.handleServerCommand.mockClear();
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  signalsBefore = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
});

afterEach(() => {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    for (const fn of process.listeners(sig)) {
      if (!signalsBefore[sig].includes(fn)) process.removeListener(sig, fn as () => void);
    }
  }
  exit.mockRestore();
  vi.useRealTimers();
});

async function load(): Promise<void> {
  await import('../src/index.js');
  await vi.advanceTimersByTimeAsync(0);
}

const logged = (): string => m.log.mock.calls.map((c) => String(c[0])).join('\n');

describe('native-host index.ts', () => {
  it('installs the process handlers, prunes screenshots, then connects once the daemon is up', async () => {
    m.state.pruned = 3;
    await load();
    expect(m.installProcessHandlers).toHaveBeenCalledWith(m.log);
    expect(logged()).toContain('removed 3 screenshot(s)');
    const [connection] = m.state.connections;
    expect(connection!.start).toHaveBeenCalledTimes(1);
    expect(m.state.monitors[0]!.start).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    // commands from the server go to the host with this connection
    connection!.handler({ action: 'get_tabs' });
    expect(m.handleServerCommand).toHaveBeenCalledWith({ action: 'get_tabs' }, connection);
  });

  it('still connects (and keeps answering the Extension) when starting the daemon failed', async () => {
    m.state.ensureRunning = () => Promise.reject(new Error('port in use'));
    await load();
    expect(logged()).toContain('ensureRunning failed: port in use');
    expect(m.state.connections[0]!.start).toHaveBeenCalledTimes(1);
    expect(m.state.isRunning!()).toBe(true);
  });

  it('stdin EOF: stops the connection and the monitor, then exits 0', async () => {
    let eof!: () => void;
    m.state.stdinLoop = () => new Promise<void>((r) => { eof = r; });
    await load();
    eof();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.state.connections[0]!.stop).toHaveBeenCalledTimes(1);
    expect(m.state.monitors[0]!.stop).toHaveBeenCalledTimes(1);
    expect(m.state.isRunning!()).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stdin EOF during a daemon start: waits at most 5 s for it, and does not connect afterwards', async () => {
    let started!: () => void;
    m.state.ensureRunning = () => new Promise<void>((r) => { started = r; });
    m.state.stdinLoop = () => Promise.resolve();
    await load();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(0);

    started();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.state.connections[0]!.start).not.toHaveBeenCalled();
  });

  it('SIGTERM / SIGINT shut down once and exit 0', async () => {
    await load();
    process.emit('SIGTERM');
    process.emit('SIGINT');
    expect(m.state.connections[0]!.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenNthCalledWith(1, 0);
  });

  it('a startup error is logged as fatal and exits 1', async () => {
    m.state.launcherThrows = true;
    await load();
    expect(logged()).toContain('fatal error: bad config');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
