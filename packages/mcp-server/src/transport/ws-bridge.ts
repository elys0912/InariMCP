/**
 * WebSocket server bridge for browser connections.
 *
 * Uses the `ws` library. Listens on `ws://127.0.0.1:{FOX_WS_PORT}`.
 *
 * v0.1 client: the Native Host (packages/native-host/src/ws-client.ts),
 * which relays commands to the Extension over Native Messaging. A direct
 * Extension → WS connection is a future option (design.md 5.3); the Origin
 * rule below already admits it.
 *
 * Fork-source: server.py L1479-1540
 *
 * Handshake:
 *  1. Client connects. Origin check: absent (non-browser client such as the
 *     Native Host) or `moz-extension://` → continue; anything else → 1008.
 *     Browsers always send Origin on WebSocket upgrades, so a web page
 *     cannot pose as an Origin-less client; and every client, with or
 *     without Origin, must still pass step 2.
 *  2. Client sends `{ "token": "<API_TOKEN>" }` as its first frame within
 *     10 s (design.md 8.2). Compared with crypto.timingSafeEqual
 *     (design.md 7.3). Failure / timeout → close 1008 (Policy Violation).
 *  3. Server replies `{ "type": "auth_ok" }` and registers the connection
 *     as a 'native-host' browser in the connection manager.
 *
 * After the handshake:
 *  - server → client: BrowserCommand JSON (one per frame)
 *  - client → server: BrowserResponse JSON (has `requestId`), validated by
 *    parseBrowserResponse(); frames without `requestId` are logged as events.
 */

import * as crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { parseBrowserResponse } from '@kitsune-mcp/shared';
import type { BrowserConnectionManager } from '../connection/manager.js';

// ---------------------------------------------------------------------------
// Constants (design.md 8.2)
// ---------------------------------------------------------------------------

const AUTH_TIMEOUT_MS = 10_000; // 10 seconds for first-frame auth

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

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

function verifyToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');

  if (a.length !== b.length) {
    // Dummy comparison to keep timing constant
    crypto.timingSafeEqual(b, b);
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

export interface WsBridgeOptions {
  host?: string;
  port: number;
  apiToken: string;
  connectionManager: BrowserConnectionManager;
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

  const wss = new WebSocketServer({ host, port });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const origin = req.headers['origin'] as string | undefined;

    // ----- Origin check -----
    if (!isOriginAllowed(origin)) {
      process.stderr.write(
        `[KitsuneMCP] WebSocket connection refused: invalid origin "${origin}"\n`,
      );
      ws.close(1008, 'invalid origin');
      return;
    }

    // ----- First-frame auth (10 s timeout) -----
    const authTimer = setTimeout(() => {
      process.stderr.write(
        '[KitsuneMCP] WebSocket connection refused: auth timeout\n',
      );
      ws.close(1008, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    let authenticated = false;

    ws.once('message', (raw: Buffer | string) => {
      clearTimeout(authTimer);

      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
        if (
          msg &&
          typeof msg === 'object' &&
          typeof msg.token === 'string' &&
          verifyToken(msg.token, apiToken)
        ) {
          authenticated = true;
        }
      } catch {
        // parse failure → auth failed
      }

      if (!authenticated) {
        process.stderr.write(
          '[KitsuneMCP] WebSocket connection refused: invalid token\n',
        );
        ws.close(1008, 'auth required');
        return;
      }

      // ----- Authenticated — register browser -----
      const browserId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      connectionManager.registerBrowser(browserId, (message: string) => {
        if (ws.readyState !== ws.OPEN) {
          throw new Error('WebSocket is not open');
        }
        ws.send(message);
      }, 'native-host');
      ws.send(JSON.stringify({ type: 'auth_ok' }));

      // ----- Subsequent messages -----
      ws.on('message', (data: Buffer | string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
        } catch {
          process.stderr.write('[KitsuneMCP] Invalid JSON from browser WebSocket\n');
          return;
        }

        if (typeof parsed === 'object' && parsed !== null && 'requestId' in parsed) {
          // Response to a command we sent
          const result = parseBrowserResponse(parsed);
          if (result.ok) {
            connectionManager.handleResponse(result.response);
            return;
          }
          process.stderr.write(`[KitsuneMCP] ${result.error}\n`);
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
        process.stderr.write(`[KitsuneMCP] Browser event: ${eventType}\n`);
      });

      ws.on('close', () => {
        connectionManager.unregisterBrowser(browserId);
      });

      ws.on('error', (err) => {
        process.stderr.write(
          `[KitsuneMCP] WebSocket error (${browserId}): ${err.message}\n`,
        );
        connectionManager.unregisterBrowser(browserId);
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
        process.stderr.write(
          `[KitsuneMCP] WebSocket server error: ${err.message}\n`,
        );
      });
      process.stderr.write(
        `[KitsuneMCP] WebSocket server listening on ws://${host}:${port}\n`,
      );
      resolve(wss);
    });
  });
}
