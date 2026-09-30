/**
 * WebSocket server bridge for browser connections.
 *
 * Uses the `ws` library. Listens on `ws://127.0.0.1:{FOX_WS_PORT}`.
 *
 * v0.1 client: the Native Host (packages/native-host/src/ws-client.ts),
 * which relays commands to the Extension over Native Messaging. A direct
 * Extension → WS connection is a future option; the Origin
 * rule below already admits it.
 *
 * Fork-source: server.py L1479-1540
 *
 * Handshake (mutual challenge-response, see auth.ts):
 *  1. Client connects. Origin check: absent (non-browser client such as the
 *     Native Host) or `moz-extension://` → continue; anything else → 1008.
 *     Browsers always send Origin on WebSocket upgrades, so a web page
 *     cannot pose as an Origin-less client; and every client, with or
 *     without Origin, must still pass step 2.
 *  2. Server sends `{ type: 'auth_challenge', protocol, nonce: S }`.
 *  3. Client answers within 10 s with
 *     `{ type: 'auth', protocol, nonce: C, mac: MAC('ws-client', S, C) }`.
 *     Anything else (including the old `{ token }` frame), a bad MAC or a
 *     timeout → close 1008 (Policy Violation). The token never travels.
 *  4. Server replies `{ type: 'auth_ok', mac: MAC('ws-server', S, C) }` —
 *     the client checks it, so a program squatting on the port without the
 *     token cannot pose as the daemon — and registers the connection as a
 *     'native-host' browser in the connection manager.
 *
 * After the handshake:
 *  - server → client: BrowserCommand JSON (one per frame)
 *  - client → server: BrowserResponse JSON (has `requestId`), validated by
 *    parseBrowserResponse(); frames without `requestId` are logged as events.
 *
 * Robustness: every socket gets an 'error' listener before anything else
 * (an invalid frame must not become an uncaught exception that ends the
 * daemon), frames are capped (maxPayload, and a small cap before auth), and
 * malformed JSON is logged and dropped.
 *
 * Liveness: authenticated sockets are pinged every heartbeat interval and
 * terminated when the previous ping went unanswered (half-open connections,
 * e.g. after sleep). When a new Native Host authenticates, the existing ones
 * are pinged at once and dropped if they do not answer within the probe
 * timeout. The connection manager sends commands to the *earliest* live
 * Native Host, so a later client holding the token cannot take over the
 * command stream of a working browser (threat model 7.Med).
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { ENV_DEFAULTS, parseBrowserResponse } from '@kitsune-mcp/shared';
import type { BrowserConnectionManager } from '../connection/manager.js';
import { AUTH_PROTOCOL, MAC_LABEL, computeMac, isNonce, macMatches, newNonce } from './auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_TIMEOUT_MS = 10_000; // 10 seconds for the auth frame
/** Largest frame accepted before authentication (the auth frame is ~200 bytes). */
const MAX_AUTH_FRAME_BYTES = 4_096;
/** Largest frame accepted at all: the Native Host's own cap on Extension frames. */
const MAX_PAYLOAD_BYTES = ENV_DEFAULTS.NATIVE_MSG_MAX_INCOMING_SIZE;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

const POLICY_VIOLATION = 1008;
const MESSAGE_TOO_BIG = 1009;

// ---------------------------------------------------------------------------
// Origin validation
// ---------------------------------------------------------------------------

/**
 * Validate the Origin header of an incoming WebSocket upgrade request.
 *
 * - If Origin is absent (non-browser client like the Native Host), allow.
 * - If Origin starts with `moz-extension://`, allow.
 * - Anything else is rejected.
 */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // Non-browser client — no Origin header
  return origin.startsWith('moz-extension://');
}

function frameText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf-8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8');
  return raw.toString('utf-8');
}

function frameLength(raw: Buffer | ArrayBuffer | Buffer[]): number {
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0);
  return raw instanceof ArrayBuffer ? raw.byteLength : raw.length;
}

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

export interface WsBridgeOptions {
  host?: string;
  port: number;
  apiToken: string;
  connectionManager: BrowserConnectionManager;
  /** Ping interval for authenticated sockets (tests shorten it). */
  heartbeatIntervalMs?: number;
  /** How long an existing Native Host has to answer the ping sent when a new one connects. */
  probeTimeoutMs?: number;
}

interface HostSocket {
  ws: WebSocket;
  browserId: string;
  lastPingAt: number;
  lastPongAt: number;
}

/**
 * Start the WebSocket server for Extension connections.
 *
 * @returns The WebSocketServer instance, once it is listening. Rejects with
 *          the listen error (e.g. EADDRINUSE) — same contract as
 *          startHttpBridge().
 */
