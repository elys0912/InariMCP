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
 * Tool execution over HTTP (POST /mcp/call, and its alias POST
 * /browser/command): zod validation against TOOL_SCHEMAS[name].inputSchema ->
 * createToolHandler (SafetyGuard.check, containerScope /
 * protectedUrlPatterns attachment, post-processing). Every tool is
 * reachable: FOX_CAPS is a per-session tools/list setting applied by each
 * relay, not a daemon-side restriction. Policy
 * restrictions live in the SafetyGuard (safety.json / FOX_READ_ONLY /
 * FOX_ALLOW_SCRIPTS) and apply to every caller alike.
 *
 * A relay identifies itself with the `X-Kitsune-Relay: <id>` header; its
 * calls are audited with transport `relay:<id>` (other callers: `http`).
 * When the caller goes away before the answer (relay abort / timeout), the
 * browser commands of that call are cancelled (runWithCallSignal).
 *
 * Human approval of protected-site actions (tools/approval-flow.ts):
 *  - POST /mcp/call may carry `approvalToken` next to `arguments` (never a
 *    tool argument, so the LLM does not see or pass it).
 *  - POST /approval/elicitation { requestId, approved } — the relay reports
 *    the human's answer to its MCP elicitation. 403 when
 *    FOX_APPROVAL_ELICITATION is off.
 *  - POST /approval/browser { requestId } — ask in the Extension's popup
 *    and wait for the answer.
 *  Both answer { success, approved, reason, approvalToken?, expiresAt? }.
 *
 * Fork-source: server.py L885-1460 MCPHTTPHandler
 *
 * Security:
 *  - Authenticated routes accept either
 *      a signed request (x-kitsune-timestamp / -nonce / -signature, see
 *      auth.ts) — what the relays and the Native Host send; the token never
 *      travels, and the response carries our own signature so the client
 *      can tell the daemon from a program squatting on the port; or
 *      X-API-Key: <token> — for manual debugging (curl). Compared with
 *      crypto.timingSafeEqual(); responses are not signed.
 *  - /health is unauthenticated (probe endpoint). With x-kitsune-nonce it
 *    adds `proof`, a MAC over that nonce, so a client holding the token can
 *    check it is talking to the real daemon.
 *  - Host header must be `localhost`, an IP literal or the configured host
 *    (a DNS-rebinding page always uses some other name).
 *  - OPTIONS returns 403 (no CORS headers — all callers are local processes)
 *  - Listens on 127.0.0.1 unless FOX_HOST says otherwise (daemon/main.ts
 *    warns about non-loopback addresses)
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import { runWithCallSignal, type BrowserConnectionManager } from '../connection/manager.js';
import { getScreenshotsDir, listScreenshots } from '../utils/screenshot.js';
import { TOOL_SCHEMAS } from '../tools/schemas.js';
import { getRegisteredToolNames } from '../tools/registry.js';
import { createToolHandler } from '../tools/handlers.js';
import { answerFromElicitation, askBrowser } from '../tools/approval-flow.js';
import { RELAY_ID_HEADER, isValidRelayId } from '../utils/endpoint.js';
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
} from './auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_VERSION = '0.1.0';
const MAX_BODY_BYTES = 1_048_576; // 1 MB — generous for any JSON payload
/** How much of an oversized body is read (and dropped) so the 413 gets through. */
const MAX_DRAIN_BYTES = 16 * MAX_BODY_BYTES;
/** Upper bound of remembered nonces (far above any real request rate). */
const MAX_REMEMBERED_NONCES = 100_000;

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
 */
