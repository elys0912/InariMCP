/**
 * Health monitor for the MCP server.
 *
 * Runs periodic health checks and triggers automatic restart
 * after consecutive failures, with exponential backoff.
 */

import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import type { ServerLauncher } from './server-launcher.js';

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:NativeHost] ${msg}\n`);
}

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private checking = false;
  private readonly launcher: ServerLauncher;

  constructor(launcher: ServerLauncher) {
    this.launcher = launcher;
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
      // Reset backoff counter if server has been stable long enough
      this.launcher.resetBackoff();

      const healthy = await this.launcher.checkHealth();

      if (healthy) {
        if (this.consecutiveFailures > 0) {
          log(`MCP server recovered after ${this.consecutiveFailures} failure(s)`);
        }
        this.consecutiveFailures = 0;
        return;
      }

      this.consecutiveFailures++;
      log(`health check failed (${this.consecutiveFailures} consecutive)`);

      if (this.consecutiveFailures >= ENV_DEFAULTS.HEALTH_CHECK_MAX_FAILURES) {
        if (this.launcher.getRestartAttempts() >= ENV_DEFAULTS.MAX_RESTART_ATTEMPTS) {
          log('max restart attempts reached — manual intervention required');
          return;
        }

        log('attempting to restart MCP server');

        // Kill stale process if port is occupied
        if (await this.launcher.isPortInUse()) {
          log('killing stale process on port');
          await this.launcher.killExisting();
        }

        // Wait for backoff delay before restarting
        const delay = this.launcher.getBackoffDelay();
        log(`backoff delay: ${delay}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));

        await this.launcher.stop();

        if (await this.launcher.start()) {
          log('MCP server restart initiated');
          this.consecutiveFailures = 0;
        } else {
          log('failed to restart MCP server');
        }
      }
    } finally {
      this.checking = false;
    }
  }
}
