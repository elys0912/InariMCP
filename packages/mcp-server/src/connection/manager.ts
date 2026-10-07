/**
 * Browser connection manager.
 *
 * Manages registered browser connections (the Native Host over WebSocket,
 * or the headless backend) and routes outgoing commands to the active
 * browser, returning a Promise that resolves when the browser responds.
 *
 * Fork-source: server.py L817-878 BrowserConnectionManager
 *
 * Key difference from the Python original:
 *   Python uses asyncio.Future + dict.
 *   TypeScript uses Promise + Map<requestId, { resolve, timer, connectionId }>.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { shortId, type BrowserAction, type BrowserCommand, type BrowserResponse } from '@kitsune-mcp/shared';
import { errorMessage } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Call context (client abort)
// ---------------------------------------------------------------------------

/**
 * The AbortSignal of the tool call being executed, if its transport has one
 * (http-bridge.ts: the HTTP client went away). sendCommand() reads it, so
 * the tool handlers between the transport and the connection manager do not
 * need to pass it along.
 */
const callSignal = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` so that every sendCommand() it makes is cancelled when `signal` aborts. */
export function runWithCallSignal<T>(signal: AbortSignal, fn: () => T): T {
  return callSignal.run(signal, fn);
}

const CANCELLED_ERROR = 'Cancelled: the client abandoned the tool call';

// ---------------------------------------------------------------------------
// Command context (deadline and cancellation, for the connection)
// ---------------------------------------------------------------------------

/** What a connection may learn about the command it is handed. */
export interface CommandContext {
  /** Date.now() at which sendCommand() stops waiting for the answer. */
  readonly deadline: number;
  /**
   * Aborted when sendCommand() gives up on the command (timeout, client
   * abort, disconnect, shutdown): an answer would be dropped from then on.
   */
  readonly signal: AbortSignal;
}

const commandContext = new AsyncLocalStorage<CommandContext>();

/**
 * The context of the command being handed to a connection. Set while the
 * connection's SendFn runs (and in what it starts from there), so the
 * headless backend can skip or stop a command nobody waits for any more.
 */
export function currentCommandContext(): CommandContext | undefined {
  return commandContext.getStore();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Hands a command to a browser connection. The connection serializes it if
 * its transport needs to (ws-bridge.ts); the headless backend takes it as is.
 */
type SendFn = (command: BrowserCommand) => void | Promise<void>;

/**
 * Kind of browser connection. Selection priority:
 *   1. 'native-host' — Extension ⇔ Native Messaging ⇔ Native Host ⇔ WS
 *   2. 'headless'    — Playwright Firefox (Advanced, FOX_HEADLESS=1)
 */
export type BrowserKind = 'native-host' | 'headless';

const KIND_PRIORITY: readonly BrowserKind[] = ['native-host', 'headless'];

interface BrowserConnection {
  id: string;
  kind: BrowserKind;
  send: SendFn;
  registeredAt: number;
}

interface PendingRequest {
  resolve: (value: BrowserResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  connectionId: string;
  /** Aborts the command's CommandContext signal. */
  abort: (reason: string) => void;
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/** Ordinary commands over the Native Host path. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Ordinary commands on the headless backend (headless/limits.ts stays below it). */
export const HEADLESS_COMMAND_TIMEOUT_MS = 35_000;

/** Long-running actions that wait for a human. */
const ACTION_TIMEOUT_MS: Partial<Record<BrowserAction, number>> = {
  request_approval: 90_000,
  solve_captcha: 200_000, // fox_detect_captcha
};

/**
 * Actions that wait for a person in the browser. The Extension's own wait
 * (content.ts: the `timeout` argument, which the tool schemas always fill
 * in — 60 s / 180 s by default — falling back to TIMEOUTS.APPROVAL /
 * TIMEOUTS.CAPTCHA) is always shorter than ours: ours is max(90 s / 200 s,
 * argument + 5 s). When our timer fires first anyway (lost message, stalled
 * tab), we send `cancel_human_wait` so the Extension withdraws the banner.
 * That is best-effort; an answer arriving after the timeout is dropped by
 * handleResponse() either way.
 */
const HUMAN_WAIT_ACTIONS: ReadonlySet<BrowserAction> = new Set<BrowserAction>([
  'request_approval',
  'solve_captcha',
]);

const HUMAN_WAIT_TIMEOUT_NOTE =
  '. The browser was asked to withdraw the approval / captcha banner; an ' +
  'answer given after this timeout is ignored, so ask again if still needed.';

/**
 * Ask the Extension to withdraw the banner of a timed-out human wait.
 * Fire-and-forget: the reply carries a `cancel-` requestId that is never
 * pending, so handleResponse() drops it.
 */
function cancelHumanWait(conn: BrowserConnection, requestId: string): void {
  const cancel: BrowserCommand = {
    action: 'cancel_human_wait',
    requestId: `cancel-${requestId}`,
    data: { requestId },
  };
  try {
    const maybePromise = conn.send(cancel);
    if (maybePromise instanceof Promise) maybePromise.catch(() => { /* best-effort */ });
  } catch {
    // Connection gone — nothing left to withdraw from
  }
}

/**
 * Headroom added on top of a tool's own `timeout` / `timeoutMs` argument, so
 * the browser-side wait expires (and reports a meaningful error) before the
 * transport-level timeout fires.
 */
const ARG_TIMEOUT_MARGIN_MS = 5_000;

/** The tool's own `timeoutMs` / `timeout` argument (schemas.ts), when it is a positive number. */
function argTimeoutOf(data: Record<string, unknown>): number | undefined {
  return [data['timeoutMs'], data['timeout']].find(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
}

/**
 * Compute the transport timeout for a command.
 *
 * base = per-action value (request_approval 90 s, solve_captcha 200 s) or
 *        the per-transport default (30 s / headless 35 s).
 * If the tool arguments carry `timeout` or `timeoutMs` (schemas.ts), the
 * result is max(base, arg + margin): an explicit long wait is honoured,
 * and the transport never gives up before the browser-side wait does.
 */
export function resolveCommandTimeout(
  command: BrowserCommand,
  kind: BrowserKind,
): number {
  const base =
    ACTION_TIMEOUT_MS[command.action] ??
    (kind === 'headless' ? HEADLESS_COMMAND_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS);

  const argTimeout = argTimeoutOf(command.data ?? {});
  if (argTimeout === undefined) return base;
  return Math.max(base, argTimeout + ARG_TIMEOUT_MARGIN_MS);
}

/**
 * Upper bound of resolveCommandTimeout() for any action / transport with the
 * given tool arguments. The relay (relay/daemon-client.ts) waits longer than
 * this for the daemon's HTTP answer, so the daemon always reports its own
 * timeout first.
 */
export function maxCommandTimeoutMs(args: Record<string, unknown>): number {
  const base = Math.max(
    DEFAULT_COMMAND_TIMEOUT_MS,
    HEADLESS_COMMAND_TIMEOUT_MS,
    ...Object.values(ACTION_TIMEOUT_MS).filter((v): v is number => typeof v === 'number'),
  );
  const argTimeout = argTimeoutOf(args);
  return argTimeout === undefined ? base : Math.max(base, argTimeout + ARG_TIMEOUT_MARGIN_MS);
}

// ---------------------------------------------------------------------------
// BrowserConnectionManager
// ---------------------------------------------------------------------------

export class BrowserConnectionManager {
  /** Registered browser connections keyed by a unique ID. */
  private readonly connections = new Map<string, BrowserConnection>();

  /** In-flight command promises awaiting a BrowserResponse. */
  private readonly pending = new Map<string, PendingRequest>();

  /** Monotonically increasing counter used to generate request IDs. */
  private requestCounter = 0;

  /**
   * Random per-process prefix of request IDs (`<bootId>-<n>`). The Native
   * Host keeps requestIds for up to 10 minutes (its inFlight map), so IDs
   * must not repeat when the daemon restarts and counts from 1 again.
   */
  readonly bootId = shortId();

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /** Register a new browser connection. */
  registerBrowser(id: string, sendFn: SendFn, kind: BrowserKind): void {
    this.connections.set(id, { id, kind, send: sendFn, registeredAt: Date.now() });
    process.stderr.write(`[KitsuneMCP] Browser registered: ${id} (${kind})\n`);
  }

  /**
   * Unregister a browser connection and fail every request still waiting on
   * it (instead of letting each one run into its timeout).
   */
  unregisterBrowser(id: string): void {
    if (!this.connections.delete(id)) return;
    process.stderr.write(`[KitsuneMCP] Browser unregistered: ${id}\n`);

    for (const [requestId, entry] of this.pending) {
      if (entry.connectionId === id) this.failPending(requestId, entry, 'Browser disconnected before responding');
    }
  }

  /**
   * Answer a pending request with `error` and abort its CommandContext: the
   * one way a request ends without the browser's answer (timeout, client
   * abort, send failure, disconnect, shutdown).
   */
  private failPending(requestId: string, entry: PendingRequest, error: string): void {
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve({ requestId, success: false, error });
    entry.abort(error);
  }

  /**
   * Pick the connection to use, by explicit priority:
   * native-host first, then headless. Within one kind the earliest
   * registered connection wins: a later client holding the token must not
   * take over the command stream of a working browser. Stale connections
   * (a restarted Firefox, a half-open socket after sleep) are removed by
   * the ws-bridge's close handling, heartbeat and newcomer probe.
   */
  getActiveBrowser(): BrowserConnection | undefined {
    for (const kind of KIND_PRIORITY) {
      let best: BrowserConnection | undefined;
      for (const conn of this.connections.values()) {
        if (conn.kind !== kind) continue;
        if (!best || conn.registeredAt < best.registeredAt) best = conn;
      }
      if (best) return best;
    }
    return undefined;
  }

  /** Whether at least one browser is connected. */
  get hasBrowser(): boolean {
    return this.connections.size > 0;
  }

  /** Number of currently connected browsers. */
  get browserCount(): number {
    return this.connections.size;
  }

  /** Number of Native Host (WebSocket) connections — the daemon's idle check. */
  get nativeHostCount(): number {
    let n = 0;
    for (const conn of this.connections.values()) {
      if (conn.kind === 'native-host') n += 1;
    }
    return n;
  }

  /** Kind of the connection commands would currently go to, if any. */
  get activeKind(): BrowserKind | undefined {
    return this.getActiveBrowser()?.kind;
  }

  // -----------------------------------------------------------------------
  // Command send / response routing
  // -----------------------------------------------------------------------

  /**
   * Send a command to the active browser and wait for its response.
   *
   * - Assigns a unique `requestId` to the command.
   * - Times out after `timeoutMs`, or the per-action value from
   *   resolveCommandTimeout() when omitted.
   * - Returns a synthetic error response when no browser is connected,
   *   on send failure, on disconnect, or on timeout.
   */
  async sendCommand(
    command: BrowserCommand,
    timeoutMs?: number,
  ): Promise<BrowserResponse> {
    const conn = this.getActiveBrowser();
    if (!conn) {
      return {
        requestId: command.requestId,
        success: false,
        error:
          'No browser connected. Start Firefox with the KitsuneMCP extension ' +
          '(its Native Host connects to this server over WebSocket), or set FOX_HEADLESS=1.',
      };
    }

    const effectiveTimeout = timeoutMs ?? resolveCommandTimeout(command, conn.kind);

    const signal = callSignal.getStore();
    if (signal?.aborted) {
      return { requestId: command.requestId, success: false, error: CANCELLED_ERROR };
    }

    this.requestCounter += 1;
    const requestId = `${this.bootId}-${this.requestCounter}`;
    const commandAbort = new AbortController();
    const context: CommandContext = {
      deadline: Date.now() + effectiveTimeout,
      signal: commandAbort.signal,
    };
    const response = this.registerPending({ command, conn, requestId, effectiveTimeout, signal, commandAbort });
    // Rewrite the command's requestId so caller and browser agree.
    this.dispatch(conn, { ...command, requestId }, context, requestId);
    return response;
  }

  /**
   * Put the command in `pending` and return the promise of its answer: the
   * browser's, or a synthetic error on timeout or client abort (a human wait
   * on the Native Host path also asks the Extension to withdraw its banner).
   */
  private registerPending(p: {
    command: BrowserCommand;
    conn: BrowserConnection;
    requestId: string;
    effectiveTimeout: number;
    signal: AbortSignal | undefined;
    commandAbort: AbortController;
  }): Promise<BrowserResponse> {
    const { command, conn, requestId, effectiveTimeout, signal, commandAbort } = p;
    const humanWait = HUMAN_WAIT_ACTIONS.has(command.action);
    const withdrawBanner = humanWait && conn.kind !== 'headless';
    return new Promise<BrowserResponse>((resolve) => {
      const onAbort = (): void => {
        if (!this.failRequest(requestId, CANCELLED_ERROR)) return;
        if (withdrawBanner) cancelHumanWait(conn, requestId);
      };
      const timer = setTimeout(() => {
        this.failRequest(
          requestId,
          `Command '${command.action}' timed out after ${effectiveTimeout}ms` +
          (humanWait ? HUMAN_WAIT_TIMEOUT_NOTE : ''),
        );
        if (withdrawBanner) cancelHumanWait(conn, requestId);
      }, effectiveTimeout);

      this.pending.set(requestId, {
        resolve: (response) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(response);
        },
        timer,
        connectionId: conn.id,
        abort: (reason) => { commandAbort.abort(new Error(reason)); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Hand the command to the connection; a send failure fails the pending request. */
  private dispatch(conn: BrowserConnection, outgoing: BrowserCommand, context: CommandContext, requestId: string): void {
    const sendFailed = (err: unknown): void => { this.failRequest(requestId, `Send failed: ${errorMessage(err)}`); };
    try {
      const maybePromise = commandContext.run(context, () => conn.send(outgoing));
      if (maybePromise instanceof Promise) maybePromise.catch(sendFailed);
    } catch (err: unknown) {
      sendFailed(err);
    }
  }

  /** failPending() by ID. @returns false when the request is no longer pending. */
  private failRequest(requestId: string, error: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.failPending(requestId, entry, error);
    return true;
  }

  /**
   * Route a received BrowserResponse to the corresponding pending Promise.
   * Called by the WebSocket bridge and the headless adapter.
   */
  handleResponse(response: BrowserResponse): void {
    const { requestId } = response;
    if (!requestId) return;

    const entry = this.pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.resolve(response);
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Fail all pending requests and clear connections. */
  shutdown(): void {
    for (const [id, entry] of this.pending) this.failPending(id, entry, 'Connection manager shutting down');
    this.connections.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: BrowserConnectionManager | undefined;

/** Get (or lazily create) the singleton BrowserConnectionManager. */
export function getConnectionManager(): BrowserConnectionManager {
  if (!instance) {
    instance = new BrowserConnectionManager();
  }
  return instance;
}
