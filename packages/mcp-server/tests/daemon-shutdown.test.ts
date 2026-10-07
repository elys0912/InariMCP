import { describe, expect, it, vi } from 'vitest';
import { DaemonActivity } from '../src/daemon/activity.js';
import { createDaemonShutdown, type ShutdownStep } from '../src/daemon/main.js';

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
