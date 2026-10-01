/**
 * The relay's side of the relay ⇔ daemon link.
 *
 *  - ensureDaemon(): GET /health; when nothing answers, spawn
 *    `node dist/index.js --daemon` detached (stdio cut off from the relay,
 *    stderr appended to ~/.kitsune-mcp/logs/daemon.log) and wait until it is
 *    healthy. Several relays (and the Native Host) may do this at the same
 *    time: the daemon that cannot bind the HTTP port exits by itself.
 *  - callTool(): POST /mcp/call, signed with the API token (read from
 *    ~/.kitsune-mcp/api_token *after* the daemon is healthy — only the daemon
 *    creates the token; the token itself is never sent, see
 *    transport/auth.ts) and X-Kitsune-Relay (audit transport `relay:<id>`).
 *    The daemon signs its answer; an unsigned or wrongly signed answer
 *    means another program holds the port, and is refused. Aborting the
 *    call (MCP cancellation) closes the request, which the daemon turns
 *    into cancelling the browser command. The daemon's CallToolResult is
 *    returned unchanged.
 *  - A daemon whose /health reports another `protocol` (an older build
 *    still running) is not used: every call fails with a message telling
 *    the user to stop it. There is no fallback to sending the token.
 *  - heartbeat: GET /health with X-Kitsune-Relay every 30 s, so the daemon
 *    knows this session is alive (idle shutdown, daemon/activity.ts).
 *  - approvals (relay/approval.ts): POST /approval/elicitation and
 *    /approval/browser; a retried call sends `approvalToken` in the
 *    /mcp/call body.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { maxCommandTimeoutMs } from '../connection/manager.js';
import type { ApprovalReply } from './approval.js';
import { RELAY_HEARTBEAT_MS } from '../daemon/activity.js';
import { AUTH_HEADER, DAEMON_PROTOCOL_VERSION, signRequest, verifyResponse } from '@kitsune-mcp/shared/node';
import { daemonLogPath, kitsuneHealth, spawnDetachedDaemon, stderrLogger } from '@kitsune-mcp/shared/node';
import {
  RELAY_ID_HEADER,
  daemonSettingsFromInfo,
  diffDaemonSettings,
  effectiveDaemonSettings,
  readApiTokenFile,
  resolveHost,
  resolveHttpPort,
} from '../utils/endpoint.js';
import { isRecord } from '@kitsune-mcp/shared';

/** How long a relay waits for a daemon it started to answer /health. */
const DAEMON_STARTUP_WAIT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 2_000;
/**
 * Added on top of the daemon's longest command timeout: covers the daemon's
 * own wait for the headless backend to boot (FOX_HEADLESS_STARTUP_TIMEOUT,
 * default 45 s) plus transport slack.
 */
export const RELAY_TIMEOUT_MARGIN_MS = 60_000;

const log = stderrLogger('relay');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

interface HttpReply {
  status: number;
  body: unknown;
  /** The answer carries a valid daemon signature (signed requests only). */
  verified: boolean;
}

class ConnectionRefusedError extends Error {}

export interface DaemonClientOptions {
  /** Defaults: FOX_HOST / FOX_HTTP_PORT (utils/endpoint.ts). */
  host?: string;
  port?: number;
  /** Defaults to reading ~/.kitsune-mcp/api_token. */
  readToken?: () => string | undefined;
}

export class DaemonClient {
  readonly relayId: string;
  private readonly host: string;
  private readonly port: number;
  private readonly readToken: () => string | undefined;
  private ensuring: Promise<boolean> | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** A KitsuneMCP daemon answered the last /health. */
  private daemonSeen = false;
  /** `protocol` of the last healthy /health answer (undefined from an old daemon). */
  private daemonProtocol: unknown = undefined;

