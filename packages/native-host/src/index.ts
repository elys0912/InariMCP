/**
 * KitsuneMCP Native Messaging Host — main entry point.
 *
 * Bridges the Firefox Extension (stdin/stdout, Native Messaging protocol)
 * and the MCP Server (WebSocket client to its ws-bridge):
 *
 *   MCP Server ──WS──▶ Native Host ──Native Messaging──▶ Extension
 *   MCP Server ◀──WS── Native Host ◀──Native Messaging── Extension
 *
 * Commands from the server are passed to the Extension unmodified. Responses
 * from the Extension have their screenshot data URLs saved to disk and
 * replaced by `imagePath` before they go back to the server.
 */

import { ServerLauncher, daemonLogPath } from './server-launcher.js';
import { ServerConnection } from './ws-client.js';
import { HealthMonitor } from './health-monitor.js';
import { handleServerCommand, runStdinLoop } from './host.js';
import { activeLogPath, log, rotateIfLarge } from './logger.js';
import { pruneScreenshots, screenshotsDirNeedsAclCheck, getScreenshotsDir } from './screenshot-store.js';
import { installProcessHandlers } from './process-handlers.js';
import { HOST_VERSION } from './version.js';

let running = true;

function shutdown(connection: ServerConnection, monitor: HealthMonitor): void {
  if (!running) return;
  running = false;
  log('shutting down');
  connection.stop();
  monitor.stop();
  // Never stop the daemon: it also serves the Claude Code sessions (relays),
  // and exits on its own once nobody uses it.
}

/** daemon.log is written by a long-lived daemon, so it is also checked while we run. */
const DAEMON_LOG_CHECK_MS = 60 * 60_000;

/** Longest wait for a daemon start in progress when stdin closes. */
const STARTUP_CLEANUP_WAIT_MS = 5_000;

/** Data retention and log housekeeping; never throws. */
function housekeeping(): void {
  try {
    const removed = pruneScreenshots();
    if (removed > 0) log(`removed ${removed} screenshot(s) past the retention period`);
    if (screenshotsDirNeedsAclCheck()) {
      log(
        `screenshots directory ${getScreenshotsDir()} is outside the user profile: ` +
        'file modes (0o600) have no effect on Windows, check the directory ACL',
      );
    }
    setInterval(() => rotateIfLarge(daemonLogPath(), true), DAEMON_LOG_CHECK_MS).unref();
  } catch (err: unknown) {
    log(`housekeeping failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  log('========================================');
  log(`KitsuneMCP Native Host v${HOST_VERSION} starting (PID ${process.pid})`);
  log(`log file: ${activeLogPath() ?? '(disabled by FOX_NATIVE_HOST_LOG)'}`);

  const launcher = new ServerLauncher();
  log(`MCP server target: http://${launcher.host}:${launcher.httpPort} (WS port ${launcher.wsPort})`);

  const connection: ServerConnection = new ServerConnection(
    launcher,
    (command) => handleServerCommand(command, connection),
  );
  const monitor = new HealthMonitor(launcher, () => connection.reconnectNow());

  // Graceful shutdown
  const onSignal = (): void => {
    shutdown(connection, monitor);
    process.exit(0);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  housekeeping();

  // Connect to the shared daemon, starting it if nothing listens on the port.
  // This can take up to ~35 s, so it runs beside the stdin loop below: the
  // Extension's ping (30 s timeout) must be answered while it is in progress.
  const startup = launcher.ensureRunning()
    .catch((err: unknown) => {
      log(`ensureRunning failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .then(() => {
      if (!running) return;
      connection.start();
      monitor.start();
    });

  log('ready — listening for Extension messages on stdin');
  log('========================================');

  await runStdinLoop(launcher, connection, () => running);

  // Let a daemon start in progress finish its cleanup (temporary task / files),
  // but do not hold the exit for long.
  await Promise.race([startup, new Promise<void>((r) => setTimeout(r, STARTUP_CLEANUP_WAIT_MS))]);

  shutdown(connection, monitor);
  process.exit(0);
}

// uncaughtException / unhandledRejection / stdout errors (policy: process-handlers.ts)
installProcessHandlers(log);

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log(`fatal error: ${msg}`);
  process.exit(1);
});
