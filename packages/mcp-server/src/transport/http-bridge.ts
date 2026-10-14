/**
 * HTTP API server (transport bridge).
 *
 * Uses Node.js standard `http` module — no Express, no external dependencies.
 * Provides the REST endpoints that the Native Host (health probe) and local
 * debug tools consume. Browser commands do NOT travel over HTTP: the Native
 * Host receives them over the WebSocket bridge (ws-bridge.ts).
 *
 * This server belongs to the shared daemon (`--daemon`). Tool calls from
 * every Claude Code session arrive here: each session's stdio relay
 * (relay/main.ts) forwards its MCP tools/call to POST /mcp/call.
 *
 * Tool execution over HTTP (POST /mcp/call): zod validation against
 * callSchemaFor(name) (tools/operations.ts) ->
 * createToolHandler (SafetyGuard.check, containerScope /
 * confirmReadUrlRules attachment, post-processing). Every tool is
 * reachable: FOX_CAPS is a per-session tools/list setting applied by each
 * relay, not a daemon-side restriction. Policy
 * restrictions live in the SafetyGuard (safety.json / FOX_READ_ONLY) and
 * apply to every caller alike.
 *
 * A relay identifies itself with the `X-Inari-Relay: <id>` header; its
 * calls are audited with transport `relay:<id>` (other callers: `http`).
 * When the caller goes away before the answer (relay abort / timeout), the
 * browser commands of that call are cancelled (runWithCallSignal).
 *
 * Human approval of tool calls (tools/approval-flow.ts):
 *  - POST /mcp/call may carry `approvalToken` next to `arguments` (never a
 *    tool argument, so the LLM does not see or pass it).
 *  - POST /approval/elicitation { requestId, approved } — the relay reports
 *    the human's answer to its MCP elicitation. 403 when
 *    FOX_APPROVAL_ELICITATION is off.
 *  - POST /approval/browser { requestId } — ask in the Extension's popup
 *    and wait for the answer.
 *  Both answer { success, approved, reason, approvalToken?, expiresAt? }.
 *
 * Graceful stop: POST /daemon/shutdown { force?: boolean } — signed requests
 * only (never X-API-Key). Waits for running calls (SHUTDOWN_DRAIN_MS cap,
 * daemon/activity.ts; none with force), closes the headless browser and the
 * WS connections (1001), answers { status: 'stopping', pid, … } and exits
 * 0 once the answer is out (also after a failed shutdown, answered 500).
 * New tool calls get 503 meanwhile, as they do while the daemon stops on a
 * signal or when idle (isShuttingDown). Clients: relay `--stop-daemon`
 * (relay/daemon-client.ts stopDaemon), scripts/uninstall.mjs, tests/e2e.
 *
 * Fork-source: server.py L885-1460 MCPHTTPHandler
 *
 * Security:
 *  - Authenticated routes accept either
 *      a signed request (x-inari-timestamp / -nonce / -signature, see
 *      auth.ts) — what the relays and the Native Host send; the token never
 *      travels, and the response carries our own signature so the client
 *      can tell the daemon from a program squatting on the port; or
 *      X-API-Key: <token> — for manual debugging (curl). Compared with
 *      crypto.timingSafeEqual(); responses are not signed.
 *  - /health is unauthenticated (probe endpoint). With x-inari-nonce it
 *    adds `proof`, a MAC over that nonce, so a client holding the token can
 *    check it is talking to the real daemon.
 *  - Host header must be `localhost`, an IP literal or the configured host
 *    (a DNS-rebinding page always uses some other name).
 *  - OPTIONS returns 403 (no CORS headers — all callers are local processes)
 *  - Listens on 127.0.0.1, or the loopback address FOX_HOST names (daemon/main.ts
 *    refuses to start with any other)
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { ENV_DEFAULTS, isRecord } from '@inari-mcp/shared';
import { runWithCallSignal, type BrowserConnectionManager } from '../connection/manager.js';
import { listScreenshotEntries } from '../utils/screenshot.js';
import { callSchemaFor, callableToolNames, describeTool } from '../tools/operations.js';
import { createToolHandler } from '../tools/handlers.js';
import { answerFromElicitation, askBrowser } from '../tools/approval-flow.js';
import { MAX_REQUEST_BODY_BYTES, RELAY_ID_HEADER, isValidRelayId } from '../utils/endpoint.js';
import { errorMessage } from '../utils/errors.js';
import type { DaemonActivity } from '../daemon/activity.js';
import {
  AUTH_HEADER,
  DAEMON_PROTOCOL_VERSION,
  HTTP_SIGNATURE_WINDOW_MS,
  MAC_LABEL,
  computeMac,
  isNonce,
  macMatches,
  responseMac,
  sha256Hex,
} from '@inari-mcp/shared/node';
import { PACKAGE_VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How much of an oversized body is read (and dropped) so the 413 gets through. */
const MAX_DRAIN_BYTES = 16 * MAX_REQUEST_BODY_BYTES;
/** Upper bound of remembered nonces (far above any real request rate). */
const MAX_REMEMBERED_NONCES = 100_000;
/**
 * How long a client has to send its whole body. A signed request's body is
 * read before the signature can be checked, so this bounds what a client
 * without the token can hold open. Tool calls send their body at once; only
 * the answer may take minutes (requestTimeout stays 0).
 */
