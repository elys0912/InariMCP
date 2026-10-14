/**
 * WebSocket server bridge for browser connections.
 *
 * Uses the `ws` library. Listens on `ws://{host}:{FOX_WS_PORT}` (the daemon
 * passes FOX_HOST; ENV_DEFAULTS.FOX_HOST when none is given).
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
 *  3. Client answers within AUTH_TIMEOUT_MS with
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
import { ENV_DEFAULTS, isRecord, parseBrowserResponse, shortId } from '@inari-mcp/shared';
import type { BrowserConnectionManager } from '../connection/manager.js';
import { AUTH_PROTOCOL, computeMac, frameText, isNonce, MAC_LABEL, macMatches, newNonce, stderrLogger } from '@inari-mcp/shared/node';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_TIMEOUT_MS = 5_000; // for the auth frame (the Native Host answers at once)
/**
 * Connections that have not sent their auth frame yet. Bounds, with
 * MAX_UNAUTHENTICATED_BYTES, what a local process without the token can
 * make us hold.
 */
const MAX_UNAUTHENTICATED = 8;
/** Largest frame accepted before authentication (the auth frame is ~200 bytes). */
const MAX_AUTH_FRAME_BYTES = 4_096;
/**
 * Raw bytes a connection may send before it has authenticated. Counted on
 * the socket, so a large first frame is cut off while it arrives instead of
 * being buffered up to MAX_PAYLOAD_BYTES first.
 */
const MAX_UNAUTHENTICATED_BYTES = 64 * 1024;
/** How long a refused connection has to answer our close frame before it is cut. */
const CLOSE_GRACE_MS = 1_000;
/** Largest frame accepted at all: the Native Host's own cap on Extension frames. */
const MAX_PAYLOAD_BYTES = ENV_DEFAULTS.NATIVE_MSG_MAX_INCOMING_SIZE;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** How long the older Native Hosts have to answer the ping sent when a new one authenticates. */
const NEWCOMER_PROBE_TIMEOUT_MS = 5_000;

const POLICY_VIOLATION = 1008;
const MESSAGE_TOO_BIG = 1009;
const TRY_AGAIN_LATER = 1013;

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

function frameLength(raw: Buffer | ArrayBuffer | Buffer[]): number {
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0);
  return raw instanceof ArrayBuffer ? raw.byteLength : raw.length;
}

const log = stderrLogger();

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

/** State shared by the connections of one server. */
interface WsServerState {
  readonly apiToken: string;
  readonly connectionManager: BrowserConnectionManager;
  readonly probeTimeoutMs: number;
  /** Authenticated Native Host sockets. */
  readonly hosts: Set<HostSocket>;
  /** Connections that have not sent their auth frame yet (MAX_UNAUTHENTICATED). */
  unauthenticated: number;
}

type RawFrame = Buffer | ArrayBuffer | Buffer[];

/**
 * Refuse an unauthenticated connection. close() waits for the peer's
 * close frame (up to 30 s in `ws`); a peer that never sends it would
 * keep the socket open, so it is cut after CLOSE_GRACE_MS.
 */
function refuse(ws: WebSocket, code: number, reason: string): void {
  ws.close(code, reason);
  setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
}

type AuthCheck =
  | { ok: true; clientNonce: string }
  | { ok: false; code: number; reason: string; logText: string };

/** Check the first frame of a connection against our challenge (step 3 of the header comment). */
function checkAuthFrame(raw: RawFrame, apiToken: string, serverNonce: string): AuthCheck {
  if (frameLength(raw) > MAX_AUTH_FRAME_BYTES) {
    return { ok: false, code: MESSAGE_TOO_BIG, reason: 'auth frame too large', logText: 'oversized auth frame' };
  }

  let msg: unknown;
  try {
    msg = JSON.parse(frameText(raw));
  } catch {
    msg = undefined;
  }
  const frame = isRecord(msg) ? msg : {};

  if (frame['type'] !== 'auth' || frame['protocol'] !== AUTH_PROTOCOL) {
    const legacy = typeof frame['token'] === 'string';
    return {
      ok: false,
      code: POLICY_VIOLATION,
      reason: legacy ? 'auth protocol mismatch' : 'auth required',
      logText: legacy
        ? 'plaintext token frame from an older Native Host (update it: this daemon uses challenge-response auth)'
        : 'no valid auth frame',
    };
  }

  const clientNonce = frame['nonce'];
  if (
    !isNonce(clientNonce) ||
    !macMatches(frame['mac'], computeMac(apiToken, MAC_LABEL.wsClient, serverNonce, clientNonce))
  ) {
    return { ok: false, code: POLICY_VIOLATION, reason: 'auth failed', logText: 'invalid auth MAC' };
  }
  return { ok: true, clientNonce };
}

