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
 */

import * as http from 'node:http';
import type { WebSocketServer } from 'ws';

import { ENV } from '@kitsune-mcp/shared';
import { startHttpBridge } from '../transport/http-bridge.js';
import { startWebSocketServer } from '../transport/ws-bridge.js';
import { getConnectionManager } from '../connection/manager.js';
import { isHeadlessEnabled } from '../utils/headless-env.js';
import { getSafetyGuard } from '../safety/guard.js';
import { getContainerConfig } from '../safety/container.js';
import {
  isLoopbackHost,
  loadOrCreateApiToken,
  resolveHost,
  resolveHttpPort,
  resolveWsPort,
  snapshotDaemonSettings,
} from '../utils/endpoint.js';
import { DaemonActivity, resolveIdleTimeoutMs } from './activity.js';

const PACKAGE_VERSION = '0.1.0';

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:daemon] ${msg}\n`);
}

function isAddrInUse(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EADDRINUSE';
}

/** GET /health on the given port answers as a KitsuneMCP daemon. */
function probeHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 2_000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
        const health = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
        resolve(res.statusCode === 200 && health['status'] === 'ok' && health['service'] === 'kitsune-mcp');
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Register the headless backend with the connection manager (FOX_HEADLESS=1). */
async function startHeadless(): Promise<void> {
  const connectionManager = getConnectionManager();
  const { initHeadlessBrowser } = await import('../headless/backend.js');
  const headless = await initHeadlessBrowser();

  // Layer 0 cannot be honoured without Firefox containers: the guard
  // refuses every command (checkHeadlessContainerScope). Say so up front.
  const containerCfg = getContainerConfig(getSafetyGuard().config);
  if (containerCfg.enabled) {
    log(
      `WARNING: container_scope is enabled ('${containerCfg.containerName}') ` +
      'but the headless backend has no containers — all browser commands will be ' +
      'refused as out_of_scope.',
    );
  }

  connectionManager.registerBrowser('headless', (message: string) => {
    const command = JSON.parse(message) as { action: string; tabId?: number; data?: Record<string, unknown>; requestId: string };
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
  const activity = new DaemonActivity();
  const settings = snapshotDaemonSettings();

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

  // --- HTTP port first: it is the singleton lock ---
  let httpServer: http.Server;
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
      }),
    });
  } catch (err: unknown) {
    if (isAddrInUse(err)) {
      if (await probeHealth(host, httpPort)) {
        log(`another KitsuneMCP daemon already owns ${host}:${httpPort} — exiting`);
        process.exit(0);
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
  let wsServer: WebSocketServer;
  try {
    wsServer = await startWebSocketServer({ host, port: wsPort, apiToken, connectionManager });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`cannot listen on ws://${host}:${wsPort}: ${msg}. Set ${ENV.FOX_WS_PORT} to a free port.`);
    httpServer.close();
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

  // --- Shutdown ---
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${reason} — shutting down`);
    activity.stop();
    httpServer.close();
    wsServer.close();
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
    log('shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT received'));
  process.on('SIGTERM', () => void shutdown('SIGTERM received'));

  activity.start(
    () => connectionManager.nativeHostCount,
    () => void shutdown(`idle for ${idleMs / 1000}s (no relay, no Native Host)`),
  );
}
