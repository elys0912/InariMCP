/**
 * KitsuneMCP Native Messaging Host — main entry point.
 *
 * Bridges the Firefox Extension (stdin/stdout, Native Messaging protocol)
 * and the MCP Server (WebSocket client to its ws-bridge):
 *
 *   MCP Server ──WS──▶ Native Host ──Native Messaging──▶ Extension
 *   MCP Server ◀──WS── Native Host ◀──Native Messaging── Extension
 *
 * Commands from the server are passed to the Extension unmodified. Responses
 * from the Extension have their screenshot data URLs saved to disk and
 * replaced by `imagePath` before they go back to the server.
 */

import { readMessage, sendMessage } from './protocol.js';
import { ServerLauncher, serverEntryPath, type DaemonInfo } from './server-launcher.js';
import { ServerConnection } from './ws-client.js';
import { HealthMonitor } from './health-monitor.js';
import { externalizeScreenshots, saveScreenshot } from './screenshot-store.js';
import { activeLogPath, log } from './logger.js';

// ---------------------------------------------------------------------------
// In-flight command bookkeeping (for screenshot filenames)
// ---------------------------------------------------------------------------

interface InFlight {
  action: string;
  filename: string | undefined;
  sentAt: number;
}

/** requestId → command info, so a response can reuse the requested filename. */
const inFlight = new Map<string, InFlight>();
/** Entries older than this are assumed abandoned (longest server timeout is 200 s). */
const IN_FLIGHT_TTL_MS = 10 * 60_000;

