import { describe, expect, it, vi } from 'vitest';
import { BrowserConnectionManager } from '../src/connection/manager.js';
import { DaemonActivity } from '../src/daemon/activity.js';
import { buildShutdownSteps, createDaemonShutdown, type ClosableWsServer, type ShutdownStep } from '../src/daemon/main.js';

function setup(steps: ShutdownStep[] = []): {
  activity: DaemonActivity;
  shutdown: ReturnType<typeof createDaemonShutdown>;
  exit: ReturnType<typeof vi.fn>;
  lines: string[];
} {
  const activity = new DaemonActivity();
  const exit = vi.fn();
  const lines: string[] = [];
  const shutdown = createDaemonShutdown({ activity, steps, exit, log: (m) => lines.push(m), drainMs: 10_000 });
  return { activity, shutdown, exit, lines };
}

describe('createDaemonShutdown', () => {
  it('R-4: a failing step is logged, the later steps still run, and stop() still exits', async () => {
    const ran: string[] = [];
    const { shutdown, exit, lines } = setup([
      { name: 'first', run: () => { ran.push('first'); throw new Error('boom'); } },
      { name: 'second', run: async () => { ran.push('second'); await Promise.reject(new Error('bang')); } },
      { name: 'third', run: () => { ran.push('third'); } },
    ]);
    await shutdown.stop('SIGTERM received');
    expect(ran).toEqual(['first', 'second', 'third']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(lines).toContain('shutdown: first failed: boom');
    expect(lines).toContain('shutdown: second failed: bang');
  });

  it('Q-5: started is true from the first call on, whatever started it', () => {
    const { shutdown } = setup();
    expect(shutdown.started).toBe(false);
    void shutdown.stop('idle for 600s');
    expect(shutdown.started).toBe(true);
  });

  it('Q-5: a forced stop during a graceful drain ends the wait at once', async () => {
    vi.useFakeTimers();
    try {
      const { activity, shutdown, exit } = setup();
      activity.beginCall(); // never ends
      const graceful = shutdown.prepare('POST /daemon/shutdown', false);
      await vi.advanceTimersByTimeAsync(100);
      expect(exit).not.toHaveBeenCalled();

      const stopped = shutdown.stop('SIGTERM received');
      await vi.advanceTimersByTimeAsync(0);
      await stopped;
      expect(exit).toHaveBeenCalledTimes(1);
      await expect(graceful).resolves.toMatchObject({ drained: false, cancelledCalls: 1 });
      expect(await shutdown.prepare('again', true)).toBe(await graceful); // shared
    } finally {
      vi.useRealTimers();
    }
  });

  it('a graceful prepare waits for running calls', async () => {
    const { activity, shutdown } = setup();
    activity.beginCall();
    const p = shutdown.prepare('POST /daemon/shutdown', false);
    activity.endCall();
    await expect(p).resolves.toMatchObject({ drained: true, cancelledCalls: 0 });
  });
});

describe('buildShutdownSteps (R-3)', () => {
  function fakeWsServer(): { server: ClosableWsServer; closed: number[]; serverClosed: () => boolean } {
    const closed: number[] = [];
    let serverClosed = false;
    const client = { close: (code: number) => { closed.push(code); } };
    const server: ClosableWsServer = { clients: [client], close: () => { serverClosed = true; } };
    return { server, closed, serverClosed: () => serverClosed };
  }

  it('reads the WebSocket server when the step runs, not when the steps are built', async () => {
    let ws: ClosableWsServer | undefined = undefined;
    const manager = new BrowserConnectionManager();
    const shutdownSpy = vi.spyOn(manager, 'shutdown');
    const steps = buildShutdownSteps({ getWsServer: () => ws, headlessMode: false, connectionManager: manager });
    expect(steps.map((s) => s.name)).toEqual([
      'closing the WebSocket connections',
      'stopping the headless browser',
      'closing the browser connections',
    ]);

    const fake = fakeWsServer();
    ws = fake.server;
    for (const step of steps) await step.run();
    expect(fake.closed).toEqual([1001]);
    expect(fake.serverClosed()).toBe(true);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('without a WebSocket server (startup failed before it) the step does nothing', async () => {
    const [wsStep] = buildShutdownSteps({
      getWsServer: () => undefined,
      headlessMode: false,
      connectionManager: new BrowserConnectionManager(),
    });
    await expect(Promise.resolve(wsStep?.run())).resolves.toBeUndefined();
  });
});