  constructor(relayId: string, options: DaemonClientOptions = {}) {
    this.relayId = relayId;
    this.host = options.host ?? resolveHost();
    this.port = options.port ?? resolveHttpPort();
    this.readToken = options.readToken ?? (() => readApiTokenFile());
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

  /**
   * Resolves true once a daemon answers (starting one if needed). A success is
   * remembered, so later calls return at once; a failure is not, so the next
   * call tries again. Concurrent callers share one attempt.
   */
  ready(): Promise<boolean> {
    if (this.readyPromise === null) {
      this.readyPromise = this.ensureDaemon().then((ok) => {
        if (!ok) this.readyPromise = null;
        return ok;
      });
    }
    return this.readyPromise;
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

    try {
      // env is inherited as-is: daemon settings such as FOX_HEADLESS come
      // from the relay that starts it (DAEMON_SETTINGS).
      const pid = spawnDetachedDaemon({
        entry,
        logPath: daemonLogPath(),
        env: process.env,
        onError: (err) => log(`daemon spawn error: ${err.message}`),
      });
      log(`started daemon (PID ${pid ?? 'unknown'})`);
      return true;
    } catch (err: unknown) {
      log(`failed to start daemon: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * GET /health (also serves as this relay's heartbeat). True when a
   * KitsuneMCP daemon answers — even an incompatible one: it holds the port,
   * so starting another would not help (see protocolMismatch()).
   */
  async checkHealth(timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<boolean> {
    try {
      const reply = await this.request('GET', '/health', undefined, timeoutMs);
      const health = kitsuneHealth(reply.status, reply.body);
      this.daemonSeen = health !== undefined;
      if (health !== undefined) this.daemonProtocol = health['protocol'];
      return health !== undefined;
    } catch {
      this.daemonSeen = false;
      return false;
    }
  }

  /** Error text when the running daemon speaks another protocol, else undefined. */
  protocolMismatch(): string | undefined {
    if (!this.daemonSeen || this.daemonProtocol === DAEMON_PROTOCOL_VERSION) return undefined;
    return (
      `The KitsuneMCP daemon running at ${this.baseUrl} is from another version ` +
      `(protocol ${this.daemonProtocol === undefined ? '1 or older' : String(this.daemonProtocol)}, ` +
      `this session needs ${DAEMON_PROTOCOL_VERSION}). Stop that daemon process (and restart ` +
      'Firefox if it was started by the Native Host); the next tool call starts a matching one.'
    );
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
  async settingsMismatch(timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<string[]> {
    return (await this.checkSettings(timeoutMs)) ?? [];
  }

  /** Like settingsMismatch(), but null when the daemon's settings could not be read (unknown, not "equal"). */
  async checkSettings(timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<string[] | null> {
    const token = this.readToken();
    if (token === undefined) return null;
    let reply: HttpReply;
    try {
      reply = await this.request('GET', '/daemon/info', undefined, timeoutMs, token);
    } catch {
      return null;
    }
    if (reply.status !== 200 || !reply.verified || !isRecord(reply.body)) return null;
    const theirs = daemonSettingsFromInfo(reply.body);
    if (theirs === null) return null;
    const pid = typeof reply.body['pid'] === 'number' ? reply.body['pid'] : 'unknown';

    // Effective values, so `true` / `1` and old / new variable names compare equal.
    const diffs = diffDaemonSettings(effectiveDaemonSettings(process.env), theirs);
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
    approvalToken?: string,
  ): Promise<CallToolResult> {
    const timeoutMs = maxCommandTimeoutMs(args) + RELAY_TIMEOUT_MARGIN_MS;
    const body = JSON.stringify(
      approvalToken === undefined
        ? { name, arguments: args }
        : { name, arguments: args, approvalToken },
    );

    let restarted = false;
    let tokenReloaded = false;
    for (;;) {
      // Look again before refusing: the user may have stopped the old
      // daemon since (then nothing answers, and the request below starts one).
      if (this.protocolMismatch() !== undefined) await this.checkHealth();
      const mismatch = this.protocolMismatch();
      if (mismatch !== undefined) return errorResult(mismatch);

      const token = this.readToken();
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

      if (reply.status === 403 && !reply.verified && !tokenReloaded) {
        // Signature refused: token file replaced since we read it (or the
        // daemon was replaced by an older build): read it again once, after
        // a fresh /health.
        tokenReloaded = true;
        await this.checkHealth();
        continue;
      }

      if (reply.status === 413) {
        // Answered before the signature could be checked (the body is too
        // big to read), hence unsigned. Not using its text.
        return errorResult(
          `The arguments of ${name} exceed the daemon's request size limit (1 MB); send less data per call.`,
        );
      }

      if (!reply.verified && reply.status !== 403) {
        return errorResult(
          `The answer from ${this.baseUrl} is not signed by the KitsuneMCP daemon: another ` +
          'program may be using its port, or the daemon uses a different API token. ' +
          'The result was discarded.',
        );
      }

      if (restarted) {
        // A daemon started by someone else (another session, the Native Host)
        // may have won the race: report its settings if they differ.
        void this.settingsMismatch().then((warnings) => {
          for (const w of warnings) log(`WARNING: ${w}`);
        });
      }

      return this.toCallToolResult(name, reply);
    }
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  /** Report the human's answer to this relay's MCP elicitation. */
  reportElicitation(requestId: string, approved: boolean): Promise<ApprovalReply> {
    return this.postApproval('/approval/elicitation', { requestId, approved }, HEALTH_TIMEOUT_MS * 5);
  }

  /** Ask in the Extension's popup; resolves when the human answered or it timed out. */
  askBrowser(requestId: string, signal?: AbortSignal): Promise<ApprovalReply> {
    return this.postApproval(
      '/approval/browser',
      { requestId },
      maxCommandTimeoutMs({}) + RELAY_TIMEOUT_MARGIN_MS,
      signal,
    );
  }

  /**
   * POST to an approval endpoint. No daemon restart on failure: a new
   * daemon would not know the request anyway.
   */
  private async postApproval(
    urlPath: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ApprovalReply> {
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.readToken();
      if (token === undefined) break;
      const reply = await this.request('POST', urlPath, body, timeoutMs, token, signal);
      // Unsigned 403: our signature was refused (token file replaced): read it
      // again. A signed 403 is the daemon's answer (e.g. elicitation disabled).
      if (reply.status === 403 && !reply.verified && attempt === 0) continue;
      if (!reply.verified) {
        return {
          success: false,
          approved: false,
          error: `The answer from ${this.baseUrl} is not signed by the KitsuneMCP daemon — ignored.`,
        };
      }
      const b = isRecord(reply.body) ? reply.body : {};
      if (reply.status !== 200) {
        const error = typeof b['error'] === 'string' ? b['error'] : `HTTP ${reply.status}`;
        return { success: false, approved: false, error };
      }
      return {
        success: b['success'] === true,
        approved: b['approved'] === true,
        ...(typeof b['reason'] === 'string' ? { reason: b['reason'] } : {}),
        ...(typeof b['approvalToken'] === 'string' ? { approvalToken: b['approvalToken'] } : {}),
        ...(typeof b['error'] === 'string' ? { error: b['error'] } : {}),
      };
    }
    return { success: false, approved: false, error: 'KitsuneMCP daemon is not available (no API token)' };
  }

  private toCallToolResult(name: string, reply: HttpReply): CallToolResult {
    const body = isRecord(reply.body) ? reply.body : {};
    if (reply.status === 200) {
      const parsed = CallToolResultSchema.safeParse(body['result']);
      if (parsed.success) return parsed.data;
      return errorResult(`KitsuneMCP daemon returned a malformed result for ${name}`);
    }

    const mismatch = reply.status === 403 ? this.protocolMismatch() : undefined;
    if (mismatch !== undefined) return errorResult(mismatch);
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
      const signed = token === undefined ? undefined : signRequest(token, method, urlPath, body ?? '');
      if (signed !== undefined) Object.assign(headers, signed.headers);
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
            const raw = Buffer.concat(chunks);
            const status = res.statusCode ?? 0;
            const verified =
              token !== undefined &&
              signed !== undefined &&
              verifyResponse(token, signed.nonce, status, raw, res.headers[AUTH_HEADER.signature]);
            const text = raw.toString('utf-8');
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              // keep raw text
            }
            resolve({ status, body: parsed, verified });
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
export { daemonLogPath };
