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

import * as net from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV, ENV_DEFAULTS, isRecord, MAX_PORT } from '@kitsune-mcp/shared';
import {
  AUTH_HEADER,
  DAEMON_PROTOCOL_VERSION,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  dataDir,
  daemonLogPath,
  evaluateHealth,
  isUsable,
  newNonce,
  readApiTokenFile,
  readPackageVersion,
  resolveHost,
  resolveHttpPort,
  resolveWsPort,
  signRequest,
  spawnDetachedDaemon,
  verifyResponse,
  type HealthVerdict,
  type InvalidPortHandler,
} from '@kitsune-mcp/shared/node';
import { log, rotateIfLarge } from './logger.js';
import { daemonEnvFrom, defaultDeps, startOutsideJob, sweepRunDir } from './outside-job.js';

/** A port variable is set but unusable: say so, the default applies. */
const reportInvalidPort: InvalidPortHandler = (name, raw, fallback) => {
  log(`ignoring ${name}='${raw}' (not a port number 1-${MAX_PORT}) — using ${fallback}`);
};

/** Version of the mcp-server package next to us, i.e. of a daemon we would start. */
function installedDaemonVersion(): string | undefined {
  return readPackageVersion(path.resolve(__dirname, '..', '..', 'mcp-server', 'package.json'));
}

export { daemonLogPath };

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
  // Blank counts as unset, as the daemon reads them (mcp-server resolveFoxEnv).
  const set = DAEMON_POLICY_VARS.filter((name) => (env[name]?.trim() ?? '') !== '');
  return set.length === 0
    ? 'daemon inherits no FOX_READ_ONLY / FOX_ALLOW_SCRIPTS / FOX_SAFETY_CONFIG from the Native Host environment'
    : `daemon inherits ${set.join(', ')} from the Native Host environment ` +
      '(settings of a Claude Code session are not applied to a daemon started here)';
}

/** Working directory of a daemon we start: stable, never Firefox's (may be locked or removable). */
function daemonCwd(): string {
  return dataDir();
}

/** How long start() waits for a daemon it spawned to answer /health. */
const STARTUP_WAIT_MS = 15_000;
/** Interval of the /health polls while waiting for it. */
const HEALTH_POLL_MS = 200;
/** After /health answers: checks for the WS port, WS_BIND_RETRY_MS apart (the bridge may bind later). */
const WS_BIND_CHECKS = 5;
const WS_BIND_RETRY_MS = 500;
/** TCP connect timeout of isPortInUse() (no answer = something is there). */
const PORT_PROBE_TIMEOUT_MS = 1_000;
/** Timeout of GET /health and GET /daemon/info. */
const HTTP_PROBE_TIMEOUT_MS = 3_000;

/**
 * Make sure daemon.log can be written and mark the start in it. Both start
 * paths open daemon.log for appending; a daemon from an earlier start may
 * still hold it open, hence copy-truncate. Logging is best-effort.
 */
