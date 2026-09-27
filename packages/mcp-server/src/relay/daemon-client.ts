/**
 * The relay's side of the relay ⇔ daemon link.
 *
 *  - ensureDaemon(): GET /health; when nothing answers, spawn
 *    `node dist/index.js --daemon` detached (stdio cut off from the relay,
 *    stderr appended to ~/.kitsune-mcp/logs/daemon.log) and wait until it is
 *    healthy. Several relays (and the Native Host) may do this at the same
 *    time: the daemon that cannot bind the HTTP port exits by itself.
 *  - callTool(): POST /mcp/call with X-API-Key (read from
 *    ~/.kitsune-mcp/api_token *after* the daemon is healthy — only the daemon
 *    creates the token) and X-Kitsune-Relay (audit transport `relay:<id>`).
 *    The daemon's CallToolResult is returned unchanged.
 *  - heartbeat: GET /health with X-Kitsune-Relay every 30 s, so the daemon
 *    knows this session is alive (idle shutdown, daemon/activity.ts).
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { maxCommandTimeoutMs } from '../connection/manager.js';
import { RELAY_HEARTBEAT_MS } from '../daemon/activity.js';
import {
  DAEMON_SETTING_KEYS,
  RELAY_ID_HEADER,
  readApiTokenFile,
  resolveHost,
  resolveHttpPort,
  snapshotDaemonSettings,
} from '../utils/endpoint.js';

/** How long a relay waits for a daemon it started to answer /health. */
const DAEMON_STARTUP_WAIT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 2_000;
/**
 * Added on top of the daemon's longest command timeout: covers the daemon's
 * own wait for the headless backend to boot (FOX_HEADLESS_STARTUP_TIMEOUT,
 * default 45 s) plus transport slack.
 */
const RELAY_TIMEOUT_MARGIN_MS = 60_000;

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:relay] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

interface HttpReply {
  status: number;
  body: unknown;
}

class ConnectionRefusedError extends Error {}

export class DaemonClient {
  readonly relayId: string;
  private readonly host = resolveHost();
  private readonly port = resolveHttpPort();
  private ensuring: Promise<boolean> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(relayId: string) {
    this.relayId = relayId;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  // -------------------------------------------------------------------------
  // Daemon lifecycle
  // -------------------------------------------------------------------------

  /**
   * Make sure a daemon answers /health, starting one if needed.
   * Concurrent callers share one attempt. Resolves false on failure.
   */
  ensureDaemon(): Promise<boolean> {
    if (this.ensuring === null) {
      this.ensuring = this.doEnsure().finally(() => { this.ensuring = null; });
    }
    return this.ensuring;
  }

  private async doEnsure(): Promise<boolean> {
    if (await this.checkHealth()) return true;

    if (!this.spawnDaemon()) return false;

    const deadline = Date.now() + DAEMON_STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(HEALTH_POLL_INTERVAL_MS);
      if (await this.checkHealth()) {
        log(`daemon is up at ${this.baseUrl}`);
        return true;
      }
    }
    log(
      `daemon did not answer ${this.baseUrl}/health within ${DAEMON_STARTUP_WAIT_MS / 1000}s ` +
      `(see ${daemonLogPath()})`,
    );
    return false;
  }

