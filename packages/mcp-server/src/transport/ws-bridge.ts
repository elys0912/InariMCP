/**
 * WebSocket server bridge for browser Extension connections.
 *
 * Uses the `ws` library (already in package.json). Listens on
 * `ws://127.0.0.1:{FOX_WS_PORT}` and authenticates Extension
 * connections via a token-in-first-frame handshake.
 *
 * Fork-source: server.py L1479-1540
 *
 * Security:
 *  - Origin validation: only `moz-extension://` origins are accepted
 *    from browser clients. Non-browser clients (e.g. Native Host) may
 *    omit Origin entirely — that is fine.
 *  - First-frame auth: the Extension must send `{ "token": "<TOKEN>" }`
 *    within 10 seconds (design.md 8.2).
 *  - Token comparison: crypto.timingSafeEqual (design.md 7.3).
 *  - Auth failure: closed with code 1008 (Policy Violation).
 */

import * as crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
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
 * @returns The WebSocketServer instance (already listening).
 */
export function startWebSocketServer(options: WsBridgeOptions): WebSocketServer {
  const { port, apiToken, connectionManager, host = '127.0.0.1' } = options;

  const wss = new WebSocketServer({ host, port });

  wss.on('listening', () => {
    process.stderr.write(
      `[KitsuneMCP] WebSocket server listening on ws://${host}:${port}\n`,
    );
  });

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
        if (ws.readyState === ws.OPEN) {
          ws.send(message);
        }
      });

      // ----- Subsequent messages -----
      ws.on('message', (data: Buffer | string) => {
        try {
          const parsed = JSON.parse(
            typeof data === 'string' ? data : data.toString('utf-8'),
          );

          if (parsed && typeof parsed === 'object' && 'requestId' in parsed) {
            // Response to a command we sent
            connectionManager.handleResponse({
              requestId: parsed.requestId as string,
              success: parsed.success as boolean ?? false,
              data: parsed.data,
              error: parsed.error as string | undefined,
            });
          } else {
            // Event from the browser (tab updates, etc.)
            const eventType =
              (parsed && typeof parsed === 'object' && parsed.type) || 'unknown';
            process.stderr.write(
              `[KitsuneMCP] Browser event: ${String(eventType)}\n`,
            );
          }
        } catch {
          process.stderr.write(
            '[KitsuneMCP] Invalid JSON from browser WebSocket\n',
          );
        }
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

  wss.on('error', (err) => {
    process.stderr.write(
      `[KitsuneMCP] WebSocket server error: ${err.message}\n`,
    );
  });

  return wss;
}