function pruneInFlight(now: number): void {
  for (const [id, entry] of inFlight) {
    if (now - entry.sentAt > IN_FLIGHT_TTL_MS) inFlight.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Server → Extension
// ---------------------------------------------------------------------------

function handleServerCommand(
  command: Record<string, unknown>,
  connection: ServerConnection,
): void {
  const requestId = String(command['requestId']);
  const action = String(command['action']);
  log(`command from server: ${action} (requestId ${requestId})`);

  const data = command['data'];
  const filename =
    typeof data === 'object' && data !== null && !Array.isArray(data) &&
    typeof (data as Record<string, unknown>)['filename'] === 'string'
      ? (data as Record<string, string>)['filename']
      : undefined;

  const now = Date.now();
  pruneInFlight(now);
  inFlight.set(requestId, { action, filename, sentAt: now });

  // Forward unmodified.
  if (!sendMessage(command)) {
    inFlight.delete(requestId);
    connection.send({
      requestId,
      success: false,
      error: 'Command exceeds the 1 MB Native Messaging limit (host → extension)',
    });
  }
}

// ---------------------------------------------------------------------------
// Extension → Server / local handling
// ---------------------------------------------------------------------------

/**
 * The `claude mcp add` command for this checkout, quoted for the platform's
 * usual shell (same form as the installers print).
 */
function claudeRegisterCommand(): string {
  const entry = serverEntryPath();
  const quoted = process.platform === 'win32'
    ? `"${entry}"`
    : `'${entry.replace(/'/g, `'\\''`)}'`;
  return `claude mcp add --scope user kitsune-mcp -- node ${quoted}`;
}

function replyToExtension(
  message: Record<string, unknown>,
  body: Record<string, unknown>,
): void {
  sendMessage({
    ...body,
    ...(message['requestId'] !== undefined ? { requestId: message['requestId'] } : {}),
  });
}

function processMessage(
  message: Record<string, unknown>,
  launcher: ServerLauncher,
  connection: ServerConnection,
): void {
  const action = typeof message['action'] === 'string' ? message['action'] : undefined;

  // Response to a server command (has requestId, no action) → WS to server
  if (message['requestId'] !== undefined && action === undefined) {
    const requestId = String(message['requestId']);
    const entry = inFlight.get(requestId);
    inFlight.delete(requestId);

    externalizeScreenshots(message, entry?.filename, log);

    if (!connection.send(message)) {
      log(`dropping response for requestId ${requestId}: not connected to MCP server`);
    } else {
      log(`response for ${entry?.action ?? 'unknown'} (requestId ${requestId}) sent to server`);
    }
    return;
  }

  // Local commands initiated by the Extension itself
  if (action === 'ping') {
    replyToExtension(message, {
      action: 'pong',
      pong: true,
      success: true,
      timestamp: Date.now() / 1000,
    });
    return;
  }

  if (action === 'status') {
    const reply = (available: boolean, daemon: DaemonInfo | null): void => {
      replyToExtension(message, {
        success: true,
        mcp_server: {
          url: `http://${launcher.host}:${launcher.httpPort}`,
          available,
          ws: { url: connection.url, connected: connection.isConnected },
          // null when /daemon/info could not be read (daemon down, no token)
          relays: daemon?.relays ?? null,
          ...(daemon?.version !== undefined ? { version: daemon.version } : {}),
        },
        native_host: {
          version: '0.1.0',
          pid: process.pid,
        },
        // Shown by the popup when no Claude Code session is connected.
        claude_register_command: claudeRegisterCommand(),
      });
    };
    Promise.all([launcher.checkHealth(), launcher.fetchDaemonInfo()])
      .then(([available, daemon]) => reply(available, daemon))
      .catch(() => reply(false, null));
    return;
  }

  // Screenshots the Extension took on its own (popup / context menu): these
  // are not MCP tool calls, so they are only saved locally.
  if (action === 'saveScreenshot' || action === 'screenshotTaken') {
    const data = message['data'];
    const imageData =
      typeof data === 'string'
        ? data
        : typeof data === 'object' && data !== null && !Array.isArray(data) &&
          typeof (data as Record<string, unknown>)['imageData'] === 'string'
          ? (data as Record<string, string>)['imageData']
          : undefined;
    const filename = typeof message['filename'] === 'string' ? message['filename'] : undefined;

    if (imageData === undefined) {
      replyToExtension(message, { success: false, error: 'no image data' });
      return;
    }
    try {
      const imagePath = saveScreenshot(imageData, filename);
      log(`${action}: saved ${imagePath}`);
      replyToExtension(message, { success: true, data: { imagePath } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${action}: failed to save: ${msg}`);
      replyToExtension(message, { success: false, error: `failed to save screenshot: ${msg}` });
    }
    return;
  }

  // Browser commands are never initiated by the Extension through the host:
  // popup actions run inside the Extension (outside Layer 0, by design), and
  // MCP tool calls originate from the server.
  log(`unsupported message from Extension: ${action ?? '(no action)'}`);
  if (message['requestId'] !== undefined) {
    replyToExtension(message, {
      success: false,
      error: `Native Host does not handle action '${action ?? ''}'`,
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let running = true;

function shutdown(connection: ServerConnection, monitor: HealthMonitor): void {
  if (!running) return;
  running = false;
  log('shutting down');
  connection.stop();
  monitor.stop();
  // Never stop the daemon: it also serves the Claude Code sessions (relays),
  // and exits on its own once nobody uses it.
}

async function main(): Promise<void> {
  log('========================================');
  log('KitsuneMCP Native Host starting');
  log(`log file: ${activeLogPath() ?? '(disabled by FOX_NATIVE_HOST_LOG)'}`);

  const launcher = new ServerLauncher();
  log(`MCP server target: http://${launcher.host}:${launcher.httpPort} (WS port ${launcher.wsPort})`);

  // Connect to the shared daemon, starting it if nothing listens on the port
  await launcher.ensureRunning();

  const connection: ServerConnection = new ServerConnection(
    launcher,
    (command) => handleServerCommand(command, connection),
  );
  connection.start();

  const monitor = new HealthMonitor(launcher, () => connection.reconnectNow());
  monitor.start();

  // Graceful shutdown
  const onSignal = (): void => {
    shutdown(connection, monitor);
    process.exit(0);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  log('ready — listening for Extension messages on stdin');
  log('========================================');

  // stdin read loop
  while (running) {
    const result = await readMessage();

    if (result.kind === 'eof') {
      log('stdin closed, exiting');
      break;
    }

    if (result.kind === 'skipped') {
      // Unusable frame (too large / bad JSON). Keep running; if we know which
      // server request it answered, fail that request now instead of letting
      // it time out.
      if (result.requestId !== undefined) {
        inFlight.delete(result.requestId);
        connection.send({
          requestId: result.requestId,
          success: false,
          error: `Extension response discarded by Native Host: ${result.reason}`,
        });
      }
      continue;
    }

    const message = result.message;
    const action = typeof message['action'] === 'string' ? message['action'] : 'response';
    log(`received from Extension: ${action}`);

    processMessage(message, launcher, connection);
  }

  shutdown(connection, monitor);
  process.exit(0);
}

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error
    ? `${reason.message}\n${reason.stack ?? ''}`
    : String(reason);
  log(`unhandledRejection: ${msg}`);
});

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log(`fatal error: ${msg}`);
  process.exit(1);
});