const BODY_TIMEOUT_MS = 30_000;
/** How long a client has to send its request headers. */
const HEADERS_TIMEOUT_MS = 10_000;
/** x-inari-timestamp: milliseconds since the epoch, decimal (16 digits reach far past year 2100). */
const TIMESTAMP_PATTERN = /^\d{1,16}$/;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of the provided key against the server token.
 *
 * When lengths differ, performs a dummy comparison to prevent timing leaks
 * from the length check itself.
 */
function verifyApiKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;

  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');

  if (a.length !== b.length) {
    // Dummy comparison to keep timing constant regardless of length mismatch
    crypto.timingSafeEqual(b, b);
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Checks signed requests (auth.ts): MAC, timestamp window, and that the
 * nonce was not used before (replay). Nonces are remembered for twice the
 * timestamp window, after which a replay fails the timestamp check anyway.
 *
 * The timestamp is compared with the wall clock (the client signs with its
 * own), but how long a nonce is remembered is measured on a monotonic clock:
 * a wall clock set forward must not make us forget nonces that are still
 * inside the window once it is set back, and a clock set back must not
 * break the expiry order the pruning relies on. Only a wall clock set back
 * by more than the window after a nonce was forgotten can reopen it.
 */
export class SignedRequestVerifier {
  /** nonce → expiry on the monotonic clock. Insertion order = expiry order. */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly token: string,
    private readonly windowMs: number = HTTP_SIGNATURE_WINDOW_MS,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  /** Nonces currently remembered (tests). */
  get rememberedNonces(): number {
    return this.seen.size;
  }

  /** True when the request carries signature headers at all. */
  static isSigned(req: http.IncomingMessage): boolean {
    return header(req, AUTH_HEADER.signature) !== undefined;
  }

  /** @returns the request nonce when valid (needed to sign the response), else undefined. */
  verify(req: http.IncomingMessage, body: Buffer, now: number = Date.now()): string | undefined {
    const timestamp = header(req, AUTH_HEADER.timestamp);
    const nonce = header(req, AUTH_HEADER.nonce);
    const signature = header(req, AUTH_HEADER.signature);
    if (timestamp === undefined || !TIMESTAMP_PATTERN.test(timestamp) || !isNonce(nonce)) return undefined;
    if (Math.abs(now - Number(timestamp)) > this.windowMs) return undefined;

    const expected = computeMac(
      this.token,
      MAC_LABEL.httpRequest,
      (req.method ?? 'GET').toUpperCase(),
      req.url ?? '/',
      timestamp,
      nonce,
      sha256Hex(body),
    );
    if (!macMatches(signature, expected)) return undefined;

    const mono = this.monotonicNow();
    this.prune(mono);
    if (this.seen.has(nonce) || this.seen.size >= MAX_REMEMBERED_NONCES) return undefined;
    this.seen.set(nonce, mono + 2 * this.windowMs);
    return nonce;
  }

  private prune(mono: number): void {
    for (const [nonce, expiry] of this.seen) {
      if (expiry > mono) break; // insertion order = expiry order (monotonic clock)
      this.seen.delete(nonce);
    }
  }
}

/**
 * Host header check against DNS rebinding: a web page that rebinds its own
 * name to 127.0.0.1 still sends that name. Accept `localhost`, IP literals
 * and the configured host; requests without Host (HTTP/1.0 tools) pass.
 */
export function isAllowedHostHeader(hostHeader: string | undefined, configuredHost: string): boolean {
  if (hostHeader === undefined || hostHeader === '') return true;
  let name = hostHeader.trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end < 0) return false;
    name = name.slice(1, end);
  } else {
    const colon = name.lastIndexOf(':');
    if (colon >= 0) name = name.slice(0, colon);
  }
  return name === 'localhost' || net.isIP(name) !== 0 || name === configuredHost.toLowerCase();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Writes JSON answers; signs them when the request was a valid signed one. */