  private spawnDaemon(): boolean {
    // dist/relay/daemon-client.js → dist/index.js
    const entry = path.resolve(__dirname, '..', 'index.js');
    if (!fs.existsSync(entry)) {
      log(`daemon entry not found: ${entry}`);
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
      // env is inherited as-is: daemon settings such as FOX_HEADLESS come
      // from the relay that starts it (DAEMON_SETTING_KEYS).
      const child = spawn(process.execPath, [entry, '--daemon'], {
        detached: true,
        stdio: ['ignore', 'ignore', logFd],
        windowsHide: true,
        env: process.env,
      });
      child.on('error', (err) => log(`daemon spawn error: ${err.message}`));
      child.unref();
      log(`started daemon (PID ${child.pid ?? 'unknown'})`);
      return true;
    } catch (err: unknown) {
      log(`failed to start daemon: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      if (typeof logFd === 'number') {
        try { fs.closeSync(logFd); } catch { /* ignore */ }
      }
    }
  }

  /** GET /health (also serves as this relay's heartbeat). */
  async checkHealth(): Promise<boolean> {
    try {
      const reply = await this.request('GET', '/health', undefined, HEALTH_TIMEOUT_MS);
      return reply.status === 200 && isRecord(reply.body) && reply.body['status'] === 'ok';
    } catch {
      return false;
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => { void this.checkHealth(); }, RELAY_HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Compare this relay's daemon settings (FOX_HEADLESS, FOX_READ_ONLY, …)
   * with those of the running daemon. The running daemon is always kept —
   * restarting it would cut off every other session and the Firefox
   * connection — so differences are only reported.
   *
   * @returns human-readable warnings (empty when the settings agree)
   */
  async settingsMismatch(): Promise<string[]> {
    const token = readApiTokenFile();
    if (token === undefined) return [];
    let reply: HttpReply;
    try {
      reply = await this.request('GET', '/daemon/info', undefined, HEALTH_TIMEOUT_MS, token);
    } catch {
      return [];
    }
    if (reply.status !== 200 || !isRecord(reply.body)) return [];
    const daemonSettings = reply.body['settings'];
    if (!isRecord(daemonSettings)) return [];
    const pid = typeof reply.body['pid'] === 'number' ? reply.body['pid'] : 'unknown';

    const mine = snapshotDaemonSettings();
    const diffs: string[] = [];
    for (const key of DAEMON_SETTING_KEYS) {
      const theirs = typeof daemonSettings[key] === 'string' ? daemonSettings[key] : '';
      if ((mine[key] ?? '') !== theirs) {
        diffs.push(`${key}: this session '${mine[key] || '(unset)'}', daemon '${theirs || '(unset)'}'`);
      }
    }
    if (diffs.length === 0) return [];
    return [
      `The shared KitsuneMCP daemon (PID ${pid}) was started with different settings ` +
      'than this session. The running daemon\'s settings apply to every session: ' +
      diffs.join('; ') +
      '. To change them, stop the daemon (it also exits on its own after being unused ' +
      'for FOX_DAEMON_IDLE_TIMEOUT seconds) and start a session with the desired settings.',
    ];
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const timeoutMs = maxCommandTimeoutMs(args) + RELAY_TIMEOUT_MARGIN_MS;
    const body = JSON.stringify({ name, arguments: args });

    let restarted = false;
    let tokenReloaded = false;
    for (;;) {
      const token = readApiTokenFile();
      if (token === undefined) {
        if (!restarted && (await this.ensureDaemon())) {
          restarted = true;
          continue;
        }
        return errorResult(
          'KitsuneMCP daemon is not available: no API token at ~/.kitsune-mcp/api_token ' +
          `(the daemon creates it on start; see ${daemonLogPath()}).`,
        );
      }

      let reply: HttpReply;
      try {
        reply = await this.request('POST', '/mcp/call', body, timeoutMs, token, signal);
      } catch (err: unknown) {
        // Connection refused: the request never reached a daemon, so starting
        // one and retrying cannot run the tool twice.
        if (err instanceof ConnectionRefusedError && !restarted) {
          restarted = true;
          log('daemon not reachable — starting it');
          if (await this.ensureDaemon()) continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`KitsuneMCP daemon request failed (${this.baseUrl}): ${msg}`);
      }

      if (reply.status === 403 && !tokenReloaded) {
        // Token file replaced since we read it: read it again once.
        tokenReloaded = true;
        continue;
      }

      return this.toCallToolResult(name, reply);
    }
  }

  private toCallToolResult(name: string, reply: HttpReply): CallToolResult {
    const body = isRecord(reply.body) ? reply.body : {};
    if (reply.status === 200) {
      const parsed = CallToolResultSchema.safeParse(body['result']);
      if (parsed.success) return parsed.data;
      return errorResult(`KitsuneMCP daemon returned a malformed result for ${name}`);
    }

    const error = typeof body['error'] === 'string' ? body['error'] : `HTTP ${reply.status}`;
    const issues = Array.isArray(body['issues'])
      ? `\n\nDetails: ${JSON.stringify(body['issues'])}`
      : '';
    const code = typeof body['code'] === 'string' ? ` [${body['code']}]` : '';
    return errorResult(`${error}${code}${issues}`);
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private request(
    method: 'GET' | 'POST',
    urlPath: string,
    body: string | undefined,
    timeoutMs: number,
    token?: string,
    signal?: AbortSignal,
  ): Promise<HttpReply> {
    return new Promise<HttpReply>((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { [RELAY_ID_HEADER]: this.relayId };
      if (token !== undefined) headers['X-API-Key'] = token;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = http.request(
        { host: this.host, port: this.port, path: urlPath, method, headers, signal },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            clearTimeout(timer);
            const text = Buffer.concat(chunks).toString('utf-8');
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              // keep raw text
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', (err) => { clearTimeout(timer); reject(err); });
        },
      );

      const timer = setTimeout(() => {
        req.destroy(new Error(`no answer from the daemon within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      req.on('error', (err) => {
        clearTimeout(timer);
        if ('code' in err && err.code === 'ECONNREFUSED') {
          reject(new ConnectionRefusedError(`connection refused by ${this.baseUrl}`));
          return;
        }
        reject(err);
      });

      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

/** Where a detached daemon's stderr goes (shared with the Native Host). */
export function daemonLogPath(): string {
  return path.join(os.homedir(), '.kitsune-mcp', 'logs', 'daemon.log');
}
