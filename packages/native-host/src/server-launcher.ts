/**
 * Locating and starting the shared KitsuneMCP daemon.
 *
 * The daemon (`node packages/mcp-server/dist/index.js --daemon`) owns the
 * HTTP / WebSocket ports and serves every Claude Code session (through their
 * stdio relays) as well as this Native Host. The rule is the same for the
 * relays and for us: if a daemon answers /health, just connect; if nothing
 * listens on the port, start one detached. When several of us start one at
 * the same time, the daemon that cannot bind the port exits by itself.
 *
 * A daemon that is alive but slow to answer is never killed: other sessions
 * depend on it. (The fork source killed whatever held the port.)
 */

import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:NativeHost] ${msg}\n`);
}

function resolveHost(): string {
  return (
    process.env[ENV.FOX_HOST] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HOST] ??
    ENV_DEFAULTS.FOX_HOST
  );
}

function resolvePort(): number {
  const raw =
    process.env[ENV.FOX_HTTP_PORT] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HTTP_PORT];
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return ENV_DEFAULTS.FOX_HTTP_PORT;
}

function resolveWsPort(): number {
  const raw =
    process.env[ENV.FOX_WS_PORT] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_WS_PORT];
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return ENV_DEFAULTS.FOX_WS_PORT;
}

/** Same file the relays use for a detached daemon's stderr. */
function daemonLogPath(): string {
  return path.join(os.homedir(), '.kitsune-mcp', 'logs', 'daemon.log');
}

/** How long start() waits for a daemon it spawned to answer /health. */
const STARTUP_WAIT_MS = 15_000;

export class ServerLauncher {
  readonly httpPort: number;
  /** Daemon ws-bridge port — the Native Host's command channel. */
  readonly wsPort: number;
  readonly host: string;
  private cachedApiToken: string | undefined;

  private restartAttempts = 0;
  private lastStableTime = Date.now();

  constructor() {
    this.host = resolveHost();
    this.httpPort = resolvePort();
    this.wsPort = resolveWsPort();
    this.cachedApiToken = this.loadApiToken();
  }

  /**
   * The API token, re-read from disk whenever we don't yet have one cached.
   * This covers the case where the token file didn't exist yet when the
   * launcher was constructed (the daemon creates it on first boot).
   * Once a token is found, it's cached and not re-read on every call.
   */
  private get apiToken(): string | undefined {
    if (this.cachedApiToken === undefined) {
      this.cachedApiToken = this.loadApiToken();
    }
    return this.cachedApiToken;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Spawn a daemon (detached, stdio cut off, stderr appended to
   * ~/.kitsune-mcp/logs/daemon.log) and wait for it to answer /health.
   * Callers must only do this when nothing listens on the port.
   */
  async start(): Promise<boolean> {
    if (this.restartAttempts >= ENV_DEFAULTS.MAX_RESTART_ATTEMPTS) {
      log(`max start attempts (${ENV_DEFAULTS.MAX_RESTART_ATTEMPTS}) reached`);
      return false;
    }

    // Resolve the daemon entry point relative to this package
    const serverEntry = path.resolve(
      __dirname,
      '..', '..', 'mcp-server', 'dist', 'index.js',
    );

    if (!fs.existsSync(serverEntry)) {
      log(`MCP server entry not found: ${serverEntry}`);
      return false;
    }

    let logFd: number | 'ignore' = 'ignore';
    try {
      fs.mkdirSync(path.dirname(daemonLogPath()), { recursive: true, mode: 0o700 });
      logFd = fs.openSync(daemonLogPath(), 'a', 0o600);
    } catch {
      // Logging is best-effort
    }

    try {
      const child = spawn(process.execPath, [serverEntry, '--daemon'], {
        stdio: ['ignore', 'ignore', logFd],
        detached: true,
        windowsHide: true,
      });
      child.on('error', (err) => log(`daemon spawn error: ${err.message}`));
      // Don't keep the Native Host alive for the daemon, nor the other way round.
      child.unref();

      this.restartAttempts++;
      this.lastStableTime = Date.now();
      log(`started daemon (PID: ${child.pid ?? 'unknown'}, attempt #${this.restartAttempts})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to start daemon: ${msg}`);
      return false;
    } finally {
      if (typeof logFd === 'number') {
        try { fs.closeSync(logFd); } catch { /* ignore */ }
      }
    }

    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
      await this.sleep(200);
      if (await this.checkHealth()) {
        log('daemon is now available');
        this.restartAttempts = 0;
        return true;
      }
    }

    log(`daemon started but not yet responding (see ${daemonLogPath()})`);
    return true;
  }

  /**
   * Connect-or-start at Native Host startup:
   *   healthy daemon   → nothing to do
   *   port in use      → a daemon (or something else) is there but slow:
   *                      leave it alone, the health monitor keeps watching
   *   port free        → start a daemon
   */
  async ensureRunning(): Promise<void> {
    if (await this.checkHealth()) {
      log('daemon already running and responding');
      return;
    }

    if (await this.isPortInUse()) {
      log(
        `port ${this.host}:${this.httpPort} is in use but /health did not answer — ` +
        'not starting another daemon (the running one is left alone)',
      );
      return;
    }

    log('daemon not running, starting it');
    await this.start();
  }

  /** True when something accepts TCP connections on the HTTP port. */
  isPortInUse(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1_000);

      sock.on('connect', () => {
        sock.destroy();
        resolve(true);
      });

      sock.on('timeout', () => {
        // Connect neither accepted nor refused: something is there.
        sock.destroy();
        resolve(true);
      });

      sock.on('error', () => {
        sock.destroy();
        resolve(false);
      });

      sock.connect(this.httpPort, this.host);
    });
  }

  checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.httpPort,
          path: '/health',
          method: 'GET',
          timeout: 3_000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            resolve(res.statusCode === 200 && body.toLowerCase().includes('ok'));
          });
        },
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  resetBackoff(): void {
    const now = Date.now();
    if (
      this.restartAttempts > 0 &&
      now - this.lastStableTime > ENV_DEFAULTS.STABLE_THRESHOLD_MS
    ) {
      log('resetting start counter after stability period');
      this.restartAttempts = 0;
    }
  }

  getBackoffDelay(): number {
    return Math.min(
      ENV_DEFAULTS.BACKOFF_BASE_MS * Math.pow(2, Math.max(0, this.restartAttempts - 1)),
      ENV_DEFAULTS.BACKOFF_MAX_MS,
    );
  }

  getApiToken(): string | undefined {
    return this.apiToken;
  }

  /**
   * Drop the cached token so the next getApiToken() re-reads the file.
   * Called when the server rejects our token (WS close 1008), e.g. after
   * ~/.kitsune-mcp/api_token was regenerated.
   */
  reloadApiToken(): void {
    this.cachedApiToken = undefined;
  }

  getRestartAttempts(): number {
    return this.restartAttempts;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private loadApiToken(): string | undefined {
    const tokenPath = path.join(os.homedir(), '.kitsune-mcp', 'api_token');
    try {
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (token.length > 0) return token;
      }
    } catch {
      // Token file missing or unreadable
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
