// Native Messaging connection to the Native Host: the port, reconnection with
// backoff, and requests the Extension sends itself (L1). Owns the connection
// state; the rest of the background reacts to its events through the hooks
// set by background.ts (setConnectionHooks), so this module imports none of
// the modules above it.

import { TIMEOUTS } from "./constants";
import type { NativeMessage } from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const NATIVE_HOST_NAME = "kitsune_mcp";
let nativePort: browser.runtime.Port | null = null;
let isConnected = false;
// connectNative() returns a port even when the host is not registered; that
// failure only shows up afterwards as onDisconnect with port.error. So the
// host counts as running only once it has answered on the current port.
let hostConfirmed = false;
/** port.error of the last disconnect; cleared when the host answers. */
let lastHostError: string | null = null;
const pendingRequests = new Map<number, PendingRequest>();
let requestCounter = 0;

// Reconnection settings
let reconnectAttempts = 0;
/** When the host first answered on the current port (null: not yet). */
let hostConfirmedAt: number | null = null;
/** A connection counts as stable (backoff starts over) after this long. */
const STABLE_CONNECTION_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const INITIAL_RECONNECT_DELAY = TIMEOUTS.RECONNECT_INITIAL;
const MAX_RECONNECT_DELAY = TIMEOUTS.RECONNECT_MAX;

/**
 * What the rest of the background does on connection events. background.ts
 * sets them once at startup (setConnectionHooks); until then they do nothing.
 */
interface ConnectionHooks {
  /** A command from the MCP Server (a message with an action, not a reply). */
  onCommand(message: NativeMessage): void;
  /** The host answered the ping sent when the port was opened. */
  onConfirmed(): void;
  /** The port was lost (pending requests already rejected). */
  onDisconnected(): void;
}

let hooks: ConnectionHooks = {
  onCommand: () => {},
  onConfirmed: () => {},
  onDisconnected: () => {},
};

export function setConnectionHooks(next: ConnectionHooks): void {
  hooks = next;
}

function getReconnectDelay(): number {
  return Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts),
    MAX_RECONNECT_DELAY,
  );
}

/**
 * Reconnect attempt counter after a disconnect. It starts over only when the
 * host had answered on the lost port and stayed up for `stableMs`; a host
 * that is missing, exits at once or crashes right after answering keeps
 * counting up, so the backoff grows instead of respawning it every second.
 * `confirmedForMs`: time since the host's first answer, null if it never did.
 */
export function nextReconnectAttempts(
  attempts: number,
  confirmedForMs: number | null,
  stableMs: number,
): number {
  return confirmedForMs !== null && confirmedForMs >= stableMs ? 0 : attempts;
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(
      `[KitsuneMCP] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
    );
    // Reset after 60 s to allow a fresh cycle
    setTimeout(() => {
      reconnectAttempts = 0;
      connectNativeHost();
    }, 60_000);
    return;
  }

  const delay = getReconnectDelay();
  reconnectAttempts++;
  console.log(
    `[KitsuneMCP] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
  );
  setTimeout(connectNativeHost, delay);
}

export function connectNativeHost(): void {
  if (isConnected && nativePort) {
    console.log("[KitsuneMCP] Already connected");
    return;
  }

  try {
    console.log(
      `[KitsuneMCP] Connecting to native host (attempt ${reconnectAttempts + 1})...`,
    );
    nativePort = browser.runtime.connectNative(NATIVE_HOST_NAME);
    isConnected = true;
    hostConfirmed = false;
    hostConfirmedAt = null;
    // reconnectAttempts is NOT reset here: connectNative() returns a port
    // even when the host is missing or exits at once, so resetting now would
    // defeat the backoff (a new host process every second). It is reset in
    // handleDisconnect once a connection proved stable.
    console.log("[KitsuneMCP] Port opened to native host");

    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(handleDisconnect);
    // The answer confirms the host (see hostConfirmed). A missing host
    // rejects this via handleDisconnect, which refreshes the badge itself.
    sendToNativeHost({ action: "ping" }).then(
      () => { hooks.onConfirmed(); },
      () => {},
    );
  } catch (error) {
    console.error("[KitsuneMCP] Failed to connect to native host:", error);
    isConnected = false;
    nativePort = null;
    scheduleReconnect();
  }
}

