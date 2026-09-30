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
 *
 * /health is judged strictly (evaluateHealth): valid JSON from service
 * 'kitsune-mcp', the same protocol version, and — once we have the token —
 * a proof over our nonce, so a program squatting on the port is reported
 * instead of being trusted. The token never travels (auth.ts).
 */

import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';
import { log, rotateIfLarge } from './logger.js';
import { daemonEnvFrom, defaultDeps, startOutsideJob, sweepRunDir } from './outside-job.js';
import {
  AUTH_HEADER,
  DAEMON_PROTOCOL_VERSION,
  MAC_LABEL,
  computeMac,
  macMatches,
  newNonce,
  signRequest,
  verifyResponse,
} from './auth.js';

function resolveHost(): string {
  return (
    process.env[ENV.FOX_HOST] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HOST] ??
    ENV_DEFAULTS.FOX_HOST
  );
}

/**
 * A TCP port from the environment: an integer in 1..65535, else the default
 * (with a log line). Same rule as the daemon's utils/endpoint.ts, so both
 * sides end up on the same port.
 */
export function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  log(`ignoring ${name}='${raw}' (not a port number 1-65535) — using ${fallback}`);
  return fallback;
}

function resolvePort(): number {
  const name = process.env[ENV.FOX_HTTP_PORT] !== undefined ? ENV.FOX_HTTP_PORT : LEGACY_ENV.CLAUDE_BROWSER_HTTP_PORT;
  return parsePort(process.env[name], ENV_DEFAULTS.FOX_HTTP_PORT, name);
}

function resolveWsPort(): number {
  const name = process.env[ENV.FOX_WS_PORT] !== undefined ? ENV.FOX_WS_PORT : LEGACY_ENV.CLAUDE_BROWSER_WS_PORT;
  return parsePort(process.env[name], ENV_DEFAULTS.FOX_WS_PORT, name);
}

// ---------------------------------------------------------------------------
// /health evaluation
// ---------------------------------------------------------------------------

/**
 * What answered GET /health:
 *  down         nothing (connection refused, timeout)
 *  foreign      something that is not a KitsuneMCP daemon
 *  incompatible a KitsuneMCP daemon of another protocol (an older build)
 *  impostor     claims to be the daemon but cannot prove it holds the token
 *  unverified   a compatible daemon; no token yet to check its proof
 *  ok           a compatible daemon that proved it holds our token
 */
export type HealthVerdict =
  | { kind: 'down' }
  | { kind: 'foreign' }
  | { kind: 'incompatible'; protocol: unknown; version?: string }
  | { kind: 'impostor' }
  | { kind: 'unverified'; version?: string }
  | { kind: 'ok'; version?: string };

/** Classify a /health answer: strict JSON, protocol, and the nonce proof when we have a token. */
export function evaluateHealth(
  statusCode: number | undefined,
  body: string,
  token: string | undefined,
  nonce: string,
): HealthVerdict {
  if (statusCode !== 200) return { kind: 'foreign' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'foreign' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'foreign' };
  const health = parsed as Record<string, unknown>;
  if (health['status'] !== 'ok' || health['service'] !== 'kitsune-mcp') return { kind: 'foreign' };

  const version = typeof health['version'] === 'string' ? health['version'] : undefined;
  const withVersion = version === undefined ? {} : { version };
  if (health['protocol'] !== DAEMON_PROTOCOL_VERSION) {
    return { kind: 'incompatible', protocol: health['protocol'], ...withVersion };
  }
  if (token === undefined) return { kind: 'unverified', ...withVersion };
  if (!macMatches(health['proof'], computeMac(token, MAC_LABEL.health, nonce))) return { kind: 'impostor' };
  return { kind: 'ok', ...withVersion };
}

/** A daemon we can use: compatible, and not caught failing its proof. */
export function isUsable(verdict: HealthVerdict): boolean {
  return verdict.kind === 'ok' || verdict.kind === 'unverified';
}