export function startWebSocketServer(options: WsBridgeOptions): Promise<WebSocketServer> {
  const { port, apiToken, connectionManager, host = '127.0.0.1' } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  const wss = new WebSocketServer({ host, port, maxPayload: MAX_PAYLOAD_BYTES });
  const hosts = new Set<HostSocket>();

  const ping = (h: HostSocket): void => {
    h.lastPingAt = Date.now();
    try {
      h.ws.ping();
    } catch {
      h.ws.terminate();
    }
  };

  const heartbeat = setInterval(() => {
    for (const h of hosts) {
      if (h.lastPongAt < h.lastPingAt) {
        log(`WebSocket ${h.browserId} did not answer the last ping — terminating`);
        h.ws.terminate();
        continue;
      }
      ping(h);
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  /**
   * A new Native Host is in: make sure the older ones are still alive.
   * The probe keeps its own send time; it must not touch lastPingAt, or a
   * heartbeat tick right after it would count the probe's still-pending pong
   * as a missed one.
   */
  const probeOthers = (newcomer: HostSocket): void => {
    for (const h of hosts) {
      if (h === newcomer) continue;
      const sentAt = Date.now();
      try {
        h.ws.ping();
      } catch {
        h.ws.terminate();
        continue;
      }
      const timer = setTimeout(() => {
        if (h.lastPongAt < sentAt && hosts.has(h)) {
          log(`WebSocket ${h.browserId} did not answer the probe — terminating (a newer Native Host connected)`);
          h.ws.terminate();
        }
      }, probeTimeoutMs);
      timer.unref();
    }
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // First, before anything can fail: an invalid frame makes `ws` emit
    // 'error' on the socket, and an unhandled 'error' would end the daemon.
    let browserId: string | undefined;
    ws.on('error', (err) => {
      log(`WebSocket error (${browserId ?? 'unauthenticated'}): ${err.message}`);
    });

    const origin = req.headers['origin'] as string | undefined;

    // ----- Origin check -----
    if (!isOriginAllowed(origin)) {
      log(`WebSocket connection refused: invalid origin "${origin}"`);
      ws.close(POLICY_VIOLATION, 'invalid origin');
      return;
    }

    // ----- Challenge (10 s to answer) -----
    const serverNonce = newNonce();
    const authTimer = setTimeout(() => {
      log('WebSocket connection refused: auth timeout');
      ws.close(POLICY_VIOLATION, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    ws.on('close', () => clearTimeout(authTimer));
    ws.send(JSON.stringify({ type: 'auth_challenge', protocol: AUTH_PROTOCOL, nonce: serverNonce }));

    ws.once('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      clearTimeout(authTimer);

      if (frameLength(raw) > MAX_AUTH_FRAME_BYTES) {
        log('WebSocket connection refused: oversized auth frame');
        ws.close(MESSAGE_TOO_BIG, 'auth frame too large');
        return;
      }

      let msg: unknown;
      try {
        msg = JSON.parse(frameText(raw));
      } catch {
        msg = undefined;
      }
      const frame = typeof msg === 'object' && msg !== null ? (msg as Record<string, unknown>) : {};

      if (frame['type'] !== 'auth' || frame['protocol'] !== AUTH_PROTOCOL) {
        const legacy = typeof frame['token'] === 'string';
        log(
          'WebSocket connection refused: ' +
          (legacy
            ? 'plaintext token frame from an older Native Host (update it: this daemon uses challenge-response auth)'
            : 'no valid auth frame'),
        );
        ws.close(POLICY_VIOLATION, legacy ? 'auth protocol mismatch' : 'auth required');
        return;
      }

      const clientNonce = frame['nonce'];
      if (
        !isNonce(clientNonce) ||
        !macMatches(frame['mac'], computeMac(apiToken, MAC_LABEL.wsClient, serverNonce, clientNonce))
      ) {
        log('WebSocket connection refused: invalid auth MAC');
        ws.close(POLICY_VIOLATION, 'auth failed');
        return;
      }

      // ----- Authenticated — prove ourselves, then register -----
      const id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      browserId = id;
      ws.send(JSON.stringify({
        type: 'auth_ok',
        mac: computeMac(apiToken, MAC_LABEL.wsServer, serverNonce, clientNonce),
      }));
      connectionManager.registerBrowser(id, (message: string) => {
        if (ws.readyState !== ws.OPEN) {
          throw new Error('WebSocket is not open');
        }
        ws.send(message);
      }, 'native-host');

      const now = Date.now();
      const entry: HostSocket = { ws, browserId: id, lastPingAt: now, lastPongAt: now };
      hosts.add(entry);
      ws.on('pong', () => { entry.lastPongAt = Date.now(); });
      if (hosts.size > 1) {
        log(
          `${hosts.size} Native Hosts connected — commands go to the earliest live one ` +
          `(${connectionManager.getActiveBrowser()?.id ?? 'none'}); checking the older ones`,
        );
        probeOthers(entry);
      }

      // ----- Subsequent messages -----
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frameText(data));
        } catch {
          log('Invalid JSON from browser WebSocket');
          return;
        }

        if (typeof parsed === 'object' && parsed !== null && 'requestId' in parsed) {
          // Response to a command we sent
          const result = parseBrowserResponse(parsed);
          if (result.ok) {
            connectionManager.handleResponse(result.response);
            return;
          }
          log(result.error);
          if (result.requestId !== undefined) {
            connectionManager.handleResponse({
              requestId: result.requestId,
              success: false,
              error: result.error,
            });
          }
          return;
        }

        // Event from the browser side (no requestId)
        const eventType =
          typeof parsed === 'object' && parsed !== null && 'type' in parsed
            ? String((parsed as { type: unknown }).type)
            : 'unknown';
        log(`Browser event: ${eventType}`);
      });

      ws.on('close', () => {
        hosts.delete(entry);
        connectionManager.unregisterBrowser(id);
      });
    });
  });

  return new Promise<WebSocketServer>((resolve, reject) => {
    const onStartupError = (err: Error): void => {
      wss.close();
      reject(err);
    };
    wss.once('error', onStartupError);
    wss.once('listening', () => {
      wss.removeListener('error', onStartupError);
      wss.on('error', (err) => {
        log(`WebSocket server error: ${err.message}`);
      });
      log(`WebSocket server listening on ws://${host}:${port}`);
      resolve(wss);
    });
  });
}
