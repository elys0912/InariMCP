import { describe, expect, it, vi } from 'vitest';
import { ENV_DEFAULTS } from '@inari-mcp/shared';
import { HealthMonitor, type MonitoredLauncher } from '../src/health-monitor.js';
import type { HealthVerdict } from '@inari-mcp/shared/node';

function fakeLauncher(verdict: HealthVerdict | Error, portInUse = false): MonitoredLauncher & { starts: number } {
  const fake = {
    starts: 0,
    probeHealth: vi.fn(async () => {
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }),
    checkHealth: vi.fn(async () => false),
    isPortInUse: vi.fn(async () => portInUse),
    getRestartAttempts: vi.fn(() => 0),
    getBackoffDelay: vi.fn(() => 0),
    start: vi.fn(async () => {
      fake.starts++;
      return true;
    }),
  };
  return fake;
}

describe('HealthMonitor.check', () => {
  it('never rejects, even when the probe throws', async () => {
    const monitor = new HealthMonitor(fakeLauncher(new Error('boom')));
    await expect(monitor.check()).resolves.toBeUndefined();
    // and it is not stuck in "checking"
    await expect(monitor.check()).resolves.toBeUndefined();
  });

  it('never rejects when start() throws', async () => {
    const launcher = fakeLauncher({ kind: 'down' });
    launcher.start = vi.fn(async () => { throw new Error('spawn failed'); });
    const monitor = new HealthMonitor(launcher);
    await monitor.check();
    await expect(monitor.check()).resolves.toBeUndefined();
  });

  it.each([
    { kind: 'impostor' },
    { kind: 'foreign' },
    { kind: 'incompatible', protocol: 1 },
  ] as HealthVerdict[])('does not start a daemon while $kind holds the port', async (verdict) => {
    const launcher = fakeLauncher(verdict);
    const monitor = new HealthMonitor(launcher);
    for (let i = 0; i < 3; i++) await monitor.check();
    expect(launcher.starts).toBe(0);
  });

  it('starts a daemon after two checks that find the port free', async () => {
    const launcher = fakeLauncher({ kind: 'down' });
    const onRestart = vi.fn();
    const monitor = new HealthMonitor(launcher, onRestart);
    await monitor.check();
    expect(launcher.starts).toBe(0);
    await monitor.check();
    expect(launcher.starts).toBe(1);
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('leaves a busy daemon alone (health timed out, port in use)', async () => {
    const launcher = fakeLauncher({ kind: 'down' }, true);
    const monitor = new HealthMonitor(launcher);
    for (let i = 0; i < 3; i++) await monitor.check();
    expect(launcher.starts).toBe(0);
  });

  it('stops calling start() once MAX_RESTART_ATTEMPTS failed (H-B1)', async () => {
    const launcher = fakeLauncher({ kind: 'down' });
    let attempts = 0;
    launcher.getRestartAttempts = vi.fn(() => attempts);
    launcher.start = vi.fn(async () => {
      launcher.starts++;
      attempts++;
      return false;
    });
    const monitor = new HealthMonitor(launcher);
    const checks = (ENV_DEFAULTS.MAX_RESTART_ATTEMPTS + 3) * ENV_DEFAULTS.HEALTH_CHECK_MAX_FAILURES;
    for (let i = 0; i < checks; i++) await monitor.check();
    expect(launcher.starts).toBe(ENV_DEFAULTS.MAX_RESTART_ATTEMPTS);
  });

  it('counts missing checks afresh after a failed start', async () => {
    const launcher = fakeLauncher({ kind: 'down' });
    launcher.start = vi.fn(async () => {
      launcher.starts++;
      return false;
    });
    const monitor = new HealthMonitor(launcher);
    for (let i = 0; i < ENV_DEFAULTS.HEALTH_CHECK_MAX_FAILURES; i++) await monitor.check();
    expect(launcher.starts).toBe(1);
    await monitor.check();
    expect(launcher.starts).toBe(1); // needs HEALTH_CHECK_MAX_FAILURES (2) misses again
  });
});