export class SignedRequestVerifier {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly token: string,
    private readonly windowMs: number = HTTP_SIGNATURE_WINDOW_MS,
  ) {}

  /** True when the request carries signature headers at all. */
  static isSigned(req: http.IncomingMessage): boolean {
    return header(req, AUTH_HEADER.signature) !== undefined;
  }

  /** @returns the request nonce when valid (needed to sign the response), else undefined. */
  verify(req: http.IncomingMessage, body: Buffer, now: number = Date.now()): string | undefined {
    const timestamp = header(req, AUTH_HEADER.timestamp);
    const nonce = header(req, AUTH_HEADER.nonce);
    const signature = header(req, AUTH_HEADER.signature);
    if (timestamp === undefined || !/^\d{1,16}$/.test(timestamp) || !isNonce(nonce)) return undefined;
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

    this.prune(now);
    if (this.seen.has(nonce) || this.seen.size >= MAX_REMEMBERED_NONCES) return undefined;
    this.seen.set(nonce, now + 2 * this.windowMs);
    return nonce;
  }

  private prune(now: number): void {
    for (const [nonce, expiry] of this.seen) {
      if (expiry > now) break; // insertion order = expiry order
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
 * Read the request body (at most MAX_BODY_BYTES).
 *
 * On overflow the rest of the body is read and discarded, and the promise
 * rejects with BodyTooLargeError only once the client has finished sending:
 * answering (and closing) while it is still writing would reset the
 * connection, and the client would never see the 413. A client that keeps
 * sending past MAX_DRAIN_BYTES is cut off instead.
 */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const declared = Number(req.headers['content-length']);
    let overflow = Number.isFinite(declared) && declared > MAX_BODY_BYTES;

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (overflow) {
        if (totalLength > MAX_DRAIN_BYTES) req.destroy();
        return;
      }
      if (totalLength > MAX_BODY_BYTES) {
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
  /** Resolves once the daemon can run tools (headless backend booted). */
  ready?: Promise<void>;
  /** Idle tracking: relay heartbeats and in-flight calls. */
  activity?: DaemonActivity;
  /** Extra fields for GET /daemon/info (authenticated). */
  info?: () => Record<string, unknown>;
}

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
  // The daemon resolves FOX_HOST / FOX_HTTP_PORT once (utils/endpoint.ts)
  // and passes them in; reading the env again here could disagree with it.
  const host = options.host ?? ENV_DEFAULTS.FOX_HOST;
  const port = options.port ?? ENV_DEFAULTS.FOX_HTTP_PORT;

  const { apiToken, connectionManager, activity } = options;
  const verifier = new SignedRequestVerifier(apiToken);
  const ready = options.ready ?? Promise.resolve();
  let isReady = options.ready === undefined;
  ready.then(() => { isReady = true; }, () => { /* the daemon exits on failure */ });
  const startTime = Date.now();

  // Every tool (see header comment: FOX_CAPS is applied by each relay).
  const registeredTools = getRegisteredToolNames('all');

  /** Audit transport label: `relay:<id>` for relays, `http` otherwise. */
  const callerOf = (req: http.IncomingMessage): { transport: string; relayId?: string } => {
    const raw = req.headers[RELAY_ID_HEADER];
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && isValidRelayId(id)) return { transport: `relay:${id}`, relayId: id };
    return { transport: 'http' };
  };

  const server = http.createServer((req, res) => {
    const reply = responder(res, apiToken);
    try {
      route(req, res, reply);
    } catch (err: unknown) {
      // A bug in a route must cost one request, not the daemon.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[KitsuneMCP] HTTP handler error: ${msg}\n`);
      reply.error(500, 'Internal error');
    }
  });

  function route(req: http.IncomingMessage, res: http.ServerResponse, reply: Responder): void {
    if (!isAllowedHostHeader(req.headers.host, host)) {
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
      handleGet(pathname, req, reply);
      return;
    }

    if (method === 'POST') {
      handlePost(pathname, req, res, reply);
      return;
    }

    reply.error(405, 'Method not allowed');
  }

  /**
   * Authenticate a request whose body is known (GET: empty). On success with
   * a signed request, later answers are signed.
   */
  function authenticate(req: http.IncomingMessage, body: Buffer, reply: Responder): boolean {
    if (SignedRequestVerifier.isSigned(req)) {
      const nonce = verifier.verify(req, body);
      if (nonce === undefined) return false;
      reply.signWith(nonce);
      return true;
    }
    return verifyApiKey(header(req, 'x-api-key'), apiToken);
  }

  // -----------------------------------------------------------------------
  // GET handler
  // -----------------------------------------------------------------------
  function handleGet(pathname: string, req: http.IncomingMessage, reply: Responder): void {
    // /health — unauthenticated. Relays also call it as their heartbeat.
    if (pathname === '/health') {
      const { relayId } = callerOf(req);
      if (relayId !== undefined) activity?.noteRelay(relayId);
      const nonce = header(req, AUTH_HEADER.nonce);
      reply.json(200, {
        status: 'ok',
        service: 'kitsune-mcp',
        version: PACKAGE_VERSION,
        protocol: DAEMON_PROTOCOL_VERSION,
        ready: isReady,
        connected: connectionManager.hasBrowser,
        browsers_connected: connectionManager.browserCount,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        ...(isNonce(nonce) ? { proof: computeMac(apiToken, MAC_LABEL.health, nonce) } : {}),
      });
      return;
    }

    // All other GETs require auth
    if (!authenticate(req, Buffer.alloc(0), reply)) {
      reply.error(403, 'Unauthorized');
      return;
    }

    if (pathname === '/daemon/info') {
      reply.json(200, {
        pid: process.pid,
        version: PACKAGE_VERSION,
        protocol: DAEMON_PROTOCOL_VERSION,
        ready: isReady,
        relays: activity?.liveRelayCount() ?? 0,
        ...(options.info?.() ?? {}),
      });
      return;
    }

    if (pathname === '/mcp/tools') {
      const tools = [...registeredTools].flatMap((name) => {
        const def = TOOL_SCHEMAS[name];
        return def
          ? [{ name: def.name, description: def.description, classification: def.classification }]
          : [];
      });
      reply.json(200, { tools });
      return;
    }

    if (pathname === '/screenshots') {
      const dir = getScreenshotsDir();
      const names = listScreenshots();
      const screenshots = names.map((name) => {
        const fullPath = path.join(dir, name);
        try {
          const stat = fs.statSync(fullPath);
          return {
            name,
            path: fullPath,
            size: stat.size,
            created: new Date(stat.birthtimeMs).toISOString(),
          };
        } catch {
          return { name, path: fullPath, size: 0, created: '' };
        }
      });
      reply.json(200, { screenshots });
      return;
    }

    reply.error(404, 'Not found');
  }

  // -----------------------------------------------------------------------
  // POST handler
  // -----------------------------------------------------------------------
  function handlePost(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reply: Responder,
  ): void {
    // X-API-Key can be checked before reading the body; a signature covers
    // the body, so a signed request is checked once the body is in.
    const signed = SignedRequestVerifier.isSigned(req);
    if (!signed && !verifyApiKey(header(req, 'x-api-key'), apiToken)) {
      reply.error(403, 'Unauthorized');
      return;
    }

    readBody(req)
      .then((rawBody) => {
        if (signed && !authenticate(req, rawBody, reply)) {
          reply.error(403, 'Unauthorized');
          return;
        }

        let data: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(rawBody.length > 0 ? rawBody.toString('utf-8') : '{}');
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reply.error(400, 'Request body must be a JSON object');
            return;
          }
          data = parsed as Record<string, unknown>;
        } catch {
          reply.error(400, 'Invalid JSON');
          return;
        }

        // /browser/command is kept as an alias of /mcp/call. It used to take
        // a raw browser action and queue it unchecked; raw actions skipped
        // SafetyGuard, containerScope and zod validation, and mapping an
        // action back to a tool is ambiguous (screenshot ← viewport/full_page,
        // navigate ← goto/back/forward/…). Both now take a tool call.
        if (pathname === '/mcp/call' || pathname === '/browser/command') {
          handleToolCall(pathname, data, req, res, reply);
          return;
        }

        if (pathname === '/approval/elicitation' || pathname === '/approval/browser') {
          handleApproval(pathname, data, req, res, reply);
          return;
        }

        reply.error(404, 'Not found');
      })
      .catch((err: unknown) => {
        if (err instanceof BodyTooLargeError) {
          reply.error(413, `Request body too large (limit ${MAX_BODY_BYTES} bytes)`);
          return;
        }
        if (res.destroyed) return; // nobody left to answer
        const msg = err instanceof Error ? err.message : String(err);
        reply.error(500, `Internal error: ${msg}`);
      });
  }

  // -----------------------------------------------------------------------
  // Tool call (POST /mcp/call, POST /browser/command)
  // Body: { name: "fox_*", arguments?: {...} }
  // -----------------------------------------------------------------------
  function handleToolCall(
    pathname: string,
    data: Record<string, unknown>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reply: Responder,
  ): void {
    const caller = callerOf(req);
    if (caller.relayId !== undefined) activity?.noteRelay(caller.relayId);

    const toolName = data['name'];
    if (typeof toolName !== 'string' || !toolName) {
      if (pathname === '/browser/command' && typeof data['action'] === 'string') {
        reply.error(
          400,
          'Raw browser actions are no longer accepted. Send a tool call instead: ' +
          '{ "name": "fox_<tool>", "arguments": { ... } } (see GET /mcp/tools).',
        );
        return;
      }
      reply.error(400, 'Missing tool name');
      return;
    }

    const def = TOOL_SCHEMAS[toolName];
    if (!def || !registeredTools.has(toolName)) {
      reply.error(404, `Unknown tool: ${toolName}`);
      return;
    }

    const rawArgs = data['arguments'] ?? {};
    const parsed = def.inputSchema.safeParse(rawArgs);
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
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      reply.error(400, 'Tool arguments must be an object');
      return;
    }

    const approvalToken =
      typeof data['approvalToken'] === 'string' ? data['approvalToken'] : undefined;

    const abort = abortOnHangUp(res);

    const handler = createToolHandler(toolName, caller.transport);
    activity?.beginCall();
    ready
      .then(() => runWithCallSignal(abort.signal, () => handler(args as Record<string, unknown>, { approvalToken })))
      .then((result) => {
        reply.json(200, { success: result.isError !== true, result });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        reply.error(500, `Tool execution failed: ${msg}`);
      })
      .finally(() => {
        activity?.endCall();
        if (caller.relayId !== undefined) activity?.noteRelay(caller.relayId);
      });
  }

  // -----------------------------------------------------------------------
  // Human approval (POST /approval/elicitation, POST /approval/browser)
  // -----------------------------------------------------------------------
  function handleApproval(
    pathname: string,
    data: Record<string, unknown>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reply: Responder,
  ): void {
    const caller = callerOf(req);
    if (caller.relayId !== undefined) activity?.noteRelay(caller.relayId);

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

    // The relay gave up waiting (session cancelled the call): withdraw the popup question.
    const abort = abortOnHangUp(res);
    activity?.beginCall();
    ready
      .then(() => runWithCallSignal(abort.signal, () => askBrowser(requestId, connectionManager, caller.transport)))
      .then((answer) => reply.json(200, { ...answer }))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        reply.error(500, `Approval request failed: ${msg}`);
      })
      .finally(() => {
        activity?.endCall();
        if (caller.relayId !== undefined) activity?.noteRelay(caller.relayId);
      });
  }

  // -----------------------------------------------------------------------
  // Start listening
  // -----------------------------------------------------------------------
  // Tool calls may legitimately take minutes (request_approval 90 s,
  // detect_captcha 200 s, or longer with an explicit timeout argument):
  // don't let Node's default request timeout cut them off.
  server.requestTimeout = 0;

  return new Promise<http.Server>((resolve, reject) => {
    const onStartupError = (err: Error): void => {
      server.close();
      reject(err);
    };
    server.once('error', onStartupError);
    server.listen(port, host, () => {
      server.removeListener('error', onStartupError);
      server.on('error', (err) => {
        process.stderr.write(`[KitsuneMCP] HTTP server error: ${err.message}\n`);
      });
      process.stderr.write(
        `[KitsuneMCP] HTTP bridge listening on http://${host}:${port}\n`,
      );
      resolve(server);
    });
  });
}
