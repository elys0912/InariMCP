/**
 * Health monitor for the shared daemon.
 *
 * Every 10 s: GET /health. When it fails, look at the port:
 *   - something still listens → the daemon is alive but slow (a long tool
 *     call, a busy event loop). Do nothing: it serves other Claude Code
 *     sessions too, and is never killed from here.
 *   - nothing listens (2 checks in a row) → the daemon is really gone
 *     (crashed, or exited after its idle timeout while Firefox was closed):
 *     start a new one, with exponential backoff and at most 10 attempts.
 *
 * Division of labour with ws-client.ts:
 *  - HealthMonitor starts the daemon when it is missing.
 *  - ServerConnection owns the *WebSocket*: it reconnects on its own with
 *    exponential backoff and never starts the daemon. After a successful
 *    start the monitor calls `onRestart` so the WS reconnects right away
 *    instead of waiting out its current backoff delay.
 */

import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import type { ServerLauncher } from './server-launcher.js';
import { log } from './logger.js';

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive checks that found the port free (no daemon process). */
  private consecutiveMissing = 0;
  private checking = false;
  private readonly launcher: ServerLauncher;
  private readonly onRestart: (() => void) | undefined;

  constructor(launcher: ServerLauncher, onRestart?: () => void) {
    this.launcher = launcher;
    this.onRestart = onRestart;
  }

  start(): void {
    if (this.timer !== null) return;

    log('health monitor started');

    this.timer = setInterval(() => {
      void this.check();
    }, ENV_DEFAULTS.HEALTH_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log('health monitor stopped');
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;

    try {
      // Reset backoff counter if the daemon has been stable long enough
      this.launcher.resetBackoff();

      if (await this.launcher.checkHealth()) {
        if (this.consecutiveMissing > 0) {
          log('daemon is back');
        }
        this.consecutiveMissing = 0;
        return;
      }

      if (await this.launcher.isPortInUse()) {
        // Alive but not answering in time: wait, never kill.
        this.consecutiveMissing = 0;
        log('health check failed but the port is in use — daemon busy, leaving it alone');
        return;
      }

      this.consecutiveMissing++;
      log(`daemon not running (${this.consecutiveMissing} consecutive check(s))`);

      if (this.consecutiveMissing < ENV_DEFAULTS.HEALTH_CHECK_MAX_FAILURES) return;

      if (this.launcher.getRestartAttempts() >= ENV_DEFAULTS.MAX_RESTART_ATTEMPTS) {
        log('max start attempts reached — manual intervention required');
        return;
      }

      const delay = this.launcher.getBackoffDelay();
      if (delay > 0 && this.launcher.getRestartAttempts() > 0) {
        log(`backoff delay: ${delay}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      // Someone else (a relay) may have started it during the delay.
      if ((await this.launcher.checkHealth()) || (await this.launcher.isPortInUse())) {
        log('daemon appeared meanwhile — not starting another');
        this.consecutiveMissing = 0;
        this.onRestart?.();
        return;
      }

      log('starting daemon');
      if (await this.launcher.start()) {
        this.consecutiveMissing = 0;
        this.onRestart?.();
      } else {
        log('failed to start daemon');
      }
    } finally {
      this.checking = false;
    }
  }
}
