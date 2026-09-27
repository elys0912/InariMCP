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
 * relay, not a daemon-side restriction (design.md 4.1.1). Policy
 * restrictions live in the SafetyGuard (safety.json / FOX_READ_ONLY /
 * FOX_ALLOW_SCRIPTS) and apply to every caller alike.
 *
 * A relay identifies itself with the `X-Kitsune-Relay: <id>` header; its
 * calls are audited with transport `relay:<id>` (other callers: `http`).
 *
 * Fork-source: server.py L885-1460 MCPHTTPHandler
 *
 * Security:
 *  - All authenticated routes use X-API-Key + crypto.timingSafeEqual()
 *  - /health is unauthenticated (probe endpoint)
 *  - OPTIONS returns 403 (no CORS headers — all callers are local processes)
 *  - Listens on 127.0.0.1 only
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';
import type { BrowserConnectionManager } from '../connection/manager.js';
import { getScreenshotsDir, listScreenshots } from '../utils/screenshot.js';
import { TOOL_SCHEMAS } from '../tools/schemas.js';
import { getRegisteredToolNames } from '../tools/registry.js';
import { createToolHandler } from '../tools/handlers.js';
import { RELAY_ID_HEADER, isValidRelayId } from '../utils/endpoint.js';
import type { DaemonActivity } from '../daemon/activity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_VERSION = '0.1.0';
const MAX_BODY_BYTES = 1_048_576; // 1 MB — generous for any JSON payload

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of the provided key against the server token.
 *
 * When lengths differ, performs a dummy comparison to prevent timing leaks
 * from the length check itself (design.md 7.3).
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

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: Record<string, unknown>,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// Body reader
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

export interface HttpBridgeOptions {
  host?: string;
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
  const host =
    process.env[ENV.FOX_HOST] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HOST] ??
    options.host ??
    ENV_DEFAULTS.FOX_HOST;

  const port = (() => {
    const envPort =
      process.env[ENV.FOX_HTTP_PORT] ??
      process.env[LEGACY_ENV.CLAUDE_BROWSER_HTTP_PORT];
    if (envPort) {
      const parsed = Number(envPort);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return options.port ?? ENV_DEFAULTS.FOX_HTTP_PORT;
  })();

  const { apiToken, connectionManager, activity } = options;
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
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // ----- OPTIONS → 403 (CORS disabled) -----
    if (method === 'OPTIONS') {
      res.writeHead(403);
      res.end();
      return;
    }

    // ----- GET routes -----
    if (method === 'GET') {
      handleGet(pathname, req, res);
      return;
    }

    // ----- POST routes -----
    if (method === 'POST') {
      handlePost(pathname, req, res);
      return;
    }

    sendError(res, 405, 'Method not allowed');
  });

  // -----------------------------------------------------------------------
  // GET handler
  // -----------------------------------------------------------------------
  function handleGet(
    pathname: string,
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // /health — unauthenticated. Relays also call it as their heartbeat.
    if (pathname === '/health') {
      const { relayId } = callerOf(_req);
      if (relayId !== undefined) activity?.noteRelay(relayId);
      sendJson(res, 200, {
        status: 'ok',
        service: 'kitsune-mcp',
        version: PACKAGE_VERSION,
        ready: isReady,
        connected: connectionManager.hasBrowser,
        browsers_connected: connectionManager.browserCount,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
      return;
    }

    // All other GETs require auth
    if (!verifyApiKey(_req.headers['x-api-key'] as string | undefined, apiToken)) {
      sendError(res, 403, 'Unauthorized');
      return;
    }

    if (pathname === '/daemon/info') {
      sendJson(res, 200, {
        pid: process.pid,
        version: PACKAGE_VERSION,
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
      sendJson(res, 200, { tools });
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
      sendJson(res, 200, { screenshots });
      return;
    }

    sendError(res, 404, 'Not found');
  }

  // -----------------------------------------------------------------------
  // POST handler
  // -----------------------------------------------------------------------
  function handlePost(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Auth check for all POSTs
    if (!verifyApiKey(req.headers['x-api-key'] as string | undefined, apiToken)) {
      sendError(res, 403, 'Unauthorized');
      return;
    }

    readBody(req)
      .then((rawBody) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(rawBody || '{}') as Record<string, unknown>;
        } catch {
          sendError(res, 400, 'Invalid JSON');
          return;
        }

        // /browser/command is kept as an alias of /mcp/call. It used to take
        // a raw browser action and queue it unchecked; raw actions skipped
        // SafetyGuard, containerScope and zod validation, and mapping an
        // action back to a tool is ambiguous (screenshot ← viewport/full_page,
        // navigate ← goto/back/forward/…). Both now take a tool call.
        if (pathname === '/mcp/call' || pathname === '/browser/command') {
          handleToolCall(pathname, data, req, res);
          return;
        }

        sendError(res, 404, 'Not found');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 500, `Internal error: ${msg}`);
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
  ): void {
    const caller = callerOf(req);
    if (caller.relayId !== undefined) activity?.noteRelay(caller.relayId);

    const toolName = data['name'];
    if (typeof toolName !== 'string' || !toolName) {
      if (pathname === '/browser/command' && typeof data['action'] === 'string') {
        sendError(
          res,
          400,
          'Raw browser actions are no longer accepted. Send a tool call instead: ' +
          '{ "name": "fox_<tool>", "arguments": { ... } } (see GET /mcp/tools).',
        );
        return;
      }
      sendError(res, 400, 'Missing tool name');
      return;
    }

    const def = TOOL_SCHEMAS[toolName];
    if (!def || !registeredTools.has(toolName)) {
      sendError(res, 404, `Unknown tool: ${toolName}`);
      return;
    }

    const rawArgs = data['arguments'] ?? {};
    const parsed = def.inputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      sendJson(res, 400, {
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
      sendError(res, 400, 'Tool arguments must be an object');
      return;
    }

    const handler = createToolHandler(toolName, caller.transport);
    activity?.beginCall();
    ready
      .then(() => handler(args as Record<string, unknown>))
      .then((result) => {
        sendJson(res, 200, { success: result.isError !== true, result });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, 500, `Tool execution failed: ${msg}`);
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