function handleDisconnect(port: browser.runtime.Port): void {
  console.log("[KitsuneMCP] Disconnected from native host");
  if (port.error) {
    console.error("[KitsuneMCP] Disconnect error:", port.error);
    lastHostError = port.error.message;
  } else if (!hostConfirmed) {
    lastHostError = "Native host exited without answering";
  }
  reconnectAttempts = nextReconnectAttempts(
    reconnectAttempts,
    hostConfirmedAt === null ? null : Date.now() - hostConfirmedAt,
    STABLE_CONNECTION_MS,
  );
  isConnected = false;
  hostConfirmed = false;
  hostConfirmedAt = null;
  nativePort = null;

  for (const [, entry] of pendingRequests) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error("Native host disconnected - reconnecting..."));
  }
  pendingRequests.clear();
  // Nobody is left to receive an answer: open approval requests are
  // withdrawn, and the badge is refreshed (hooks set by background.ts).
  hooks.onDisconnected();

  scheduleReconnect();
}

/**
 * One-line summary of a Native Messaging frame for the console: action,
 * requestId and the top-level / data key names -- never the values, which
 * can hold scripts, typed text, form values or page content.
 */
export function describeNativeMessage(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return `(${typeof raw})`;
  const m = raw as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.action === "string") parts.push(`action=${m.action.slice(0, 64)}`);
  if (typeof m.requestId === "string" || typeof m.requestId === "number") {
    parts.push(`requestId=${String(m.requestId).slice(0, 64)}`);
  }
  if (typeof m.success === "boolean") parts.push(`success=${m.success}`);
  const keys = Object.keys(m).filter((k) => k !== "action" && k !== "requestId" && k !== "success");
  if (keys.length > 0) parts.push(`keys=[${keys.slice(0, 20).join(",")}]`);
  const data = m.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const dataKeys = Object.keys(data);
    if (dataKeys.length > 0) parts.push(`data=[${dataKeys.slice(0, 20).join(",")}]`);
  }
  return parts.join(" ");
}

function handleNativeMessage(raw: unknown): void {
  const message = raw as NativeMessage;
  console.log(`[KitsuneMCP] Received from native host: ${describeNativeMessage(raw)}`);

  if (!hostConfirmed) {
    hostConfirmed = true;
    lastHostError = null;
    hostConfirmedAt = Date.now();
  }

  if (typeof message.requestId === "number" && pendingRequests.has(message.requestId)) {
    const entry = pendingRequests.get(message.requestId)!;
    pendingRequests.delete(message.requestId);
    // BUG FIX: clear the timeout so it doesn't fire after resolution
    clearTimeout(entry.timeoutId);

    if (message.error) {
      entry.reject(new Error(message.error));
    } else {
      entry.resolve(message);
    }
  } else if (message.action) {
    hooks.onCommand(message);
  }
}

export function sendToNativeHost(
  message: NativeMessage,
  retryCount = 0,
): Promise<unknown> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  return new Promise((resolve, reject) => {
    if (!isConnected || !nativePort) {
      connectNativeHost();

      setTimeout(() => {
        if (!isConnected || !nativePort) {
          if (retryCount < MAX_RETRIES) {
            console.log(
              `[KitsuneMCP] Not connected, retrying (${retryCount + 1}/${MAX_RETRIES})...`,
            );
            setTimeout(() => {
              sendToNativeHost(message, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, RETRY_DELAY);
          } else {
            reject(new Error("Not connected to native host after retries"));
          }
          return;
        }
        doSend();
      }, 500);
      return;
    }

    doSend();

    function doSend(): void {
      const requestId = ++requestCounter;
      message.requestId = requestId;

      const timeoutId = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error("Request timeout"));
        }
      }, TIMEOUTS.COMMAND);

      pendingRequests.set(requestId, { resolve, reject, timeoutId });

      try {
        nativePort!.postMessage(message);
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);

        if (retryCount < MAX_RETRIES) {
          console.log("[KitsuneMCP] Send failed, reconnecting and retrying...");
          isConnected = false;
          nativePort = null;
          setTimeout(() => {
            sendToNativeHost(message, retryCount + 1)
              .then(resolve)
              .catch(reject);
          }, RETRY_DELAY);
        } else {
          reject(error);
        }
      }
    }
  });
}

/** Connection state, for the setup state and the status command. */
export function hostStatus(): { confirmed: boolean; portOpen: boolean; lastError: string | null } {
  return { confirmed: hostConfirmed, portOpen: nativePort !== null, lastError: lastHostError };
}

/**
 * Connect again now, with the backoff started over (the popup asks for a
 * recheck, e.g. right after running the installer).
 */
export function recheckHost(): void {
  reconnectAttempts = 0;
  connectNativeHost();
}

/**
 * Post `message` on the current port. False when there is no port; throws
 * when posting fails (port disconnected meanwhile, message not serializable).
 */
export function postToHost(message: unknown): boolean {
  if (!nativePort) return false;
  nativePort.postMessage(message);
  return true;
}
