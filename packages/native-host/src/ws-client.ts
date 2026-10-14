/**
 * WebSocket client to the MCP Server's ws-bridge — the Native Host's
 * command channel (replaces the old HTTP /browser/poll loop).
 *
 * Handshake (mirrors packages/mcp-server/src/transport/ws-bridge.ts; MACs
 * from auth.ts, keyed with ~/.inari-mcp/api_token):
 *  1. Connect to ws://{FOX_HOST}:{FOX_WS_PORT}. No Origin header is sent
 *     (non-browser client); the bridge allows that, but only together with
 *     the challenge-response below.
 *  2. Server → `{ type: 'auth_challenge', protocol, nonce: S }`.
 *  3. Host → `{ type: 'auth', protocol, nonce: C, mac: MAC('ws-client', S, C) }`.
 *     The token itself is never sent: a program squatting on the port
 *     learns nothing it could use.
 *  4. Server → `{ type: 'auth_ok', mac: MAC('ws-server', S, C) }`. Commands
 *     are accepted only after this MAC checks out, so a fake daemon cannot
 *     drive the browser. A bad MAC or a 1008 close drops the cached token;
 *     it is re-read from disk before the next attempt (the file may have
 *     been regenerated). The whole handshake has 10 s (the server itself
 *     allows 5 s for our auth frame). A server that never sends a challenge is an older daemon:
 *     there is no fallback to sending the token.
 *
 * After the handshake:
 *  - server → host: BrowserCommand JSON, handed to `onCommand` unmodified
 *  - host → server: BrowserResponse JSON via send()
 *  - the server pings every 30 s; after SERVER_SILENCE_MS without a ping or
 *    a frame the connection is considered half-open and is dropped.
 *
 * Reconnect: exponential backoff, BACKOFF_BASE_MS × 2^n capped at
 * BACKOFF_MAX_MS, reset after a successful auth. The server process itself
 * is supervised by HealthMonitor, which calls reconnectNow() after a restart.
 */

import WebSocket from 'ws';
import { ENV_DEFAULTS, MS_PER_SECOND, isRecord } from '@inari-mcp/shared';
import type { ServerLauncher } from './server-launcher.js';
import { log } from './logger.js';
import { AUTH_PROTOCOL, MAC_LABEL, computeMac, frameText, isNonce, macMatches, newNonce } from '@inari-mcp/shared/node';

const AUTH_TIMEOUT_MS = 10_000;
/** 2.5 × the ws-bridge heartbeat interval (30 s). */
const SERVER_SILENCE_MS = 75_000;
const POLICY_VIOLATION = 1008;

/** A server frame with a string `action` and `requestId`; other fields as sent. */
export type ServerCommand = Record<string, unknown> & { action: string; requestId: string };

export type CommandHandler = (command: ServerCommand) => void;

function isServerCommand(frame: Record<string, unknown>): frame is ServerCommand {
  return typeof frame['action'] === 'string' && typeof frame['requestId'] === 'string';
}

/** What ServerConnection needs from ServerLauncher. */
export type ConnectionTarget = Pick<ServerLauncher, 'host' | 'wsPort' | 'getApiToken' | 'reloadApiToken'>;

export interface ServerConnectionOptions {
  /** Tests shorten these. */
  authTimeoutMs?: number;
  serverSilenceMs?: number;
}

type HandshakeState =
  | { step: 'await-challenge' }
  | { step: 'await-ok'; serverNonce: string; clientNonce: string }
  | { step: 'done' };

export class ServerConnection {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly launcher: ConnectionTarget;
  private readonly onCommand: CommandHandler;
  private readonly authTimeoutMs: number;
  private readonly serverSilenceMs: number;

  constructor(launcher: ConnectionTarget, onCommand: CommandHandler, options: ServerConnectionOptions = {}) {
    this.launcher = launcher;
    this.onCommand = onCommand;
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.serverSilenceMs = options.serverSilenceMs ?? SERVER_SILENCE_MS;
  }