/**
 * Cut a connection that sends more than MAX_UNAUTHENTICATED_BYTES before its
 * auth frame is in. A peer still sending would not read a close frame, and
 * `ws` would go on buffering what it sends: cut it at once (terminate()
 * right after close(): the close frame is queued, but not waited for).
 *
 * @returns stops the count (call it when the first frame is in)
 */
function limitBytesBeforeAuth(ws: WebSocket, req: IncomingMessage): () => void {
  let received = 0;
  // Set by the first frame. `ws` may deliver it from inside the very
  // 'data' event that also carries later bytes, and an emit already in
  // progress still calls a listener removed meanwhile: those must not count.
  let stopped = false;
  const countBytes = (chunk: Buffer): void => {
    if (stopped) return;
    received += chunk.length;
    if (received <= MAX_UNAUTHENTICATED_BYTES) return;
    req.socket.off('data', countBytes);
    log('WebSocket connection refused: too much data before auth');
    ws.close(MESSAGE_TOO_BIG, 'too much data before auth');
    ws.terminate();
  };
  req.socket.on('data', countBytes);
  ws.on('close', () => req.socket.off('data', countBytes));
  return () => {
    stopped = true;
    req.socket.off('data', countBytes);
  };
}

/**
 * Send the challenge and wait for the auth frame, within AUTH_TIMEOUT_MS
 * and MAX_UNAUTHENTICATED_BYTES. Calls `onAuthenticated` from the 'message'
 * event of that frame, so that the handlers it attaches see the next frame.
 */
function awaitAuthFrame(
  state: WsServerState,
  ws: WebSocket,
  req: IncomingMessage,
  onAuthenticated: (serverNonce: string, clientNonce: string) => void,
): void {
  state.unauthenticated++;
  let counted = true;
  const settle = (): void => {
    if (counted) state.unauthenticated--;
    counted = false;
  };
  ws.on('close', settle);

  const stopCounting = limitBytesBeforeAuth(ws, req);

  // ----- Challenge (AUTH_TIMEOUT_MS to answer) -----
  const serverNonce = newNonce();
  const authTimer = setTimeout(() => {
    log('WebSocket connection refused: auth timeout');
    refuse(ws, POLICY_VIOLATION, 'auth timeout');
  }, AUTH_TIMEOUT_MS);
  ws.on('close', () => clearTimeout(authTimer));
  ws.send(JSON.stringify({ type: 'auth_challenge', protocol: AUTH_PROTOCOL, nonce: serverNonce }));

  ws.once('message', (raw: RawFrame) => {
    clearTimeout(authTimer);
    settle();
    stopCounting();

    const check = checkAuthFrame(raw, state.apiToken, serverNonce);
    if (!check.ok) {
      log(`WebSocket connection refused: ${check.logText}`);
      refuse(ws, check.code, check.reason);
      return;
    }
    onAuthenticated(serverNonce, check.clientNonce);
  });
}

/**
 * A new Native Host is in: make sure the older ones are still alive.
 * The probe keeps its own send time; it must not touch lastPingAt, or a
 * heartbeat tick right after it would count the probe's still-pending pong
 * as a missed one.
 */
