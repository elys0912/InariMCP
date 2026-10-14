/**
 * The relay's side of the relay ⇔ daemon link.
 *
 *  - ensureDaemon(): GET /health; when nothing answers, spawn
 *    `node dist/index.js --daemon` detached (stdio cut off from the relay,
 *    stderr appended to ~/.inari-mcp/logs/daemon.log) and wait until it is
 *    healthy. Several relays (and the Native Host) may do this at the same
 *    time: the daemon that cannot bind the HTTP port exits by itself.
 *  - callTool(): POST /mcp/call, signed with the API token (read from
 *    ~/.inari-mcp/api_token *after* the daemon is healthy — only the daemon
 *    creates the token; the token itself is never sent, see
 *    @inari-mcp/shared/node auth.ts) and X-Inari-Relay (audit transport `relay:<id>`).
 *    Before each call, GET /health with a fresh nonce must come back with
 *    the daemon's proof (evaluateHealth, as the Native Host and the daemon's
 *    singleton check judge it): the body (tool name, arguments, approval
 *    token) is never sent to a program that cannot prove it holds the token.
 *    The daemon signs its answer; an unsigned or wrongly signed answer
 *    means another program holds the port, and is refused. Aborting the
 *    call (MCP cancellation) closes the request, which the daemon turns
 *    into cancelling the browser command. The daemon's CallToolResult is
 *    returned unchanged.
 *  - A daemon whose /health reports another `protocol` (an older build
 *    still running) is not used: every call fails with a message telling
 *    the user to stop it. There is no fallback to sending the token.
 *  - heartbeat: GET /health with X-Inari-Relay every RELAY_HEARTBEAT_MS, so the daemon
 *    knows this session is alive (idle shutdown, daemon/activity.ts).
 *  - approvals (relay/approval.ts): POST /approval/elicitation and
 *    /approval/browser; a retried call sends `approvalToken` in the
 *    /mcp/call body.
 *  - stopDaemon() (`--stop-daemon`): signed POST /daemon/shutdown, then
 *    waits until /health stops answering. Never starts a daemon.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { maxCommandTimeoutMs } from '../connection/manager.js';
import { isApprovalReason, type ApprovalReply } from './approval.js';
import { RELAY_HEARTBEAT_MS, SHUTDOWN_DRAIN_MS } from '../daemon/activity.js';
import { HEALTH_PROBE_TIMEOUT_MS } from '../daemon/probe.js';
import {
  AUTH_HEADER,
  DAEMON_PROTOCOL_VERSION,
  evaluateHealth,
  newNonce,
  signRequest,
  verifyResponse,
  type HealthVerdict,
} from '@inari-mcp/shared/node';
import { apiTokenPath, daemonLogPath, spawnDetachedDaemon, stderrLogger } from '@inari-mcp/shared/node';
import {
  MAX_REQUEST_BODY_BYTES,
  RELAY_ID_HEADER,
  compareDaemonSettings,
  readApiTokenFile,
  resolveHost,
  resolveHttpPort,
} from '../utils/endpoint.js';
import { headlessStartupTimeoutMs } from '../utils/headless-env.js';
import { errorMessage } from '../utils/errors.js';
import { isRecord } from '@inari-mcp/shared';

/** How long a relay waits for a daemon it started to answer /health. */
const DAEMON_STARTUP_WAIT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 200;
/**
 * Second wait for /health before a signed request, when the first
 * (HEALTH_PROBE_TIMEOUT_MS) timed out: a daemon busy for a moment answers late.
 */
const BUSY_HEALTH_PROBE_TIMEOUT_MS = 10_000;
/** POST /approval/elicitation only records an answer: no browser round trip. */
const ELICITATION_REPORT_TIMEOUT_MS = 10_000;
/**
 * Time allowed after the drain for the rest of a daemon's shutdown: closing
 * the WebSocket connections and the headless browser, then the exit.
 */
const SHUTDOWN_STEPS_ALLOWANCE_MS = 10_000;
/**
 * How long a daemon that has begun to stop may go on answering /health: its
 * longest wait for running calls (SHUTDOWN_DRAIN_MS) plus the steps after it.
 * stopDaemon() waits this long for the daemon to go away, and so does a tool
 * call answered "shutting down" (signed 503: not run) before it is sent once
 * more (to a new daemon).
 */