interface Responder {
  json(status: number, data: Record<string, unknown>, extraHeaders?: http.OutgoingHttpHeaders): void;
  error(status: number, message: string, extraHeaders?: http.OutgoingHttpHeaders): void;
  /** Sign every later answer for this nonce (set after a successful signed-auth check). */
  signWith(nonce: string): void;
}

function responder(res: http.ServerResponse, token: string): Responder {
  let nonce: string | undefined;
  const json = (status: number, data: Record<string, unknown>, extraHeaders: http.OutgoingHttpHeaders = {}): void => {
    if (res.headersSent) return;
    const body = JSON.stringify(data);
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders,
    };
    if (nonce !== undefined) headers[AUTH_HEADER.signature] = responseMac(token, nonce, status, body);
    res.writeHead(status, headers);
    res.end(body);
  };
  return {
    json,
    error: (status, message, extraHeaders) => json(status, { error: message }, extraHeaders),
    signWith: (n) => { nonce = n; },
  };
}

// ---------------------------------------------------------------------------
// Body reader
// ---------------------------------------------------------------------------

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

/**
 * Read the request body (at most MAX_REQUEST_BODY_BYTES).
 *
 * On overflow the rest of the body is read and discarded, and the promise
 * rejects with BodyTooLargeError only once the client has finished sending:
 * answering (and closing) while it is still writing would reset the
 * connection, and the client would never see the 413. A client that keeps
 * sending past MAX_DRAIN_BYTES is cut off instead, and so is one that has
 * not finished within `timeoutMs`.
 */
function readBody(req: http.IncomingMessage, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(), timeoutMs);
    timer.unref();
    req.once('close', () => clearTimeout(timer));
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const declared = Number(req.headers['content-length']);
    let overflow = Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES;

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (overflow) {
        if (totalLength > MAX_DRAIN_BYTES) req.destroy();
        return;
      }
      if (totalLength > MAX_REQUEST_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflow) reject(new BodyTooLargeError());
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('close', () => {
      // Destroyed (drain limit, client gone) before 'end'.
      if (!req.complete) reject(new Error('Request aborted'));
    });
  });
}

/**
 * An AbortSignal that fires when the client goes away before the answer
 * (relay abort or timeout), so pending browser commands are cancelled
 * (runWithCallSignal).
 */
