/**
 * Browser connection manager.
 *
 * Manages registered browser connections (WebSocket or HTTP-polled) and
 * routes outgoing commands to the active browser, returning a Promise
 * that resolves when the Extension responds.
 *
 * Fork-source: server.py L817-878 BrowserConnectionManager
 *
 * Key difference from the Python original:
 *   Python uses asyncio.Future + dict.
 *   TypeScript uses Promise + Map<requestId, { resolve, reject, timer }>.
 */

import type { BrowserCommand, BrowserResponse } from '@kitsune-mcp/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A function that sends a serialized JSON string to the browser. */
export type SendFn = (message: string) => void | Promise<void>;

interface PendingRequest {
  resolve: (value: BrowserResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Default timeout (design.md 8.2: 通常コマンド 30秒)
// ---------------------------------------------------------------------------

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// BrowserConnectionManager
// ---------------------------------------------------------------------------

export class BrowserConnectionManager {
  /** Registered browser connections keyed by a unique ID. */
  private readonly connections = new Map<string, SendFn>();

  /** In-flight command promises awaiting a BrowserResponse. */
  private readonly pending = new Map<string, PendingRequest>();

  /**
   * Pending commands queue for HTTP polling.
   * The HTTP bridge pushes commands here when no WebSocket is available,
   * and the Extension pulls them via GET /browser/poll.
   */
  readonly pendingCommands: BrowserCommand[] = [];

  /** Monotonically increasing counter used to generate request IDs. */
  private requestCounter = 0;

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /** Register a new browser connection. */
  registerBrowser(id: string, sendFn: SendFn): void {
    this.connections.set(id, sendFn);
    process.stderr.write(`[KitsuneMCP] Browser registered: ${id}\n`);
  }

  /** Unregister a browser connection and reject any pending requests tied to it. */
  unregisterBrowser(id: string): void {
    if (this.connections.delete(id)) {
      process.stderr.write(`[KitsuneMCP] Browser unregistered: ${id}\n`);
    }
  }

  /** Return the first available browser's send function, or `undefined`. */
  getActiveBrowser(): SendFn | undefined {
    // Map insertion order is preserved — first registered wins.
    const first = this.connections.values().next();
    return first.done ? undefined : first.value;
  }

  /** Whether at least one browser is connected. */
  get hasBrowser(): boolean {
    return this.connections.size > 0;
  }

  /** Number of currently connected browsers. */
  get browserCount(): number {
    return this.connections.size;
  }

  // -----------------------------------------------------------------------
  // Command send / response routing
  // -----------------------------------------------------------------------

  /**
   * Send a command to the active browser and wait for its response.
   *
   * - Assigns a unique `requestId` to the command.
   * - Times out after `timeoutMs` (default 30 s, per design.md 8.2).
   * - Returns the BrowserResponse on success.
   * - Returns a synthetic error response when no browser is connected or on timeout.
   */
  async sendCommand(
    command: BrowserCommand,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<BrowserResponse> {
    const sendFn = this.getActiveBrowser();
    if (!sendFn) {
      return {
        requestId: command.requestId,
        success: false,
        error: 'No browser connected',
      };
    }

    this.requestCounter += 1;
    const requestId = String(this.requestCounter);
    // Mutate the command's requestId so caller and Extension agree.
    const outgoing: BrowserCommand = { ...command, requestId };

    return new Promise<BrowserResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          requestId,
          success: false,
          error: `Command timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      // Send to browser — fire-and-forget (WebSocket.send is sync in `ws`).
      try {
        const maybePromise = sendFn(JSON.stringify(outgoing));
        if (maybePromise instanceof Promise) {
          maybePromise.catch((err: unknown) => {
            clearTimeout(timer);
            this.pending.delete(requestId);
            resolve({
              requestId,
              success: false,
              error: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        }
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({
          requestId,
          success: false,
          error: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /**
   * Route a received BrowserResponse to the corresponding pending Promise.
   *
   * Called by both the WebSocket bridge and `POST /browser/response` handler.
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

  /** Reject all pending requests and clear connections. */
  shutdown(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        requestId: id,
        success: false,
        error: 'Connection manager shutting down',
      });
    }
    this.pending.clear();
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