const DAEMON_STOP_WAIT_MS = SHUTDOWN_DRAIN_MS + SHUTDOWN_STEPS_ALLOWANCE_MS;
/** Transport slack on top of the daemon's wait for the headless backend (relayTimeoutMarginMs). */
export const RELAY_TRANSPORT_SLACK_MS = 15_000;

/**
 * Added on top of the daemon's longest command timeout: the daemon's own
 * wait for the headless backend to boot (FOX_HEADLESS_STARTUP_TIMEOUT, read
 * from `env` as the daemon reads it) plus RELAY_TRANSPORT_SLACK_MS. 60 s with
 * the default 45 s. `env` is this relay's: the daemon it starts inherits it,
 * and a running daemon started with another value is reported as a settings
 * mismatch (FOX_HEADLESS_STARTUP_TIMEOUT is one of DAEMON_SETTINGS).
 */
export function relayTimeoutMarginMs(env: NodeJS.ProcessEnv = process.env): number {
  return headlessStartupTimeoutMs(env) + RELAY_TRANSPORT_SLACK_MS;
}

const log = stderrLogger('relay');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** What request() sends besides the method and the path. */
interface RequestOptions {
  /** JSON body (POST). */
  body?: string;
  timeoutMs: number;
  /** Signs the request (and lets the answer's signature be checked). */
  token?: string;
  /** Extra request headers (the /health nonce). */
  headers?: http.OutgoingHttpHeaders;
  signal?: AbortSignal;
}

interface HttpReply {
  status: number;
  body: unknown;
  /** The answer carries a valid daemon signature (signed requests only). */
  verified: boolean;
}

class ConnectionRefusedError extends Error {}
/** No answer within the request's timeout: something may hold the port but be busy. */
class RequestTimeoutError extends Error {}

/** A tool call in progress (callTool()): what is sent, and which retries are used up. */
interface PendingCall {
  readonly name: string;
  readonly body: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  /** A daemon was started for this call (at most once per daemon). */
  restarted: boolean;
  /** The token was read again after a refused signature (once). */
  tokenReloaded: boolean;
  /** Sent again after a "shutting down" answer (once). */
  shutdownRetried: boolean;
}

type CallAttempt = { done: false } | { done: true; result: CallToolResult };
const RETRY: CallAttempt = { done: false };
function finished(result: CallToolResult): CallAttempt {
  return { done: true, result };
}

/**
 * Our signature was refused even after reading the token again (unsigned
 * 403): the daemon holds another token. The unsigned body is not used: it
 * may come from any program on the port.
 */
function signatureRefused(baseUrl: string): string {
  return `The InariMCP daemon at ${baseUrl} refused this session's signature ` +
    '(api_token replaced since the daemon started?). Stop the daemon (node dist/index.js --stop-daemon, ' +
    'or end its process) and call the tool again.';
}

/**
 * /health came back without a valid proof for our token (read twice): not
 * the daemon we share a token with, so the call is not sent at all.
 */
function proofRefused(baseUrl: string): string {
  return `${unprovenDaemon(baseUrl)} The call was not sent. Check which process owns the port, or stop the daemon ` +
    '(node dist/index.js --stop-daemon, or end its process) and call the tool again.';
}

/** Why nothing signed is sent to the program on the port (stopDaemon(), approvals, tool calls). */
function unprovenDaemon(baseUrl: string): string {
  return `The program at ${baseUrl} answers as the InariMCP daemon but cannot prove it holds this ` +
    "session's API token (another program may be using its port, or api_token was replaced since the " +
    'daemon started).';
}

export interface StopDaemonResult {
  /** False when something went wrong (a daemon may still be running). */
  ok: boolean;
  /** A daemon was running and is gone now. */
  stopped: boolean;
  pid?: number;
  message: string;
}

export interface DaemonClientOptions {
  /** Defaults: FOX_HOST / FOX_HTTP_PORT (utils/endpoint.ts). */
  host?: string;
  port?: number;
  /** Defaults to reading ~/.inari-mcp/api_token. */
  readToken?: () => string | undefined;
}

/** Something that answers /health as a InariMCP daemon holds the port (proven or not). */
function isDaemonOnPort(verdict: HealthVerdict): boolean {
  return verdict.kind !== 'down' && verdict.kind !== 'foreign';
}

