/**
 * KitsuneMCP shared daemon (`node dist/index.js --daemon`).
 *
 * The one process that owns the HTTP (FOX_HTTP_PORT, default 8765) and
 * WebSocket (FOX_WS_PORT, default 8766) ports, and with them the
 * SafetyGuard (rate limit, audit log, current URL), the browser connection
 * manager, the ws-bridge the Native Host connects to, and the headless
 * backend. Every Claude Code session reaches it through its own stdio relay
 * (relay/main.ts) via POST /mcp/call.
 *
 * Started on demand — by a relay or by the Native Host, whichever comes
 * first — detached, with stdio disconnected. The HTTP port is the
 * singleton lock: when two daemons start at once, the one that cannot bind
 * exits cleanly (code 0 if the port belongs to a healthy daemon).
 *
 * Stops itself after FOX_DAEMON_IDLE_TIMEOUT seconds (default 600) without a
 * relay, a Native Host connection or an in-flight call (daemon/activity.ts).
 * Stopped on request through the signed POST /daemon/shutdown (relay
 * `--stop-daemon`, scripts/uninstall.mjs): running calls get up to
 * SHUTDOWN_DRAIN_MS to finish, the headless browser is closed, the Native
 * Hosts get WS close 1001, then exit 0.
 */

import * as http from 'node:http';
import type { WebSocketServer } from 'ws';

import { ENV } from '@kitsune-mcp/shared';
import { startHttpBridge } from '../transport/http-bridge.js';
import { startWebSocketServer } from '../transport/ws-bridge.js';
import { getConnectionManager } from '../connection/manager.js';
import { isHeadlessEnabled, unrecognizedHeadlessValue } from '../utils/headless-env.js';
import { getSafetyGuard } from '../safety/guard.js';
import { headlessContainerScopeWarning } from '../safety/container.js';
import {
  isLoopbackHost,
  loadOrCreateApiToken,
  resolveHost,
  resolveHttpPort,
  resolveWsPort,
  effectiveDaemonSettings,
  snapshotDaemonSettings,
} from '../utils/endpoint.js';
import { DaemonActivity, resolveIdleTimeoutMs } from './activity.js';
import { PACKAGE_VERSION } from '../version.js';
import { stderrLogger } from '@kitsune-mcp/shared/node';
import { probeExistingDaemon } from './probe.js';

const log = stderrLogger('daemon');

/** How long a graceful stop waits for running tool calls (POST /daemon/shutdown without force). */
export const SHUTDOWN_DRAIN_MS = 10_000;
/** WebSocket close code sent to the Native Hosts on shutdown (RFC 6455 "Going Away"). */
const WS_GOING_AWAY = 1001;

function isAddrInUse(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EADDRINUSE';
}