  /** True once the server has proven it holds the token (auth_ok MAC checked). */
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
      log('API token not available yet (~/.inari-mcp/api_token) — will retry');
      this.scheduleReconnect();
      return;
    }

    log(`connecting to MCP server WebSocket ${this.url}`);
    // handshakeTimeout: a program that accepts TCP but never completes the
    // HTTP upgrade would otherwise hold us before 'open' (no auth timer yet).
    const ws = new WebSocket(this.url, { handshakeTimeout: this.authTimeoutMs });
    this.ws = ws;
    this.authenticated = false;
    let handshake: HandshakeState = { step: 'await-challenge' };

    /** Give up on this connection; the cached token is re-read next time. */
    const reject = (why: string): void => {
      log(why);
      this.launcher.reloadApiToken();
      ws.terminate();
    };

    ws.on('open', () => {
      this.authTimer = setTimeout(() => {
        log(
          handshake.step === 'await-challenge'
            ? 'WS auth timed out: the server sent no auth_challenge — it is probably an older ' +
              'Inari MCP daemon (stop it; a matching one is started automatically)'
            : 'WS auth timed out (no auth_ok)',
        );
        ws.terminate();
      }, this.authTimeoutMs);
    });

    ws.on('ping', () => this.armSilenceTimer(ws));

    ws.on('message', (raw: WebSocket.RawData) => {
      if (this.authenticated) this.armSilenceTimer(ws);

      let parsed: unknown;
      try {
        parsed = JSON.parse(frameText(raw));
      } catch {
        log('invalid JSON from MCP server — ignored');
        return;
      }
      if (!isRecord(parsed)) {
        log('non-object frame from MCP server — ignored');
        return;
      }
      const frame = parsed;

      if (handshake.step === 'await-challenge') {
        const serverNonce = frame['nonce'];
        if (
          frame['type'] !== 'auth_challenge' ||
          frame['protocol'] !== AUTH_PROTOCOL ||
          !isNonce(serverNonce)
        ) {
          reject('WS server did not start with a valid auth_challenge — closing');
          return;
        }
        const clientNonce = newNonce();
        handshake = { step: 'await-ok', serverNonce, clientNonce };
        ws.send(JSON.stringify({
          type: 'auth',
          protocol: AUTH_PROTOCOL,
          nonce: clientNonce,
          mac: computeMac(token, MAC_LABEL.wsClient, serverNonce, clientNonce),
        }));
        return;
      }

      if (handshake.step === 'await-ok') {
        const expected = computeMac(token, MAC_LABEL.wsServer, handshake.serverNonce, handshake.clientNonce);
        if (frame['type'] !== 'auth_ok' || !macMatches(frame['mac'], expected)) {
          reject(
            'WS server failed to prove it holds the API token — refusing it (the token file ' +
            'changed, or another program is listening on the daemon port)',
          );
          return;
        }
        handshake = { step: 'done' };
        this.authenticated = true;
        this.attempts = 0;
        if (this.authTimer !== null) {
          clearTimeout(this.authTimer);
          this.authTimer = null;
        }
        this.armSilenceTimer(ws);
        log('WS authenticated (mutual) — Extension command channel is up');
        return;
      }

      if (isServerCommand(frame)) {
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
      if (this.silenceTimer !== null) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
      if (this.ws === ws) this.ws = null;

      const why = reason.toString() || 'no reason';
      log(`WS closed (code ${code}: ${why})${wasAuthenticated ? '' : ' before auth'}`);

      if (code === POLICY_VIOLATION) {
        // Our MAC was rejected (or auth timeout): re-read the token file next time.
        this.launcher.reloadApiToken();
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      // 'close' follows 'error'; reconnect is scheduled there.
      log(`WS error: ${err.message}`);
    });
  }

  /** (Re)start the half-open detector: the server pings every 30 s. */
  private armSilenceTimer(ws: WebSocket): void {
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.ws !== ws) return;
      log(`WS silent for ${this.serverSilenceMs / MS_PER_SECOND}s (no ping) — assuming a dead connection`);
      ws.terminate();
    }, this.serverSilenceMs);
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
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
