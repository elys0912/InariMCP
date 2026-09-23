/**
 * KitsuneMCP — MCP server entry point.
 *
 * Boots the MCP JSON-RPC server (stdio transport), HTTP API bridge,
 * and WebSocket bridge.  Equivalent to server.py main() (L1562-1596).
 *
 * stderr is the only output channel for log messages — stdout is
 * reserved for the MCP JSON-RPC stream.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type * as http from 'node:http';
import type { WebSocketServer } from 'ws';

import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';
import { registerTools } from './tools/registry.js';
import { startHttpBridge, loadOrCreateApiToken } from './transport/http-bridge.js';
import { startWebSocketServer } from './transport/ws-bridge.js';
import { getConnectionManager } from './connection/manager.js';
import { getHeadlessBrowser } from './headless/backend.js';

// ---------------------------------------------------------------------------
// Version — read from package.json at build time via TS const
// ---------------------------------------------------------------------------

const PACKAGE_VERSION = '0.1.0';
const SERVER_NAME = 'kitsune-mcp';

// ---------------------------------------------------------------------------
// Port resolution helpers
// ---------------------------------------------------------------------------

function resolveHttpPort(): number {
  const raw =
    process.env[ENV.FOX_HTTP_PORT] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HTTP_PORT];
  if (raw) {
    const n = Number(raw);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return ENV_DEFAULTS.FOX_HTTP_PORT;
}

function resolveWsPort(): number {
  const raw =
    process.env[ENV.FOX_WS_PORT] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_WS_PORT];
  if (raw) {
    const n = Number(raw);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return ENV_DEFAULTS.FOX_WS_PORT;
}

function resolveHost(): string {
  return (
    process.env[ENV.FOX_HOST] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HOST] ??
    ENV_DEFAULTS.FOX_HOST
  );
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

function printBanner(toolCount: number, httpPort: number, wsPort: number): void {
  const caps = process.env[ENV.FOX_CAPS] || 'all';
  const lines = [
    `[KitsuneMCP] ${SERVER_NAME} v${PACKAGE_VERSION}`,
    `[KitsuneMCP] HTTP  : ${resolveHost()}:${httpPort}`,
    `[KitsuneMCP] WS    : ${resolveHost()}:${wsPort}`,
    `[KitsuneMCP] Tools : ${toolCount} registered (FOX_CAPS=${caps})`,
  ];
  if (process.env[ENV.FOX_HEADLESS]) {
    lines.push(`[KitsuneMCP] Mode  : headless`);
  }
  process.stderr.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Handles held by main() for graceful shutdown. */
interface ServerHandles {
  httpServer: http.Server;
  wsServer: WebSocketServer;
}

async function main(): Promise<void> {
  // --- Connection manager (singleton) ---
  const connectionManager = getConnectionManager();

  // --- API token ---
  const apiToken = loadOrCreateApiToken();

  // --- Port / host resolution ---
  const httpPort = resolveHttpPort();
  const wsPort = resolveWsPort();
  const host = resolveHost();

  // --- MCP server (JSON-RPC over stdio) ---
  const mcpServer = new McpServer(
    { name: SERVER_NAME, version: PACKAGE_VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const toolCount = registerTools(mcpServer);

  // --- Headless mode ---
  if (process.env[ENV.FOX_HEADLESS]) {
    const { initHeadlessBrowser } = await import('./headless/backend.js');
    const headless = await initHeadlessBrowser();

    connectionManager.registerBrowser('headless', (message: string) => {
      const command = JSON.parse(message) as { action: string; tabId?: number; data?: Record<string, unknown>; requestId: string };
      headless.execute(command.action, command.tabId, command.data ?? {})
        .then((result) => {
          connectionManager.handleResponse({
            requestId: command.requestId,
            success: (result as Record<string, unknown>).success === true,
            data: result,
            error: typeof (result as Record<string, unknown>).error === 'string'
              ? (result as Record<string, unknown>).error as string
              : undefined,
          });
        })
        .catch((err: unknown) => {
          connectionManager.handleResponse({
            requestId: command.requestId,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }

  // --- HTTP bridge ---
  const httpServer = startHttpBridge({
    host,
    port: httpPort,
    apiToken,
    connectionManager,
  });

  // --- WebSocket bridge ---
  const wsServer = startWebSocketServer({
    host,
    port: wsPort,
    apiToken,
    connectionManager,
  });

  // --- Stdio transport (connects MCP JSON-RPC) ---
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // --- Banner ---
  printBanner(toolCount, httpPort, wsPort);

  // --- Graceful shutdown ---
  setupShutdown({ httpServer, wsServer }, connectionManager, mcpServer);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdown(
  handles: ServerHandles,
  connectionManager: ReturnType<typeof getConnectionManager>,
  mcpServer: McpServer,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    process.stderr.write(`[KitsuneMCP] ${signal} received — shutting down\n`);

    // 1. Close MCP server (stdio transport)
    try {
      await mcpServer.close();
    } catch {
      // Best-effort
    }

    // 2. Close HTTP server
    handles.httpServer.close();

    // 3. Close WebSocket server
    handles.wsServer.close();

    // 4. Stop headless browser (if running)
    const headless = getHeadlessBrowser();
    if (headless) {
      try {
        await headless.stop();
      } catch {
        // Best-effort
      }
    }

    // 5. Drain connection manager
    connectionManager.shutdown();

    process.stderr.write('[KitsuneMCP] Shutdown complete\n');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  process.stderr.write(
    `[KitsuneMCP] FATAL uncaughtException: ${err.message}\n${err.stack ?? ''}\n`,
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
  process.stderr.write(`[KitsuneMCP] FATAL unhandledRejection: ${msg}\n`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[KitsuneMCP] Failed to start: ${msg}\n`);
  process.exit(1);
});
