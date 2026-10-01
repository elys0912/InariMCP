/**
 * Native Host message handling: the stdin read loop and the routing of
 * Extension messages (kept apart from index.ts so it can be tested without
 * starting the daemon or the WebSocket connection).
 */

import { parseHostMessage } from '@kitsune-mcp/shared';
import { readMessage, sendMessage } from './protocol.js';
import { serverEntryPath, type DaemonInfo, type ServerLauncher } from './server-launcher.js';
import type { ServerConnection } from './ws-client.js';
import { externalizeScreenshots, saveScreenshot } from './screenshot-store.js';
import { log } from './logger.js';
import { HOST_VERSION } from './version.js';

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
/**
 * Entries older than this are assumed abandoned: the server waits at most
 * 580 s (the cap of timeout arguments, mcp-server tools/schemas.ts) + 5 s.
 */
const IN_FLIGHT_TTL_MS = 10 * 60_000;

function pruneInFlight(now: number): void {
  for (const [id, entry] of inFlight) {
    if (now - entry.sentAt > IN_FLIGHT_TTL_MS) inFlight.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Server → Extension
// ---------------------------------------------------------------------------

export function handleServerCommand(
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

export function processMessage(
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

  // Local commands initiated by the Extension itself (shared/host-messages.ts)
  const parsed = parseHostMessage(message);
  if (!parsed.ok && parsed.action !== undefined) {
    log(parsed.error);
    const screenshot = parsed.action === 'saveScreenshot' || parsed.action === 'screenshotTaken';
    replyToExtension(message, { success: false, error: screenshot ? 'no image data' : parsed.error });
    return;
  }
  const local = parsed.ok ? parsed.message : undefined;

  if (local?.action === 'ping') {
    replyToExtension(message, {
      action: 'pong',
      pong: true,
      success: true,
      timestamp: Date.now() / 1000,
    });
    return;
  }

  if (local?.action === 'status') {
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
          version: HOST_VERSION,
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
  if (local?.action === 'saveScreenshot' || local?.action === 'screenshotTaken') {
    const imageData = typeof local.data === 'string' ? local.data : local.data.imageData;
    const filename = local.filename;
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

/**
 * Read Extension messages until stdin closes (or `isRunning` turns false) and
 * route each one. Started before the daemon is up, so the Extension's ping /
 * status requests are answered at once (Firefox times a ping out after 30 s).
 */
export async function runStdinLoop(
  launcher: ServerLauncher,
  connection: ServerConnection,
  isRunning: () => boolean,
): Promise<void> {
  while (isRunning()) {
    const result = await readMessage();

    if (result.kind === 'eof') {
      log('stdin closed, exiting');
      return;
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
}