/** Version of the mcp-server package next to us, i.e. of a daemon we would start. */
function installedDaemonVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'mcp-server', 'package.json'), 'utf-8'),
    ) as Record<string, unknown>;
    return typeof pkg['version'] === 'string' ? pkg['version'] : undefined;
  } catch {
    return undefined;
  }
}

/** Same file the relays use for a detached daemon's stderr. */
export function daemonLogPath(): string {
  return path.join(os.homedir(), '.kitsune-mcp', 'logs', 'daemon.log');
}

/** Policy settings the daemon reads from its environment (mcp-server/src/safety/config.ts). */
const DAEMON_POLICY_VARS = [ENV.FOX_READ_ONLY, ENV.FOX_ALLOW_SCRIPTS, ENV.FOX_SAFETY_CONFIG] as const;

/**
 * Environment for a daemon started by the Native Host. It is Firefox's own
 * environment, not the one of any Claude Code session, so a FOX_READ_ONLY /
 * FOX_ALLOW_SCRIPTS set in `claude mcp add --env` is not seen by it (the relay
 * warns about such a mismatch, see relay/daemon-client.ts). The policy
 * settings actually inherited are therefore logged, by name only.
 */
export function daemonEnvNote(env: NodeJS.ProcessEnv = process.env): string {
  const set = DAEMON_POLICY_VARS.filter((name) => env[name] !== undefined && env[name] !== '');
  return set.length === 0
    ? 'daemon inherits no FOX_READ_ONLY / FOX_ALLOW_SCRIPTS / FOX_SAFETY_CONFIG from the Native Host environment'
    : `daemon inherits ${set.join(', ')} from the Native Host environment ` +
      '(settings of a Claude Code session are not applied to a daemon started here)';
}

/** Working directory of a daemon we start: stable, never Firefox's (may be locked or removable). */
function daemonCwd(): string {
  return path.dirname(path.dirname(daemonLogPath()));
}

/** How long start() waits for a daemon it spawned to answer /health. */
const STARTUP_WAIT_MS = 15_000;

/** The daemon / MCP server entry point, relative to this package. */
export function serverEntryPath(): string {
  return path.resolve(__dirname, '..', '..', 'mcp-server', 'dist', 'index.js');
}

/** The subset of GET /daemon/info the Native Host reports to the Extension. */
export interface DaemonInfo {
  version?: string;
  /** Claude Code sessions (relays) seen within the relay TTL. */
  relays: number;
}

export class ServerLauncher {
  readonly httpPort: number;
  /** Daemon ws-bridge port — the Native Host's command channel. */
  readonly wsPort: number;
  readonly host: string;
  private cachedApiToken: string | undefined;

  private restartAttempts = 0;
  private lastStableTime = Date.now();
  /** Last problem that was logged, so repeated checks do not flood the log. */
  private lastReported: string | undefined;
  private readonly expectedVersion = installedDaemonVersion();

  private readonly readTokenFile: () => string | undefined;

  /** The options exist for tests; the Native Host uses the environment. */
  constructor(options: {
    host?: string;
    httpPort?: number;
    wsPort?: number;
    readToken?: () => string | undefined;
  } = {}) {
    this.host = options.host ?? resolveHost();
    this.httpPort = options.httpPort ?? resolvePort();
    this.wsPort = options.wsPort ?? resolveWsPort();
    this.readTokenFile = options.readToken ?? (() => this.loadApiToken());
    this.cachedApiToken = this.readTokenFile();
  }