export class DaemonClient {
  readonly relayId: string;
  private readonly host: string;
  private readonly port: number;
  private readonly readToken: () => string | undefined;
  private ensuring: Promise<boolean> | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** A InariMCP daemon answered the last /health. */
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
      log(`failed to start daemon: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * GET /health (also serves as this relay's heartbeat). True when a
   * InariMCP daemon answers — even an incompatible one, or one whose proof
   * is not checked here: it holds the port, so starting another would not
   * help (see protocolMismatch(); callTool() checks the proof).
   */
  async checkHealth(timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS): Promise<boolean> {
    return isDaemonOnPort(await this.probeHealth(undefined, timeoutMs));
  }

  /**
   * GET /health with a fresh nonce, judged by evaluateHealth: with `token`,
   * a compatible daemon is `ok` only when its proof matches. Records what
   * protocolMismatch() reports. `onTimeout` is called when the answer did
   * not come within `timeoutMs` (the verdict is then `down`).
   */
  private async probeHealth(
    token: string | undefined,
    timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
    onTimeout?: () => void,
  ): Promise<HealthVerdict> {
    const nonce = newNonce();
    let verdict: HealthVerdict;
    try {
      const reply = await this.request('GET', '/health', { timeoutMs, headers: { [AUTH_HEADER.nonce]: nonce } });
      verdict = evaluateHealth(reply.status, reply.body, token, nonce);
    } catch (err: unknown) {
      if (err instanceof RequestTimeoutError) onTimeout?.();
      verdict = { kind: 'down' };
    }
    this.daemonSeen = isDaemonOnPort(verdict);
    if (this.daemonSeen) {
      this.daemonProtocol = verdict.kind === 'incompatible' ? verdict.protocol : DAEMON_PROTOCOL_VERSION;
    }
    return verdict;
  }

  /**
   * /health judged with the current token; an `impostor` answer is checked
   * once more with the token read again (the file may have been replaced).
   * Used before anything signed is sent.
   */
  private async verifyDaemon(): Promise<{ token: string | undefined; verdict: HealthVerdict }> {
    let token = this.readToken();
    let verdict = await this.probeHealthPatiently(token);
    if (verdict.kind === 'impostor') {
      token = this.readToken();
      verdict = await this.probeHealthPatiently(token);
    }
    return { token, verdict };
  }

  /**
   * probeHealth(), asked once more with BUSY_HEALTH_PROBE_TIMEOUT_MS when the
   * first answer did not come in time: a busy daemon is not taken for a
   * missing one (which would start another daemon and fail the call). A
   * refused connection is not asked again.
   */
  private async probeHealthPatiently(token: string | undefined): Promise<HealthVerdict> {
    let timedOut = false;
    const verdict = await this.probeHealth(token, HEALTH_PROBE_TIMEOUT_MS, () => { timedOut = true; });
    if (verdict.kind !== 'down' || !timedOut) return verdict;
    log(`no /health answer from ${this.baseUrl} within ${HEALTH_PROBE_TIMEOUT_MS / 1000}s — asking once more`);
    return this.probeHealth(token, BUSY_HEALTH_PROBE_TIMEOUT_MS);
  }

  /** Error text when the running daemon speaks another protocol, else undefined. */
  protocolMismatch(): string | undefined {
    if (!this.daemonSeen || this.daemonProtocol === DAEMON_PROTOCOL_VERSION) return undefined;
    return (
      `The InariMCP daemon running at ${this.baseUrl} is from another version ` +
      `(protocol ${this.daemonProtocol === undefined ? '1 or older' : String(this.daemonProtocol)}, ` +
      `this session needs ${DAEMON_PROTOCOL_VERSION}). Stop that daemon process (end it by PID: ` +
      'it predates --stop-daemon; then restart Firefox if it was started by the Native Host); ' +
      'the next tool call starts a matching one.'
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
   * @returns human-readable warnings (empty when the settings agree); null
   *          when the daemon's settings could not be read (unknown, not "equal")
   */
  async checkSettings(timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS): Promise<string[] | null> {
    const token = this.readToken();
    if (token === undefined) return null;
    let reply: HttpReply;
    try {
      reply = await this.request('GET', '/daemon/info', { timeoutMs, token });
    } catch {
      return null;
    }
    if (reply.status !== 200 || !reply.verified || !isRecord(reply.body)) return null;
    // Effective values, the rule the doctor uses too (compareDaemonSettings).
    const diffs = compareDaemonSettings(process.env, reply.body);
    if (diffs === null) return null;
    if (diffs.length === 0) return [];
    const pid = typeof reply.body['pid'] === 'number' ? reply.body['pid'] : 'unknown';
    return [
      `The shared InariMCP daemon (PID ${pid}) was started with different settings ` +
      'than this session. The running daemon\'s settings apply to every session: ' +
      diffs.join('; ') +
      '. To change them, stop the daemon (node dist/index.js --stop-daemon; it also exits on its own ' +
      'after being unused for FOX_DAEMON_IDLE_TIMEOUT seconds) and start a session with the desired settings.',
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
    const call: PendingCall = {
      name,
      body: JSON.stringify(
        approvalToken === undefined
          ? { name, arguments: args }
          : { name, arguments: args, approvalToken },
      ),
      timeoutMs: maxCommandTimeoutMs(args) + relayTimeoutMarginMs(),
      signal,
      restarted: false,
      tokenReloaded: false,
      shutdownRetried: false,
    };
    for (;;) {
      const attempt = await this.attemptCall(call);
      if (attempt.done) return attempt.result;
    }
  }

  /** One POST /mcp/call; decides whether callTool() sends it again. */
  private async attemptCall(call: PendingCall): Promise<CallAttempt> {
    // A fresh /health every time: the user may have stopped an old daemon
    // since, and whatever holds the port now must prove it holds the token.
    const { token, verdict } = await this.verifyDaemon();
    const mismatch = this.protocolMismatch();
    if (mismatch !== undefined) return finished(errorResult(mismatch));

    if (verdict.kind === 'down') {
      // Nothing was sent, so starting a daemon and retrying cannot run the tool twice.
      if (!call.restarted) {
        call.restarted = true;
        log('daemon not reachable — starting it');
        if (await this.ensureDaemon()) return RETRY;
      }
      return finished(errorResult(`InariMCP daemon is not reachable at ${this.baseUrl} (see ${daemonLogPath()}).`));
    }
    if (verdict.kind === 'foreign') {
      return finished(errorResult(
        `The program at ${this.baseUrl} is not the InariMCP daemon (its /health answer is not ` +
        "the daemon's). The call was not sent. Check which process owns the port.",
      ));
    }

    if (token === undefined) {
      if (!call.restarted && (await this.ensureDaemon())) {
        call.restarted = true;
        return RETRY;
      }
      return finished(errorResult(
        `InariMCP daemon is not available: no API token at ${apiTokenPath()} ` +
        `(the daemon creates it on start; see ${daemonLogPath()}).`,
      ));
    }
    if (verdict.kind !== 'ok') return finished(errorResult(proofRefused(this.baseUrl)));

    let reply: HttpReply;
    try {
      reply = await this.request('POST', '/mcp/call', {
        body: call.body,
        timeoutMs: call.timeoutMs,
        token,
        signal: call.signal,
      });
    } catch (err: unknown) {
      // Connection refused: the request never reached a daemon, so starting
      // one and retrying cannot run the tool twice.
      if (err instanceof ConnectionRefusedError && !call.restarted) {
        call.restarted = true;
        log('daemon not reachable — starting it');
        if (await this.ensureDaemon()) return RETRY;
      }
      return finished(errorResult(`InariMCP daemon request failed (${this.baseUrl}): ${errorMessage(err)}`));
    }

    return this.answerOf(call, reply);
  }

  /** What callTool() does with the daemon's reply: retry, or the result. */
  private async answerOf(call: PendingCall, reply: HttpReply): Promise<CallAttempt> {
    if (reply.status === 403 && !reply.verified) {
      if (!call.tokenReloaded) {
        // Signature refused: token file replaced since we read it (or the
        // daemon was replaced by an older build): read it again once, after
        // a fresh /health.
        call.tokenReloaded = true;
        await this.checkHealth();
        return RETRY;
      }
      return finished(errorResult(this.protocolMismatch() ?? signatureRefused(this.baseUrl)));
    }

    if (reply.status === 503 && reply.verified && !call.shutdownRetried) {
      // The daemon is shutting down and did not run the call: wait until it
      // is gone, then send it once more (the next request starts a daemon).
      call.shutdownRetried = true;
      log(`daemon is shutting down: retrying ${call.name} once it is gone`);
      if (await this.waitUntilGone(DAEMON_STOP_WAIT_MS, call.signal)) {
        call.restarted = false;
        return RETRY;
      }
    }

    if (reply.status === 413) {
      // Answered before the signature could be checked (the body is too
      // big to read), hence unsigned. Not using its text.
      return finished(errorResult(
        `The arguments of ${call.name} exceed the daemon's request size limit ` +
        `(${MAX_REQUEST_BODY_BYTES} bytes); send less data per call.`,
      ));
    }