function prepareDaemonLog(): void {
  const logPath = daemonLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch {
    // Logging is best-effort
  }
  rotateIfLarge(logPath, true);
  try {
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} --- daemon start requested by Native Host (PID ${process.pid}) ---
`,
      { mode: PRIVATE_FILE_MODE },
    );
  } catch {
    // Logging is best-effort
  }
}

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

  /**
   * Start attempts since a usable daemon last answered /health. Capped at
   * MAX_RESTART_ATTEMPTS: only a usable daemon (ours or one a relay started)
   * resets it, not the passing of time.
   */
  private restartAttempts = 0;
  /** Last problem that was logged, so repeated checks do not flood the log. */
  private lastReported: string | undefined;
  /** Same for GET /daemon/info. */
  private lastInfoProblem: string | undefined;
  private readonly serverEntry: string;
  private readonly expectedVersion = installedDaemonVersion();

  private readonly readTokenFile: () => string | undefined;

  /** The options exist for tests; the Native Host uses the environment. */
  constructor(options: {
    host?: string;
    httpPort?: number;
    wsPort?: number;
    readToken?: () => string | undefined;
    serverEntry?: string;
  } = {}) {
    this.host = options.host ?? resolveHost();
    this.httpPort = options.httpPort ?? resolveHttpPort(reportInvalidPort);
    this.wsPort = options.wsPort ?? resolveWsPort(reportInvalidPort);
    this.readTokenFile = options.readToken ?? (() => readApiTokenFile());
    this.serverEntry = options.serverEntry ?? serverEntryPath();
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

    const serverEntry = this.serverEntry;
    if (!fs.existsSync(serverEntry)) {
      // Retrying cannot help until the package is built / reinstalled.
      this.restartAttempts = ENV_DEFAULTS.MAX_RESTART_ATTEMPTS;
      log(`MCP server entry not found: ${serverEntry} — not retrying`);
      return false;
    }

    // Every way on from here counts as an attempt (a busy WS port and a spawn
    // that throws included), so the health monitor's limit and backoff apply.
    this.restartAttempts++;

    // A daemon that cannot bind its WS port exits at once; say why instead.
    if (await this.isPortInUse(this.wsPort)) {
      log(`WS port ${this.host}:${this.wsPort} is in use by another process — not starting the daemon`);
      return false;
    }

    prepareDaemonLog();
    log(daemonEnvNote());

    if (process.platform === 'win32' && (await this.startOutsideJobOrWarn(serverEntry))) {
      return this.waitUntilHealthy();
    }
    return this.spawnPlain(serverEntry) && this.waitUntilHealthy();
  }

  /**
   * Windows: start the daemon outside Firefox's job object, or closing Firefox
   * kills it (see breakaway.ts). False (with a warning) when that failed and
   * the caller falls back to a plain spawn.
   */
  private async startOutsideJobOrWarn(serverEntry: string): Promise<boolean> {
    const runDir = path.join(daemonCwd(), 'run');
    sweepRunDir(runDir);
    const result = await startOutsideJob(
      {
        exe: process.execPath,
        args: [serverEntry, '--daemon'],
        env: daemonEnvFrom(process.env),
        log: daemonLogPath(),
        cwd: daemonCwd(),
      },
      defaultDeps(runDir),
    );
    if (result.ok) {
      log(`started daemon outside the job object via ${result.via} (attempt #${this.restartAttempts})`);
      return true;
    }
    log(
      `WARNING: could not start the daemon outside Firefox's job object (${result.errors.join('; ')}); ` +
      'starting it inside the job: it will stop when Firefox closes, together with the Claude Code sessions using it',
    );
    return false;
  }

  /** Spawn the daemon as a detached child. False when the spawn throws. */
  private spawnPlain(serverEntry: string): boolean {
    try {
      const pid = spawnDetachedDaemon({
        entry: serverEntry,
        logPath: daemonLogPath(),
        cwd: daemonCwd(),
        onError: (err) => log(`daemon spawn error: ${err.message}`),
      });
      log(`started daemon (PID: ${pid ?? 'unknown'}, attempt #${this.restartAttempts})`);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to start daemon (attempt #${this.restartAttempts}): ${msg}`);
      return false;
    }
  }

  /** Wait up to STARTUP_WAIT_MS for a daemon we just started to answer /health. */
  private async waitUntilHealthy(): Promise<boolean> {
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
      await this.sleep(HEALTH_POLL_MS);
      if (await this.checkHealth()) {
        log('daemon is now available'); // checkHealth() reset the start counter
        // The WS bridge may bind a moment after the HTTP server.
        let wsUp = false;
        for (let i = 0; i < WS_BIND_CHECKS && !wsUp; i++) {
          if (i > 0) await this.sleep(WS_BIND_RETRY_MS);
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
      sock.setTimeout(PORT_PROBE_TIMEOUT_MS);

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
   * regenerated). Problems are logged when they change. A usable daemon,
   * whoever started it, resets the start counter.
   */
  async probeHealth(): Promise<HealthVerdict> {
    let verdict = await this.requestHealth();
    if (verdict.kind === 'impostor') {
      this.reloadApiToken();
      verdict = await this.requestHealth();
    }
    this.report(verdict);
    if (isUsable(verdict)) this.restartAttempts = 0;
    return verdict;
  }

  private report(verdict: HealthVerdict): void {
    let line: string | undefined;
    switch (verdict.kind) {
      case 'incompatible':
        line =
          `the daemon on ${this.host}:${this.httpPort} speaks protocol ${String(verdict.protocol ?? '1')} ` +
          `(version ${verdict.version ?? 'unknown'}); this Native Host needs ${DAEMON_PROTOCOL_VERSION}. ` +
          'Stop that daemon process (end it by PID; an older daemon has no --stop-daemon) — a matching one is started automatically.';
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
            '(it keeps running until it is idle; `node packages/mcp-server/dist/index.js --stop-daemon` stops it, the next use starts the installed one)';
        }
        break;
      case 'down':
        break;
      default: {
        const unhandled: never = verdict;
        throw new Error(`unhandled health verdict ${JSON.stringify(unhandled)}`);
      }
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
          timeout: HTTP_PROBE_TIMEOUT_MS,
          headers: { [AUTH_HEADER.nonce]: nonce },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
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
          timeout: HTTP_PROBE_TIMEOUT_MS,
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
              this.reportInfo(`GET /daemon/info: HTTP ${String(res.statusCode)} — daemon info not shown`);
              resolve(null);
              return;
            }
            if (!verifyResponse(token, signed.nonce, 200, raw, res.headers[AUTH_HEADER.signature])) {
              log('GET /daemon/info: answer not signed by the daemon — ignored');
              resolve(null);
              return;
            }
            try {
              const parsed: unknown = JSON.parse(raw.toString('utf-8'));
              const info: Record<string, unknown> = isRecord(parsed) ? parsed : {};
              const relays = info['relays'];
              if (typeof relays !== 'number') {
                this.reportInfo('GET /daemon/info: "relays" is not a number — daemon info not shown');
                resolve(null);
                return;
              }
              const version = info['version'];
              this.reportInfo(undefined);
              resolve({ relays, ...(typeof version === 'string' ? { version } : {}) });
            } catch {
              this.reportInfo('GET /daemon/info: answer is not valid JSON — daemon info not shown');
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

  /** Log a /daemon/info problem when it differs from the last one (cf. report()). */
  private reportInfo(problem: string | undefined): void {
    if (problem !== undefined && problem !== this.lastInfoProblem) log(problem);
    this.lastInfoProblem = problem;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
