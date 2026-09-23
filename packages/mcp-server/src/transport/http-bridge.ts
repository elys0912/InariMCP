/**
 * HTTP API server (transport bridge).
 *
 * Uses Node.js standard `http` module — no Express, no external dependencies.
 * Provides the REST endpoints that the Native Host, Extension (polling mode),
 * and local debug tools consume.
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
import * as os from 'node:os';
import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';
import type { BrowserCommand } from '@kitsune-mcp/shared';
import type { BrowserConnectionManager } from '../connection/manager.js';
import { getScreenshotsDir, listScreenshots } from '../utils/screenshot.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_VERSION = '0.1.0';
const MAX_BODY_BYTES = 1_048_576; // 1 MB — generous for any JSON payload

// ---------------------------------------------------------------------------
// API token management
// ---------------------------------------------------------------------------

function getTokenPath(): string {
  return path.join(os.homedir(), '.kitsune-mcp', 'api_token');
}

/**
 * Load or generate the API token.
 *
 * - Reads from `~/.kitsune-mcp/api_token` if it exists.
 * - Otherwise generates a 64-char hex token via crypto.randomBytes(32)
 *   and persists it.
 */
export function loadOrCreateApiToken(): string {
  const tokenPath = getTokenPath();

  try {
    if (fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, 'utf-8').trim();
      if (token.length > 0) return token;
    }
  } catch {
    // Fall through to generation
  }

  const token = crypto.randomBytes(32).toString('hex');
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  process.stderr.write(`[KitsuneMCP] Generated new API token at ${tokenPath}\n`);
  return token;
}

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
}

/**
 * Create and start the HTTP bridge server.
 *
 * @returns The http.Server instance (already listening).
 */
export function startHttpBridge(options: HttpBridgeOptions): http.Server {
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

  const { apiToken, connectionManager } = options;
  const startTime = Date.now();

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
    // /health — unauthenticated
    if (pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version: PACKAGE_VERSION,
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

    if (pathname === '/mcp/tools') {
      // TODO: P3-3 でツールレジストリ統合 — 現在は空リスト
      sendJson(res, 200, { tools: [] });
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

    if (pathname === '/browser/poll') {
      const queue = connectionManager.pendingCommands;
      if (queue.length > 0) {
        const command = queue.shift()!;
        sendJson(res, 200, { command, has_more: queue.length > 0 });
      } else {
        sendJson(res, 200, { command: null, has_more: false });
      }
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

        if (pathname === '/mcp/call') {
          // TODO: P3-3 でツールハンドラ統合
          const toolName = data['name'] as string | undefined;
          if (!toolName) {
            sendError(res, 400, 'Missing tool name');
            return;
          }
          sendJson(res, 501, {
            success: false,
            error: 'Tool execution not yet implemented (P3-3)',
          });
          return;
        }

        if (pathname === '/browser/command') {
          const action = data['action'] as string | undefined;
          if (!action) {
            sendError(res, 400, 'Missing action');
            return;
          }
          // Queue for Extension polling / direct WebSocket dispatch
          const command: BrowserCommand = {
            action: action as BrowserCommand['action'],
            requestId: String(Date.now()),
            ...(data['tabId'] != null ? { tabId: data['tabId'] as number } : {}),
            ...(data['data'] != null ? { data: data['data'] as Record<string, unknown> } : {}),
          };
          connectionManager.pendingCommands.push(command);
          sendJson(res, 200, {
            success: true,
            message: 'Command queued',
            action,
          });
          return;
        }

        if (pathname === '/browser/response') {
          const requestId = data['requestId'] as string | undefined;
          if (!requestId) {
            sendError(res, 400, 'Missing requestId');
            return;
          }
          connectionManager.handleResponse({
            requestId,
            success: data['success'] as boolean ?? false,
            data: data['data'],
            error: data['error'] as string | undefined,
          });
          sendJson(res, 200, { success: true });
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
  // Start listening
  // -----------------------------------------------------------------------
  server.listen(port, host, () => {
    process.stderr.write(
      `[KitsuneMCP] HTTP bridge listening on http://${host}:${port}\n`,
    );
  });

  return server;
}
