/**
 * daemon/activity.ts: when the shared daemon counts as idle and stops itself
 * (relay TTL, Native Host connections, calls in flight, idle timeout), and
 * the drain wait of a graceful shutdown. Fake timers; nothing is started.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV } from '@inari-mcp/shared';
import { DaemonActivity, RELAY_TTL_MS, resolveIdleTimeoutMs } from '../src/daemon/activity.js';

let activity: DaemonActivity | undefined;
afterEach(() => {
  activity?.stop();
  activity = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('resolveIdleTimeoutMs', () => {
  it('reads FOX_DAEMON_IDLE_TIMEOUT in seconds; 0 disables; anything else is the default (600 s)', () => {
    vi.stubEnv(ENV.FOX_DAEMON_IDLE_TIMEOUT, '30');
    expect(resolveIdleTimeoutMs()).toBe(30_000);
    vi.stubEnv(ENV.FOX_DAEMON_IDLE_TIMEOUT, '0');
    expect(resolveIdleTimeoutMs()).toBe(0);
    for (const raw of ['', '  ', '-1', 'ten', 'Infinity']) {
      vi.stubEnv(ENV.FOX_DAEMON_IDLE_TIMEOUT, raw);
      expect(resolveIdleTimeoutMs(), JSON.stringify(raw)).toBe(600_000);
    }
  });
});

describe('DaemonActivity', () => {
  it('counts a relay as live until RELAY_TTL_MS after its last heartbeat', () => {
    vi.useFakeTimers();
    activity = new DaemonActivity();
    activity.noteRelay('a');
    vi.advanceTimersByTime(RELAY_TTL_MS / 2);
    activity.noteRelay('b');
    expect(activity.liveRelayCount()).toBe(2);
    vi.advanceTimersByTime(RELAY_TTL_MS / 2 + 1);
    expect(activity.liveRelayCount()).toBe(1); // 'a' expired and was dropped
    activity.noteRelay('a');
    expect(activity.liveRelayCount()).toBe(2);
  });

  it('waitForIdle: at once when nothing runs, when the last call ends, or false at the timeout', async () => {
    vi.useFakeTimers();
    activity = new DaemonActivity();
    await expect(activity.waitForIdle(1_000)).resolves.toBe(true);

    activity.beginCall();
    activity.beginCall();
    expect(activity.inFlightCalls).toBe(2);
    const drained = activity.waitForIdle(10_000);
    activity.endCall();
    activity.endCall();
    await expect(drained).resolves.toBe(true);

    activity.beginCall();
    const stuck = activity.waitForIdle(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stuck).resolves.toBe(false);
    activity.endCall();
    activity.endCall(); // never below zero
    expect(activity.inFlightCalls).toBe(0);
  });

  it('stops itself once after the idle timeout with no relay, Native Host or call', async () => {
    vi.useFakeTimers();
    vi.stubEnv(ENV.FOX_DAEMON_IDLE_TIMEOUT, '10');
    activity = new DaemonActivity();
    const onIdle = vi.fn();
    activity.start(() => 0, onIdle);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1); // the watchdog stopped itself
  });

  it('activity restarts the idle period: a Native Host, a call in flight, a live relay', async () => {
    vi.useFakeTimers();
    vi.stubEnv(ENV.FOX_DAEMON_IDLE_TIMEOUT, '10'); // checked every 5 s
    activity = new DaemonActivity();
    let hosts = 1;
    const onIdle = vi.fn();
    activity.start(() => hosts, onIdle);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onIdle).not.toHaveBeenCalled();

    hosts = 0;
    activity.beginCall();
    await vi.advanceTimersByTimeAsync(60_000);
    activity.endCall();
    activity.noteRelay('r');
    await vi.advanceTimersByTimeAsync(RELAY_TTL_MS);
    expect(onIdle).not.toHaveBeenCalled();

    // relay expired: idle from the next check on, for the full 10 s
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never starts the watchdog with FOX_DAEMON_IDLE_TIMEOUT=0, and starts it only once', async () => {
    vi.useFakeTimers();
    vi.stubEnv(ENV.FOX_DAEMON_IDLE_TIMEOUT, '0');
    activity = new DaemonActivity();
    const onIdle = vi.fn();
    activity.start(() => 0, onIdle);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    vi.stubEnv(ENV.FOX_DAEMON_IDLE_TIMEOUT, '10');
    activity.start(() => 0, onIdle);
    activity.start(() => 0, onIdle);
    expect(vi.getTimerCount()).toBe(1);
  });
});