  /**
   * The API token, re-read from disk whenever we don't yet have one cached.
   * This covers the case where the token file didn't exist yet when the
   * launcher was constructed (the daemon creates it on first boot).
   * Once a token is found, it's cached and not re-read on every call.
   */
  private get apiToken(): string | undefined {
    if (this.cachedApiToken === undefined) {
      this.cachedApiToken = this.readTokenFile();
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

    const serverEntry = serverEntryPath();

    if (!fs.existsSync(serverEntry)) {
      log(`MCP server entry not found: ${serverEntry}`);
      return false;
    }

    try {
      fs.mkdirSync(path.dirname(daemonLogPath()), { recursive: true, mode: 0o700 });
    } catch {
      // Logging is best-effort
    }
    // A daemon that cannot bind its WS port exits at once; say why instead.
    if (await this.isPortInUse(this.wsPort)) {
      // Counts as an attempt, so the health monitor's limit and backoff apply.
      this.restartAttempts++;
      log(`WS port ${this.host}:${this.wsPort} is in use by another process — not starting the daemon`);
      return false;
    }

    // Both start paths below open daemon.log for appending. A daemon from an
    // earlier start may still hold it open, hence copy-truncate.
    rotateIfLarge(daemonLogPath(), true);
    try {
      fs.appendFileSync(
        daemonLogPath(),
        `${new Date().toISOString()} --- daemon start requested by Native Host (PID ${process.pid}) ---\n`,
        { mode: 0o600 },
      );
    } catch {
      // Logging is best-effort
    }
    log(daemonEnvNote());

    // Windows: outside Firefox's job object, or closing Firefox kills the
    // daemon (see breakaway.ts). Falls back to a plain spawn on failure.
    if (process.platform === 'win32') {
      sweepRunDir(path.join(daemonCwd(), 'run'));
      const result = await startOutsideJob(
        {
          exe: process.execPath,
          args: [serverEntry, '--daemon'],
          env: daemonEnvFrom(process.env),
          log: daemonLogPath(),
          cwd: daemonCwd(),
        },
        defaultDeps(path.join(daemonCwd(), 'run')),
      );
      if (!('errors' in result)) {
        this.restartAttempts++;
        this.lastStableTime = Date.now();
        log(`started daemon outside the job object via ${result.via} (attempt #${this.restartAttempts})`);
        return this.waitUntilHealthy();
      }
      log(
        `WARNING: could not start the daemon outside Firefox's job object (${result.errors.join('; ')}); ` +
        'starting it inside the job: it will stop when Firefox closes, together with the Claude Code sessions using it',
      );
    }

    let logFd: number | 'ignore' = 'ignore';
    try {
      logFd = fs.openSync(daemonLogPath(), 'a', 0o600);
    } catch {
      // Logging is best-effort
    }

    try {
      const child = spawn(process.execPath, [serverEntry, '--daemon'], {
        stdio: ['ignore', 'ignore', logFd],
        detached: true,
        windowsHide: true,
        cwd: daemonCwd(),
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

    return this.waitUntilHealthy();
  }

  /** Wait up to STARTUP_WAIT_MS for a daemon we just started to answer /health. */
  private async waitUntilHealthy(): Promise<boolean> {
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
      await this.sleep(200);
      if (await this.checkHealth()) {
        log('daemon is now available');
        this.restartAttempts = 0;
        // The WS bridge may bind a moment after the HTTP server.
        let wsUp = false;
        for (let i = 0; i < 5 && !wsUp; i++) {
          if (i > 0) await this.sleep(500);
          wsUp = await this.isPortInUse(this.wsPort);
        }
        if (!wsUp) {
          log(`daemon answers /health but nothing listens on WS port ${this.wsPort} — check FOX_WS_PORT`);
        }
        return true;
      }
    }

    log(`daemon started but not responding within ${STARTUP_WAIT_MS} ms (see ${daemonLogPath()})`);
    return false;
  }

  /**
   * Connect-or-start at Native Host startup:
   *   healthy daemon   → nothing to do
   *   port in use      → a daemon (or something else) is there but slow:
   *                      leave it alone, the health monitor keeps watching
   *   port free        → start a daemon
   */
  async ensureRunning(): Promise<void> {
    const verdict = await this.probeHealth();
    if (isUsable(verdict)) {
      log('daemon already running and responding');
      return;
    }
    if (verdict.kind !== 'down') {
      // Something holds the port (probeHealth logged what): a daemon we
      // start could not bind it anyway.
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
    if (!(await this.start())) log('daemon is not available yet; the health monitor keeps watching');
  }

  /** True when something accepts TCP connections on the port (default: the HTTP port). */
  isPortInUse(port: number = this.httpPort): Promise<boolean> {
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

      sock.connect(port, this.host);
    });
  }

  /** True when a daemon we can use answers /health (see probeHealth()). */
  async checkHealth(): Promise<boolean> {
    return isUsable(await this.probeHealth());
  }

  /**
   * GET /health with a fresh nonce and classify the answer. A failed proof
   * is retried once with the token re-read from disk (it may have been
   * regenerated). Problems are logged when they change.
   */
  async probeHealth(): Promise<HealthVerdict> {
    let verdict = await this.requestHealth();
    if (verdict.kind === 'impostor') {
      this.reloadApiToken();
      verdict = await this.requestHealth();
    }
    this.report(verdict);
    return verdict;
  }

  private report(verdict: HealthVerdict): void {
    let line: string | undefined;
    switch (verdict.kind) {
      case 'incompatible':
        line =
          `the daemon on ${this.host}:${this.httpPort} speaks protocol ${String(verdict.protocol ?? '1')} ` +
          `(version ${verdict.version ?? 'unknown'}); this Native Host needs ${DAEMON_PROTOCOL_VERSION}. ` +
          'Stop that daemon process — a matching one is started automatically.';
        break;
      case 'impostor':
        line =
          `the program on ${this.host}:${this.httpPort} claims to be the KitsuneMCP daemon but cannot ` +
          'prove it holds the API token — not connecting to it. Check which process owns the port.';
        break;
      case 'foreign':
        line = `port ${this.host}:${this.httpPort} answers, but not as a KitsuneMCP daemon`;
        break;
      case 'ok':
      case 'unverified':
        if (
          this.expectedVersion !== undefined &&
          verdict.version !== undefined &&
          verdict.version !== this.expectedVersion
        ) {
          line =
            `the running daemon is version ${verdict.version}, the installed one ${this.expectedVersion} ` +
            '(it keeps running until it is idle; restart it to use the installed one)';
        }
        break;
      case 'down':
        break;
    }
    if (line !== undefined && line !== this.lastReported) log(line);
    this.lastReported = line;
  }

  private requestHealth(): Promise<HealthVerdict> {
    const token = this.apiToken;
    const nonce = newNonce();
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.httpPort,
          path: '/health',
          method: 'GET',
          timeout: 3_000,
          headers: { [AUTH_HEADER.nonce]: nonce },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve(evaluateHealth(res.statusCode, body, token, nonce)));
          res.on('error', () => resolve({ kind: 'down' }));
        },
      );

