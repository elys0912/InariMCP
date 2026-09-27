/**
 * WebSocket client to the MCP Server's ws-bridge — the Native Host's
 * command channel (replaces the old HTTP /browser/poll loop).
 *
 * Handshake (mirrors packages/mcp-server/src/transport/ws-bridge.ts):
 *  1. Connect to ws://{FOX_HOST}:{FOX_WS_PORT}. No Origin header is sent
 *     (non-browser client); the bridge allows that, but only together with
 *     step 2 — the token is mandatory for every client.
 *  2. First frame: `{ "token": "<~/.kitsune-mcp/api_token>" }`.
 *  3. Wait for `{ "type": "auth_ok" }` (10 s, same as the server's auth
 *     timeout). A 1008 close means the token was rejected: the cached token
 *     is dropped and re-read from disk before the next attempt.
 *
 * After the handshake:
 *  - server → host: BrowserCommand JSON, handed to `onCommand` unmodified
 *  - host → server: BrowserResponse JSON via send()
 *
 * Reconnect: exponential backoff, BACKOFF_BASE_MS × 2^n capped at
 * BACKOFF_MAX_MS, reset after a successful auth. The server process itself
 * is supervised by HealthMonitor, which calls reconnectNow() after a restart.
 */

import WebSocket from 'ws';
import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import type { ServerLauncher } from './server-launcher.js';
import { log } from './logger.js';

const AUTH_TIMEOUT_MS = 10_000;
const POLICY_VIOLATION = 1008;

export type CommandHandler = (command: Record<string, unknown>) => void;

export class ServerConnection {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly launcher: ServerLauncher;
  private readonly onCommand: CommandHandler;

  constructor(launcher: ServerLauncher, onCommand: CommandHandler) {
    this.launcher = launcher;
    this.onCommand = onCommand;
  }

  /** True once the server has acknowledged our token. */
  get isConnected(): boolean {
    return this.authenticated && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get url(): string {
    return `ws://${this.launcher.host}:${this.launcher.wsPort}`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => { /* ignore late errors after stop */ });
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
  }

  /** Skip the pending backoff delay and reconnect now (e.g. after a server restart). */
  reconnectNow(): void {
    if (this.stopped || this.isConnected) return;
    this.attempts = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws === null) this.connect();
  }

  /**
   * Send one JSON message to the server.
   * Returns false when not connected / authenticated (the message is dropped;
   * the server fails the matching request on disconnect or timeout).
   */
  send(message: Record<string, unknown>): boolean {
    if (!this.isConnected || this.ws === null) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err: unknown) {
      log(`WS send failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;

    const token = this.launcher.getApiToken();
    if (token === undefined) {
      log('API token not available yet (~/.kitsune-mcp/api_token) — will retry');
      this.scheduleReconnect();
      return;
    }

    log(`connecting to MCP server WebSocket ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.authenticated = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ token }));
      this.authTimer = setTimeout(() => {
        log('WS auth timed out (no auth_ok)');
        ws.terminate();
      }, AUTH_TIMEOUT_MS);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        log('invalid JSON from MCP server — ignored');
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        log('non-object frame from MCP server — ignored');
        return;
      }
      const frame = parsed as Record<string, unknown>;

      if (!this.authenticated) {
        if (frame['type'] === 'auth_ok') {
          this.authenticated = true;
          this.attempts = 0;
          if (this.authTimer !== null) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
          }
          log('WS authenticated — Extension command channel is up');
        } else {
          log('frame received before auth_ok — ignored');
        }
        return;
      }

      if (typeof frame['action'] === 'string' && typeof frame['requestId'] === 'string') {
        this.onCommand(frame);
      } else {
        log('unrecognised frame from MCP server — ignored');
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const wasAuthenticated = this.authenticated;
      this.authenticated = false;
      if (this.authTimer !== null) {
        clearTimeout(this.authTimer);
        this.authTimer = null;
      }
      if (this.ws === ws) this.ws = null;

      const why = reason.toString() || 'no reason';
      log(`WS closed (code ${code}: ${why})${wasAuthenticated ? '' : ' before auth'}`);

      if (code === POLICY_VIOLATION) {
        // Token rejected (or auth timeout): re-read the token file next time.
        this.launcher.reloadApiToken();
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      // 'close' follows 'error'; reconnect is scheduled there.
      log(`WS error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = Math.min(
      ENV_DEFAULTS.BACKOFF_BASE_MS * Math.pow(2, this.attempts),
      ENV_DEFAULTS.BACKOFF_MAX_MS,
    );
    this.attempts++;
    log(`WS reconnect in ${delay}ms (attempt #${this.attempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }
}