    if (!reply.verified) {
      return finished(errorResult(
        `The answer from ${this.baseUrl} is not signed by the InariMCP daemon: another ` +
        'program may be using its port, or the daemon uses a different API token. ' +
        'The result was discarded.',
      ));
    }

    if (call.restarted) this.warnOnSettingsMismatch();
    return finished(this.toCallToolResult(call.name, reply));
  }

  /**
   * A daemon started by someone else (another session, the Native Host)
   * may have won the race: report its settings if they differ.
   */
  private warnOnSettingsMismatch(): void {
    void this.checkSettings()
      .then((warnings) => {
        for (const w of warnings ?? []) log(`WARNING: ${w}`);
      })
      .catch((err: unknown) => log(`settings check failed: ${errorMessage(err)}`));
  }

  // -------------------------------------------------------------------------
  // Stop (`--stop-daemon`)
  // -------------------------------------------------------------------------

  /**
   * Ask the running daemon to stop (signed POST /daemon/shutdown) and wait
   * until nothing answers /health any more. Never starts a daemon.
   * `force` skips the daemon's wait for running calls. The signed request is
   * sent only to a daemon whose /health proves it holds our token.
   */
  async stopDaemon(force = false, waitMs: number = DAEMON_STOP_WAIT_MS): Promise<StopDaemonResult> {
    const { token, verdict } = await this.verifyDaemon();
    if (!isDaemonOnPort(verdict)) {
      return { ok: true, stopped: false, message: `no InariMCP daemon answers at ${this.baseUrl}` };
    }
    const mismatch = this.protocolMismatch();
    if (mismatch !== undefined) return { ok: false, stopped: false, message: mismatch };
    if (token === undefined) {
      return {
        ok: false,
        stopped: false,
        message: `a daemon answers at ${this.baseUrl} but there is no API token at ${apiTokenPath()} to sign the request`,
      };
    }
    if (verdict.kind !== 'ok') {
      return {
        ok: false,
        stopped: false,
        message: `${unprovenDaemon(this.baseUrl)} The stop request was not sent. Check which process owns the port.`,
      };
    }

    const body = JSON.stringify({ force });
    let reply: HttpReply;
    try {
      reply = await this.request('POST', '/daemon/shutdown', { body, timeoutMs: waitMs, token });
    } catch (err: unknown) {
      return { ok: false, stopped: false, message: `POST ${this.baseUrl}/daemon/shutdown failed: ${errorMessage(err)}` };
    }
    if (!reply.verified) {
      return {
        ok: false,
        stopped: false,
        message: reply.status === 403
          ? signatureRefused(this.baseUrl)
          : `the answer from ${this.baseUrl} is not signed by the InariMCP daemon — not trusting it`,
      };
    }
    if (reply.status !== 200) {
      const b = isRecord(reply.body) ? reply.body : {};
      const error = typeof b['error'] === 'string' ? b['error'] : `HTTP ${reply.status}`;
      return { ok: false, stopped: false, message: `the daemon refused to stop: ${error}` };
    }
    const b = isRecord(reply.body) ? reply.body : {};
    const pid = typeof b['pid'] === 'number' ? b['pid'] : undefined;

    if (await this.waitUntilGone(waitMs)) {
      return { ok: true, stopped: true, pid, message: `daemon${pid !== undefined ? ` (PID ${pid})` : ''} stopped` };
    }
    return {
      ok: false,
      stopped: false,
      pid,
      message: `the daemon${pid !== undefined ? ` (PID ${pid})` : ''} accepted the stop request but still answers after ${waitMs / 1000}s`,
    };
  }

  /** Poll /health until nothing answers. False when it still answers after `waitMs` (or on abort). */
  private async waitUntilGone(waitMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && signal?.aborted !== true) {
      await sleep(HEALTH_POLL_INTERVAL_MS);
      if (!(await this.checkHealth())) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  /** Report the human's answer to this relay's MCP elicitation. */
  reportElicitation(requestId: string, approved: boolean): Promise<ApprovalReply> {
    return this.postApproval('/approval/elicitation', { requestId, approved }, ELICITATION_REPORT_TIMEOUT_MS);
  }

  /** Ask in the Extension's popup; resolves when the human answered or it timed out. */
  askBrowser(requestId: string, signal?: AbortSignal): Promise<ApprovalReply> {
    return this.postApproval(
      '/approval/browser',
      { requestId },
      maxCommandTimeoutMs({}) + relayTimeoutMarginMs(),
      signal,
    );
  }

  /**
   * POST to an approval endpoint. No daemon restart on failure: a new
   * daemon would not know the request anyway. Sent only to a daemon whose
   * /health proves it holds our token (the request ID and the human's answer
   * are not given to another program on the port).
   */
  private async postApproval(
    urlPath: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ApprovalReply> {
    const body = JSON.stringify(payload);
    let tokenReloaded = false;
    for (;;) {
      const { token, verdict } = await this.verifyDaemon();
      if (!isDaemonOnPort(verdict)) {
        return { success: false, approved: false, error: `no InariMCP daemon answers at ${this.baseUrl}` };
      }
      const mismatch = this.protocolMismatch();
      if (mismatch !== undefined) return { success: false, approved: false, error: mismatch };
      if (token === undefined) {
        return { success: false, approved: false, error: 'InariMCP daemon is not available (no API token)' };
      }
      if (verdict.kind !== 'ok') {
        return { success: false, approved: false, error: `${unprovenDaemon(this.baseUrl)} The answer was not sent.` };
      }
      const reply = await this.request('POST', urlPath, { body, timeoutMs, token, signal });
      // Unsigned 403: our signature was refused (token file replaced): read it
      // again once, as callTool() does. A signed 403 is the daemon's answer
      // (elicitation disabled).
      if (reply.status === 403 && !reply.verified) {
        if (!tokenReloaded) {
          tokenReloaded = true;
          continue;
        }
        return { success: false, approved: false, error: signatureRefused(this.baseUrl) };
      }
      if (!reply.verified) {
        return {
          success: false,
          approved: false,
          error: `The answer from ${this.baseUrl} is not signed by the InariMCP daemon — ignored.`,
        };
      }
      const b = isRecord(reply.body) ? reply.body : {};
      const reason = isApprovalReason(b['reason']) ? { reason: b['reason'] } : {};
      if (reply.status !== 200) {
        const error = typeof b['error'] === 'string' ? b['error'] : `HTTP ${reply.status}`;
        // reason kept: elicitation_disabled (403) sends the relay to the browser.
        return { success: false, approved: false, ...reason, error };
      }
      return {
        success: b['success'] === true,
        approved: b['approved'] === true,
        ...reason,
        ...(typeof b['approvalToken'] === 'string' ? { approvalToken: b['approvalToken'] } : {}),
        ...(typeof b['error'] === 'string' ? { error: b['error'] } : {}),
      };
    }
  }

  private toCallToolResult(name: string, reply: HttpReply): CallToolResult {
    const body = isRecord(reply.body) ? reply.body : {};
    if (reply.status === 200) {
      const parsed = CallToolResultSchema.safeParse(body['result']);
      if (parsed.success) return parsed.data;
      return errorResult(`InariMCP daemon returned a malformed result for ${name}`);
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

  private request(method: 'GET' | 'POST', urlPath: string, options: RequestOptions): Promise<HttpReply> {
    const { body, timeoutMs, token, signal } = options;
    return new Promise<HttpReply>((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { ...options.headers, [RELAY_ID_HEADER]: this.relayId };
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
        req.destroy(new RequestTimeoutError(`no answer from the daemon within ${Math.round(timeoutMs / 1000)}s`));
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
