// Native Messaging connection to the Native Host: the port, reconnection with
// backoff, and requests the Extension sends itself (L1). Owns the connection
// state; the rest of the background reacts to its events through the hooks
// set by background.ts (setConnectionHooks), so this module imports none of
// the modules above it.

import { TIMEOUTS } from "./constants";
import { clipText } from "../text-clip";
import type { NativeMessage } from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  /** The port the request was posted on (its answer can only come there). */
  port: browser.runtime.Port;
}

/** sendToNativeHost: attempts after the first when not connected or posting fails. */
const MAX_SEND_RETRIES = 3;
const SEND_RETRY_DELAY_MS = 1000;
/** sendToNativeHost: wait for connectNativeHost() before checking the port again. */
const CONNECT_SETTLE_MS = 500;

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

/** Reject (and forget) the pending requests posted on `port`, or all of them. */
function rejectPending(port: browser.runtime.Port | null, reason: string): void {
  for (const [id, entry] of [...pendingRequests]) {
    if (port !== null && entry.port !== port) continue;
    pendingRequests.delete(id);
    clearTimeout(entry.timeoutId);
    entry.reject(new Error(reason));
  }
}

/** Stop listening to a port that is no longer the current one, and close it. */
function releasePort(port: browser.runtime.Port): void {
  port.onMessage.removeListener(handleNativeMessage);
  port.onDisconnect.removeListener(handleDisconnect);
  try {
    port.disconnect();
  } catch {
    // Already disconnected
  }
}

function handleDisconnect(port: browser.runtime.Port): void {
  if (port !== nativePort) {
    // A port already replaced (posting on it failed): its late onDisconnect
    // must not drop the current port. Only its own requests are failed.
    port.onMessage.removeListener(handleNativeMessage);
    port.onDisconnect.removeListener(handleDisconnect);
    rejectPending(port, "Native host disconnected - reconnecting...");
    return;
  }
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

  rejectPending(null, "Native host disconnected - reconnecting...");
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
  if (typeof m.action === "string") parts.push(`action=${clipText(m.action, 64)}`);
  if (typeof m.requestId === "string" || typeof m.requestId === "number") {
    parts.push(`requestId=${clipText(String(m.requestId), 64)}`);
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

/**
 * Post a request of the Extension's own (ping, status) and wait for the
 * answer. The request id is set on a copy, so `message` is left as given.
 * `timeoutMs`: how long one posted request waits for its answer.
 */
export function sendToNativeHost(
  message: NativeMessage,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  return sendAttempt(message, options.timeoutMs ?? TIMEOUTS.COMMAND, 0);
}

/**
 * Posting failed on `port` (it is broken): stop using it, fail its requests
 * and report the loss as handleDisconnect would, since its own onDisconnect
 * is no longer listened to. The caller retries on a new port.
 */
function dropFailedPort(port: browser.runtime.Port): void {
  const wasCurrent = port === nativePort;
  if (wasCurrent) {
    nativePort = null;
    isConnected = false;
    hostConfirmed = false;
    hostConfirmedAt = null;
  }
  releasePort(port);
  rejectPending(port, "Native host disconnected - reconnecting...");
  if (wasCurrent) hooks.onDisconnected();
}

function sendAttempt(message: NativeMessage, timeoutMs: number, retryCount: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const retry = (): void => {
      setTimeout(() => {
        sendAttempt(message, timeoutMs, retryCount + 1).then(resolve, reject);
      }, SEND_RETRY_DELAY_MS);
    };

    if (!isConnected || !nativePort) {
      connectNativeHost();

      setTimeout(() => {
        if (!isConnected || !nativePort) {
          if (retryCount < MAX_SEND_RETRIES) {
            console.log(
              `[KitsuneMCP] Not connected, retrying (${retryCount + 1}/${MAX_SEND_RETRIES})...`,
            );
            retry();
          } else {
            reject(new Error("Not connected to native host after retries"));
          }
          return;
        }
        doSend(nativePort);
      }, CONNECT_SETTLE_MS);
      return;
    }

    doSend(nativePort);

    function doSend(port: browser.runtime.Port): void {
      const requestId = ++requestCounter;

      const timeoutId = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error("Request timeout"));
        }
      }, timeoutMs);

      pendingRequests.set(requestId, { resolve, reject, timeoutId, port });

      try {
        port.postMessage({ ...message, requestId });
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);

        if (retryCount < MAX_SEND_RETRIES) {
          console.log("[KitsuneMCP] Send failed, reconnecting and retrying...");
          dropFailedPort(port);
          retry();
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