function abortOnHangUp(res: http.ServerResponse): AbortController {
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  return abort;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

export interface HttpBridgeOptions {
  /** Bind address, as resolved by the daemon (utils/endpoint.ts). */
  host?: string;
  /** Port, as resolved by the daemon. 0 picks a free port (tests). */
  port?: number;
  apiToken: string;
  connectionManager: BrowserConnectionManager;
  /**
   * Resolves once the daemon can run tools (headless backend booted).
   * Rejects when it cannot start: waiting and later calls get a 500 with
   * the reason.
   */
  ready?: Promise<void>;
  /**
   * True once the daemon has begun to stop for any reason (signal, idle,
   * POST /daemon/shutdown): new tool calls and approvals get 503.
   */
  isShuttingDown?: () => boolean;
  /** Idle tracking: relay heartbeats and in-flight calls. */
  activity?: DaemonActivity;
  /** Extra fields for GET /daemon/info (authenticated). */
  info?: () => Record<string, unknown>;
  /** How long a client has to send its body (tests shorten it). */
  bodyTimeoutMs?: number;
  /** POST /daemon/shutdown (daemon/main.ts). Without it the route answers 501. */
  shutdown?: ShutdownHooks;
}

/**
 * What POST /daemon/shutdown drives. `prepare` runs the whole shutdown but
 * the exit (wait for running calls unless `force`, close the browser and the
 * WS connections) and returns the fields of the answer; `exit` is called
 * once the answer has left the socket, and ends the process — also when
 * `prepare` failed (the answer is then a 500): a daemon half shut down must
 * not stay behind refusing every call.
 *
 * `prepare` is called for every request: it must share a shutdown already
 * running (a forced request may cut its wait for running calls short).
 */
export interface ShutdownHooks {
  prepare: (opts: { force: boolean }) => Promise<Record<string, unknown>>;
  exit: () => void;
}

/** Answer to a tool call or an approval while the daemon stops (POST /daemon/shutdown, signal, idle). */
const SHUTTING_DOWN_MESSAGE = 'Inari MCP daemon is shutting down';

/** State shared by the request handlers of one server. */
interface BridgeContext {
  readonly host: string;
  readonly apiToken: string;
  readonly connectionManager: BrowserConnectionManager;
  readonly activity: DaemonActivity | undefined;
  readonly bodyTimeoutMs: number;
  readonly verifier: SignedRequestVerifier;
  /** Resolves once tools can run; rejects when the daemon cannot start. */
  readonly ready: Promise<void>;
  /** `ready` has resolved. */
  isReady: boolean;
  readonly startTime: number;
  /** Set by POST /daemon/shutdown: new tool calls are refused (503) from then on. */
  stopping: Promise<Record<string, unknown>> | undefined;
  /** Every public tool (see header comment: FOX_CAPS is applied by each relay). */
  readonly registeredTools: ReadonlySet<string>;
  /** HttpBridgeOptions.isShuttingDown (signal, idle). */
  readonly isShuttingDown: () => boolean;
  /** Extra fields for GET /daemon/info. */
  readonly info: () => Record<string, unknown>;
  /** POST /daemon/shutdown; undefined: the route answers 501. */
  readonly shutdown: ShutdownHooks | undefined;
}

function createContext(options: HttpBridgeOptions): BridgeContext {
  // The daemon resolves FOX_HOST / FOX_HTTP_PORT once (utils/endpoint.ts)
  // and passes them in; reading the env again here could disagree with it.
  const ctx: BridgeContext = {
    host: options.host ?? ENV_DEFAULTS.FOX_HOST,
    apiToken: options.apiToken,
    connectionManager: options.connectionManager,
    activity: options.activity,
    bodyTimeoutMs: options.bodyTimeoutMs ?? BODY_TIMEOUT_MS,
    verifier: new SignedRequestVerifier(options.apiToken),
    ready: options.ready ?? Promise.resolve(),
    isReady: options.ready === undefined,
    startTime: Date.now(),
    stopping: undefined,
    registeredTools: callableToolNames(),
    isShuttingDown: options.isShuttingDown ?? (() => false),
    info: options.info ?? (() => ({})),
    shutdown: options.shutdown,
  };
  ctx.ready.then(() => { ctx.isReady = true; }, () => { /* the daemon exits on failure */ });
  return ctx;
}

function shuttingDown(ctx: BridgeContext): boolean {
  return ctx.stopping !== undefined || ctx.isShuttingDown();
}

/** The tool did not run: the daemon could not start (ready rejected). */
function notStarted(err: unknown): string {
  return `Inari MCP daemon could not start: ${errorMessage(err)}`;
}

interface Caller {
  /** Audit transport label: `relay:<id>` for relays, `http` otherwise. */
  transport: string;
  relayId?: string;
}

function callerOf(req: http.IncomingMessage): Caller {
  const raw = req.headers[RELAY_ID_HEADER];
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (id && isValidRelayId(id)) return { transport: `relay:${id}`, relayId: id };
  return { transport: 'http' };
}

/** A relay request doubles as its heartbeat (idle shutdown). */
function noteCaller(ctx: BridgeContext, caller: Caller): void {
  if (caller.relayId !== undefined) ctx.activity?.noteRelay(caller.relayId);
}

/**
 * Authenticate a request whose body is known (GET: empty). On success with
 * a signed request, later answers are signed.
 */
function authenticate(ctx: BridgeContext, req: http.IncomingMessage, body: Buffer, reply: Responder): boolean {
  if (SignedRequestVerifier.isSigned(req)) {
    const nonce = ctx.verifier.verify(req, body);
    if (nonce === undefined) return false;
    reply.signWith(nonce);
    return true;
  }
  return verifyApiKey(header(req, 'x-api-key'), ctx.apiToken);
}

function route(ctx: BridgeContext, req: http.IncomingMessage, res: http.ServerResponse, reply: Responder): void {
  if (!isAllowedHostHeader(req.headers.host, ctx.host)) {
    reply.error(403, 'Host not allowed');
    return;
  }

  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    reply.error(400, 'Bad request target');
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();

  // ----- OPTIONS → 403 (CORS disabled) -----
  if (method === 'OPTIONS') {
    res.writeHead(403);
    res.end();
    return;
  }

  if (method === 'GET') {
    handleGet(ctx, pathname, req, reply);
    return;
  }

  if (method === 'POST') {
    handlePost(ctx, pathname, req, res, reply);
    return;
  }

  reply.error(405, 'Method not allowed');
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

/** GET /health — unauthenticated. Relays also call it as their heartbeat. */
function healthAnswer(ctx: BridgeContext, req: http.IncomingMessage): Record<string, unknown> {
  noteCaller(ctx, callerOf(req));
  const nonce = header(req, AUTH_HEADER.nonce);
  return {
    status: 'ok',
    service: 'inari-mcp',
    version: PACKAGE_VERSION,
    protocol: DAEMON_PROTOCOL_VERSION,
    ready: ctx.isReady,
    connected: ctx.connectionManager.hasBrowser,
    browsers_connected: ctx.connectionManager.browserCount,
    uptime: Math.floor((Date.now() - ctx.startTime) / 1000),
    ...(isNonce(nonce) ? { proof: computeMac(ctx.apiToken, MAC_LABEL.health, nonce) } : {}),
  };
}

/** GET /screenshots: each file is stat()ed once (listScreenshotEntries). */
function screenshotEntries(): Record<string, unknown>[] {
  return listScreenshotEntries().map((e) => ({
    name: e.name,
    path: e.path,
    size: e.size,
    created: new Date(e.birthtimeMs).toISOString(),
  }));
}

function handleGet(ctx: BridgeContext, pathname: string, req: http.IncomingMessage, reply: Responder): void {
  if (pathname === '/health') {
    reply.json(200, healthAnswer(ctx, req));
    return;
  }

  // All other GETs require auth
  if (!authenticate(ctx, req, Buffer.alloc(0), reply)) {
    reply.error(403, 'Unauthorized');
    return;
  }

  if (pathname === '/daemon/info') {
    reply.json(200, {
      pid: process.pid,
      version: PACKAGE_VERSION,
      protocol: DAEMON_PROTOCOL_VERSION,
      ready: ctx.isReady,
      relays: ctx.activity?.liveRelayCount() ?? 0,
      ...ctx.info(),
    });
    return;
  }

  if (pathname === '/mcp/tools') {
    const tools = [...ctx.registeredTools].flatMap((name) => {
      const info = describeTool(name);
      return info ? [{ name, ...info }] : [];
    });
    reply.json(200, { tools });
    return;
  }

  if (pathname === '/screenshots') {
    reply.json(200, { screenshots: screenshotEntries() });
    return;
  }

  reply.error(404, 'Not found');
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

/** The body as a JSON object (empty body: `{}`), or the 400 message. */
function parseJsonObject(rawBody: Buffer): { data: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.length > 0 ? rawBody.toString('utf-8') : '{}');
  } catch {
    return { error: 'Invalid JSON' };
  }
  return isRecord(parsed) ? { data: parsed } : { error: 'Request body must be a JSON object' };
}

function handlePost(
  ctx: BridgeContext,
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reply: Responder,
): void {
  // X-API-Key can be checked before reading the body; a signature covers
  // the body, so a signed request is checked once the body is in.
  const signed = SignedRequestVerifier.isSigned(req);
  if (!signed && !verifyApiKey(header(req, 'x-api-key'), ctx.apiToken)) {
    reply.error(403, 'Unauthorized');
    return;
  }

  readBody(req, ctx.bodyTimeoutMs)
    .then((rawBody) => {
      if (signed && !authenticate(ctx, req, rawBody, reply)) {
        reply.error(403, 'Unauthorized');
        return;
      }
      const body = parseJsonObject(rawBody);
      if ('error' in body) {
        reply.error(400, body.error);
        return;
      }
      routePost(ctx, pathname, signed, body.data, req, res, reply);
    })
    .catch((err: unknown) => {
      if (err instanceof BodyTooLargeError) {
        reply.error(413, `Request body too large (limit ${MAX_REQUEST_BODY_BYTES} bytes)`);
        return;
      }
      if (res.destroyed) return; // nobody left to answer
      reply.error(500, `Internal error: ${errorMessage(err)}`);
    });
}

function routePost(
  ctx: BridgeContext,
  pathname: string,
  signed: boolean,
  data: Record<string, unknown>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reply: Responder,
): void {
  if (pathname === '/mcp/call') {
    handleToolCall(ctx, data, req, res, reply);
    return;
  }

  if (pathname === '/approval/elicitation' || pathname === '/approval/browser') {
    handleApproval(ctx, pathname, data, req, res, reply);
    return;
  }

  if (pathname === '/daemon/shutdown') {
    handleShutdown(ctx, signed, data, res, reply);
    return;
  }

  reply.error(404, 'Not found');
}

/**
 * Write the answer of a call that ran. `answer` may throw (a result
 * JSON.stringify cannot encode): that is logged and answered 500 instead of
 * leaving the request open as an unhandled rejection.
 */
function sendAnswer<T>(res: http.ServerResponse, reply: Responder, answer: (result: T) => void, result: T): void {
  try {
    answer(result);
  } catch (err: unknown) {
    process.stderr.write(`[InariMCP] HTTP answer could not be written: ${errorMessage(err)}\n`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    reply.error(500, `Internal error: the answer could not be written (${errorMessage(err)})`);
  }
}

/** What runTrackedCall runs, and how it answers. */
interface TrackedCall<T> {
  /** The call itself; runs once the daemon is ready. */
  work: () => Promise<T>;
  /** Writes the answer from the result of `work`. */
  answer: (result: T) => void;
  /** Start of the 500 message when `work` throws. */
  failure: string;
}

/**
 * Run `call.work` once the daemon is ready, as an in-flight call (idle
 * tracking), cancelled when the client hangs up.
 */
function runTrackedCall<T>(
  ctx: BridgeContext,
  caller: Caller,
  res: http.ServerResponse,
  reply: Responder,
  { work, answer, failure }: TrackedCall<T>,
): void {
  const abort = abortOnHangUp(res);
  ctx.activity?.beginCall();
  ctx.ready
    .then(
      () => runWithCallSignal(abort.signal, work)
        .then(
          (result) => sendAnswer(res, reply, answer, result),
          (err: unknown) => reply.error(500, `${failure}: ${errorMessage(err)}`),
        ),
      (err: unknown) => reply.error(500, notStarted(err)),
    )
    .finally(() => {
      ctx.activity?.endCall();
      noteCaller(ctx, caller);
    });
}

// ---------------------------------------------------------------------------
// Tool call (POST /mcp/call)
// Body: { name: "fox_*", arguments?: {...} }
// ---------------------------------------------------------------------------

function handleToolCall(
  ctx: BridgeContext,
  data: Record<string, unknown>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reply: Responder,
): void {
  const caller = callerOf(req);
  noteCaller(ctx, caller);
  if (shuttingDown(ctx)) {
    reply.error(503, SHUTTING_DOWN_MESSAGE);
    return;
  }

  const toolName = data['name'];
  if (typeof toolName !== 'string' || toolName === '') {
    reply.error(400, 'Missing tool name');
    return;
  }

  const schema = callSchemaFor(toolName);
  if (!schema || !ctx.registeredTools.has(toolName)) {
    reply.error(404, `Unknown tool: ${toolName}`);
    return;
  }

  const rawArgs = data['arguments'] ?? {};
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    reply.json(400, {
      success: false,
      error: `Invalid arguments for ${toolName}`,
      code: 'INVALID_ARGUMENTS',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const args: unknown = parsed.data;
  if (!isRecord(args)) {
    reply.error(400, 'Tool arguments must be an object');
    return;
  }

  const approvalToken =
    typeof data['approvalToken'] === 'string' ? data['approvalToken'] : undefined;

  const handler = createToolHandler(toolName, caller.transport);
  runTrackedCall(ctx, caller, res, reply, {
    work: () => handler(args, { approvalToken }),
    answer: (result) => reply.json(200, { success: result.isError !== true, result }),
    failure: 'Tool execution failed',
  });
}

// ---------------------------------------------------------------------------
// Human approval (POST /approval/elicitation, POST /approval/browser)
// ---------------------------------------------------------------------------
function handleApproval(
  ctx: BridgeContext,
  pathname: string,
  data: Record<string, unknown>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reply: Responder,
): void {
  const caller = callerOf(req);
  noteCaller(ctx, caller);
  if (shuttingDown(ctx)) {
    reply.error(503, SHUTTING_DOWN_MESSAGE);
    return;
  }

  const requestId = data['requestId'];
  if (typeof requestId !== 'string' || requestId === '') {
    reply.error(400, 'Missing requestId');
    return;
  }

  if (pathname === '/approval/elicitation') {
    if (typeof data['approved'] !== 'boolean') {
      reply.error(400, 'Missing boolean "approved"');
      return;
    }
    const answer = answerFromElicitation(requestId, data['approved'], caller.transport);
    reply.json(answer.reason === 'elicitation_disabled' ? 403 : 200, { ...answer });
    return;
  }

  // Ask in the Extension's popup. When the client hangs up (the session
  // cancelled the call and the relay gave up waiting), runTrackedCall
  // aborts the call, and the popup question is withdrawn.
  runTrackedCall(ctx, caller, res, reply, {
    work: () => askBrowser(requestId, ctx.connectionManager, caller.transport),
    answer: (answer) => reply.json(200, { ...answer }),
    failure: 'Approval request failed',
  });
}

// ---------------------------------------------------------------------------
// Graceful stop (POST /daemon/shutdown)
// Body: { force?: boolean }. Signed requests only: stopping the daemon
// cuts off every session, so the X-API-Key debugging path is not enough.
// The answer is sent first; the process exits once it has left the socket.
// ---------------------------------------------------------------------------
function handleShutdown(
  ctx: BridgeContext,
  signed: boolean,
  data: Record<string, unknown>,
  res: http.ServerResponse,
  reply: Responder,
): void {
  if (!signed) {
    reply.error(403, 'POST /daemon/shutdown requires a signed request (X-API-Key is not accepted here)');
    return;
  }
  const hooks = ctx.shutdown;
  if (hooks === undefined) {
    reply.error(501, 'This daemon cannot be stopped over HTTP');
    return;
  }
  if (data['force'] !== undefined && typeof data['force'] !== 'boolean') {
    reply.error(400, '"force" must be a boolean');
    return;
  }
  const force = data['force'] === true;
  const first = ctx.stopping === undefined;
  // Every request reaches prepare(), which shares a running shutdown (see ShutdownHooks).
  const pending = Promise.resolve().then(() => hooks.prepare({ force }));
  ctx.stopping ??= pending;

  const answerThenExit = exitAfterAnswer(res, hooks.exit);
  pending.then(
    (summary) => answerThenExit(() => {
      reply.json(200, { status: 'stopping', pid: process.pid, force, repeated: !first, ...summary });
    }),
    // Exit anyway: the shutdown may have stopped halfway (browsers closed,
    // calls refused), and a daemon left like that would refuse every call.
    (err: unknown) => answerThenExit(() => {
      reply.error(500, `Shutdown failed: ${errorMessage(err)} (the daemon exits anyway)`);
    }),
  );
}

/**
 * Returns a function that sends an answer, then calls `exitHook` once the
 * answer has left the socket ('close' also covers a client that hung up).
 */
function exitAfterAnswer(res: http.ServerResponse, exitHook: () => void): (answer: () => void) => void {
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    exitHook();
  };
  return (answer) => {
    if (res.destroyed) {
      // The client gave up while running calls were drained: nobody to answer.
      setImmediate(exit);
      return;
    }
    res.once('finish', () => setImmediate(exit));
    res.once('close', () => setImmediate(exit));
    answer();
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Create the HTTP bridge server and start listening.
 *
 * The listening port doubles as the daemon's singleton lock: the promise
 * rejects with the listen error (e.g. EADDRINUSE when another daemon already
 * owns the port) instead of throwing from an unhandled 'error' event.
 *
 * @returns The http.Server instance, once it is listening.
 */
export function startHttpBridge(options: HttpBridgeOptions): Promise<http.Server> {
  const ctx = createContext(options);
  const port = options.port ?? ENV_DEFAULTS.FOX_HTTP_PORT;

  const server = http.createServer((req, res) => {
    const reply = responder(res, ctx.apiToken);
    try {
      route(ctx, req, res, reply);
    } catch (err: unknown) {
      // A bug in a route must cost one request, not the daemon.
      process.stderr.write(`[InariMCP] HTTP handler error: ${errorMessage(err)}\n`);
      reply.error(500, 'Internal error');
    }
  });

  // Tool calls may legitimately take minutes (request_approval 90 s,
  // detect_captcha 200 s, or longer with an explicit timeout argument):
  // don't let Node's default request timeout cut them off.
  server.requestTimeout = 0;
  // Explicit rather than Node's default (checked every connectionsCheckingInterval, 30 s).
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  return listen(server, port, ctx.host);
}

/** Resolves once listening; rejects with the listen error (see startHttpBridge). */
function listen(server: http.Server, port: number, host: string): Promise<http.Server> {
  return new Promise<http.Server>((resolve, reject) => {
    const onStartupError = (err: Error): void => {
      server.close();
      reject(err);
    };
    server.once('error', onStartupError);
    server.listen(port, host, () => {
      server.removeListener('error', onStartupError);
      server.on('error', (err) => {
        process.stderr.write(`[InariMCP] HTTP server error: ${err.message}\n`);
      });
      // The port actually bound (port 0 picks a free one).
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      process.stderr.write(
        `[InariMCP] HTTP bridge listening on http://${host}:${boundPort}\n`,
      );
      resolve(server);
    });
  });
}