/** Register the headless backend with the connection manager (FOX_HEADLESS=1). */
async function startHeadless(): Promise<void> {
  const connectionManager = getConnectionManager();
  const { initHeadlessBrowser } = await import('../headless/backend.js');
  const headless = await initHeadlessBrowser();

  // Layer 0 cannot be honoured without Firefox containers: the guard
  // refuses every command (checkHeadlessContainerScope). Say so up front.
  const containerWarning = headlessContainerScopeWarning(getSafetyGuard().config);
  if (containerWarning !== null) log(`WARNING: ${containerWarning}`);

  connectionManager.registerBrowser('headless', (command) => {
    headless.execute(command.action, command.tabId, command.data ?? {})
      .then((result) => {
        connectionManager.handleResponse({
          requestId: command.requestId,
          success: (result as Record<string, unknown>).success === true,
          data: result,
          error: typeof (result as Record<string, unknown>).error === 'string'
            ? (result as Record<string, unknown>).error as string
            : undefined,
        });
      })
      .catch((err: unknown) => {
        connectionManager.handleResponse({
          requestId: command.requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, 'headless');
}

export async function runDaemon(): Promise<void> {
  const connectionManager = getConnectionManager();
  const host = resolveHost();
  const httpPort = resolveHttpPort();
  const wsPort = resolveWsPort();
  const headlessMode = isHeadlessEnabled();
  const odd = unrecognizedHeadlessValue();
  if (odd !== undefined) {
    log(`WARNING: ${ENV.FOX_HEADLESS}='${odd}' is not 1/true/yes — headless mode is OFF`);
  }
  const activity = new DaemonActivity();
  const settings = snapshotDaemonSettings();
  const effectiveSettings = effectiveDaemonSettings(process.env);

  if (!isLoopbackHost(host)) {
    log(
      `WARNING: ${ENV.FOX_HOST}=${host} is not a loopback address — the HTTP and WebSocket ` +
      'ports are reachable from other machines. Every endpoint except /health still needs ' +
      'the API token, but browser control should stay local: unset it unless you really need this.',
    );
  }

  // Only the daemon generates the token (race-safe, see loadOrCreateApiToken).
  const apiToken = loadOrCreateApiToken();

  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });

  // --- Shutdown (two steps: everything but the exit, then the exit) ---
  // Signals run both at once. POST /daemon/shutdown runs prepare(), answers,
  // and calls exit() once the answer is out (transport/http-bridge.ts).
  let httpServer: http.Server | undefined;
  let wsServer: WebSocketServer | undefined;
  let preparing: Promise<Record<string, unknown>> | undefined;

  const prepareShutdown = (reason: string, force: boolean): Promise<Record<string, unknown>> => {
    preparing ??= (async (): Promise<Record<string, unknown>> => {
      log(`${reason} — shutting down${force ? ' (forced)' : ''}`);
      activity.stop();

      // Let running commands finish (the bridge refuses new ones meanwhile).
      const startedAt = Date.now();
      let drained = activity.inFlightCalls === 0;
      if (!drained && !force) drained = await activity.waitForIdle(SHUTDOWN_DRAIN_MS);
      const waitedMs = Date.now() - startedAt;
      if (!drained) log(`${activity.inFlightCalls} call(s) still running after ${waitedMs} ms — cancelling them`);

      // Native Hosts: 1001 Going Away, so they know this was deliberate.
      if (wsServer !== undefined) {
        for (const client of wsServer.clients) {
          try {
            client.close(WS_GOING_AWAY, 'daemon shutting down');
          } catch {
            // Best-effort
          }
        }
        wsServer.close();
      }

      if (headlessMode) {
        try {
          // Loaded on demand: playwright is only needed in headless mode.
          const { getHeadlessBrowser } = await import('../headless/backend.js');
          await getHeadlessBrowser()?.stop();
        } catch {
          // Best-effort
        }
      }
      connectionManager.shutdown();
      return { waitedMs, drained, cancelledCalls: drained ? 0 : activity.inFlightCalls };
    })();
    return preparing;
  };

  const exitNow = (): void => {
    httpServer?.close();
    log('shutdown complete');
    process.exit(0);
  };

  // Signals and the idle timer stop at once, as before POST /daemon/shutdown
  // existed (idle: nothing runs; a signal sender has its own kill timeout).
  const shutdown = async (reason: string): Promise<void> => {
    await prepareShutdown(reason, true);
    exitNow();
  };

  // --- HTTP port first: it is the singleton lock ---
  try {
    httpServer = await startHttpBridge({
      host,
      port: httpPort,
      apiToken,
      connectionManager,
      ready,
      activity,
      info: () => ({
        headless: headlessMode,
        nativeHosts: connectionManager.nativeHostCount,
        settings,
        effectiveSettings,
      }),
      shutdown: {
        prepare: ({ force }) => prepareShutdown('POST /daemon/shutdown', force),
        exit: exitNow,
      },
    });
  } catch (err: unknown) {
    if (isAddrInUse(err)) {
      const occupant = await probeExistingDaemon(host, httpPort, apiToken);
      if (occupant.kind === 'ok') {
        log(`another KitsuneMCP daemon already owns ${host}:${httpPort} — exiting`);
        process.exit(0);
      }
      if (occupant.kind === 'impostor') {
        log(
          `port ${host}:${httpPort} answers as a KitsuneMCP daemon but cannot prove it holds ` +
          'this user\'s API token (a daemon started before the token file was replaced, ' +
          'another user\'s daemon, or a program impersonating it). ' +
          `Stop it, or set ${ENV.FOX_HTTP_PORT} (and ${ENV.FOX_WS_PORT}) to free ports.`,
        );
        process.exit(1);
      }
      if (occupant.kind === 'incompatible') {
        log(
          `port ${host}:${httpPort} is owned by a KitsuneMCP daemon of another protocol ` +
          `(${String(occupant.protocol)}${occupant.version ? `, v${occupant.version}` : ''}): stop it and retry.`,
        );
        process.exit(1);
      }
      log(
        `port ${host}:${httpPort} is in use by another program. ` +
        `Set ${ENV.FOX_HTTP_PORT} (and ${ENV.FOX_WS_PORT}) to free ports.`,
      );
      process.exit(1);
    }
    throw err;
  }

  // --- WebSocket bridge (Native Host) ---
  try {
    wsServer = await startWebSocketServer({ host, port: wsPort, apiToken, connectionManager });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`cannot listen on ws://${host}:${wsPort}: ${msg}. Set ${ENV.FOX_WS_PORT} to a free port.`);
    httpServer?.close();
    process.exit(1);
  }

  // --- Headless backend (after the ports: don't boot Firefox for a loser) ---
  if (headlessMode) {
    await startHeadless();
  }
  markReady();

  const idleMs = resolveIdleTimeoutMs();
  process.stderr.write([
    `[KitsuneMCP:daemon] kitsune-mcp v${PACKAGE_VERSION} (PID ${process.pid})`,
    `[KitsuneMCP:daemon] HTTP  : ${host}:${httpPort}`,
    `[KitsuneMCP:daemon] WS    : ${host}:${wsPort}`,
    `[KitsuneMCP:daemon] Mode  : ${headlessMode ? 'headless' : 'extension'}`,
    `[KitsuneMCP:daemon] Idle  : ${idleMs === 0 ? 'never exits' : `exits after ${idleMs / 1000}s unused`}`,
  ].join('\n') + '\n');

  process.on('SIGINT', () => void shutdown('SIGINT received'));
  process.on('SIGTERM', () => void shutdown('SIGTERM received'));

  activity.start(
    () => connectionManager.nativeHostCount,
    () => void shutdown(`idle for ${idleMs / 1000}s (no relay, no Native Host)`),
  );
}