      req.on('error', () => resolve({ kind: 'down' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ kind: 'down' });
      });

      req.end();
    });
  }

  /**
   * GET /daemon/info (signed request, see auth.ts). Null when the daemon is
   * unreachable, the token is missing / rejected, the answer is not signed
   * by the daemon, or the reply is not what we expect.
   */
  fetchDaemonInfo(): Promise<DaemonInfo | null> {
    const token = this.apiToken;
    if (token === undefined) return Promise.resolve(null);
    const signed = signRequest(token, 'GET', '/daemon/info');

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.httpPort,
          path: '/daemon/info',
          method: 'GET',
          timeout: 3_000,
          headers: signed.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('error', () => resolve(null));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            if (res.statusCode === 403) {
              // Token regenerated since we cached it: re-read next time.
              this.reloadApiToken();
            }
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            if (!verifyResponse(token, signed.nonce, 200, raw, res.headers[AUTH_HEADER.signature])) {
              log('GET /daemon/info: answer not signed by the daemon — ignored');
              resolve(null);
              return;
            }
            try {
              const parsed = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
              const relays = parsed['relays'];
              if (typeof relays !== 'number') {
                resolve(null);
                return;
              }
              const version = parsed['version'];
              resolve({ relays, ...(typeof version === 'string' ? { version } : {}) });
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
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