function probeOthers(state: WsServerState, newcomer: HostSocket): void {
  for (const h of state.hosts) {
    if (h === newcomer) continue;
    const sentAt = Date.now();
    try {
      h.ws.ping();
    } catch {
      h.ws.terminate();
      continue;
    }
    const timer = setTimeout(() => {
      if (h.lastPongAt < sentAt && state.hosts.has(h)) {
        log(`WebSocket ${h.browserId} did not answer the probe — terminating (a newer Native Host connected)`);
        h.ws.terminate();
      }
    }, state.probeTimeoutMs);
    timer.unref();
  }
}

/** A frame from an authenticated Native Host: a command response, or an event. */
function handleHostFrame(connectionManager: BrowserConnectionManager, data: RawFrame): void {
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
  const eventType = isRecord(parsed) && 'type' in parsed ? String(parsed['type']) : 'unknown';
  log(`Browser event: ${eventType}`);
}

/**
 * Authenticated — prove ourselves, then register the socket as a browser
 * connection under `id`.
 */
function attachAuthenticated(
  state: WsServerState,
  ws: WebSocket,
  id: string,
  serverNonce: string,
  clientNonce: string,
): void {
  const { connectionManager, hosts } = state;
  ws.send(JSON.stringify({
    type: 'auth_ok',
    mac: computeMac(state.apiToken, MAC_LABEL.wsServer, serverNonce, clientNonce),
  }));
  connectionManager.registerBrowser(id, (command) => {
    if (ws.readyState !== ws.OPEN) {
      throw new Error('WebSocket is not open');
    }
    ws.send(JSON.stringify(command));
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
    probeOthers(state, entry);
  }

  // ----- Subsequent messages -----
  ws.on('message', (data: RawFrame) => handleHostFrame(connectionManager, data));

  ws.on('close', () => {
    hosts.delete(entry);
    connectionManager.unregisterBrowser(id);
  });
}

function handleConnection(state: WsServerState, ws: WebSocket, req: IncomingMessage): void {
  // The ID the socket is registered under once authenticated; known from
  // the start so every log line about this socket names it.
  const browserId = `ws_${Date.now()}_${shortId()}`;
  let authenticated = false;
  // First, before anything can fail: an invalid frame makes `ws` emit
  // 'error' on the socket, and an unhandled 'error' would end the daemon.
  ws.on('error', (err) => {
    log(`WebSocket error (${browserId}${authenticated ? '' : ', unauthenticated'}): ${err.message}`);
  });

  const origin = req.headers.origin;

  // ----- Origin check -----
  if (!isOriginAllowed(origin)) {
    log(`WebSocket connection refused: invalid origin "${origin}"`);
    refuse(ws, POLICY_VIOLATION, 'invalid origin');
    return;
  }

  if (state.unauthenticated >= MAX_UNAUTHENTICATED) {
    log(`WebSocket connection refused: ${MAX_UNAUTHENTICATED} connections already waiting for auth`);
    refuse(ws, TRY_AGAIN_LATER, 'too many pending connections');
    return;
  }

  awaitAuthFrame(state, ws, req, (serverNonce, clientNonce) => {
    authenticated = true;
    attachAuthenticated(state, ws, browserId, serverNonce, clientNonce);
  });
}

/**
 * Start the WebSocket server for the Native Host connections.
 *
 * @returns The WebSocketServer instance, once it is listening. Rejects with
 *          the listen error (e.g. EADDRINUSE) — same contract as
 *          startHttpBridge().
 */
export function startWebSocketServer(options: WsBridgeOptions): Promise<WebSocketServer> {
  const { port, apiToken, connectionManager, host = ENV_DEFAULTS.FOX_HOST } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const state: WsServerState = {
    apiToken,
    connectionManager,
    probeTimeoutMs: options.probeTimeoutMs ?? NEWCOMER_PROBE_TIMEOUT_MS,
    hosts: new Set<HostSocket>(),
    unauthenticated: 0,
  };

  const wss = new WebSocketServer({ host, port, maxPayload: MAX_PAYLOAD_BYTES });

  const ping = (h: HostSocket): void => {
    h.lastPingAt = Date.now();
    try {
      h.ws.ping();
    } catch {
      h.ws.terminate();
    }
  };

  const heartbeat = setInterval(() => {
    for (const h of state.hosts) {
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

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => handleConnection(state, ws, req));

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
