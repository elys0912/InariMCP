// Native Messaging connection to the Native Host: the port, reconnection with
// backoff, and requests the Extension sends itself (L1). Owns the connection
// state; the rest of the background reacts to its events through the hooks
// set by background.ts (setConnectionHooks), so this module imports none of
// the modules above it. It connects only after the user allowed it on the
// consent page (setConnectionAllowed).

import { errorMessage } from "../error-message";
import { clipText } from "../text-clip";
import { LIMITS, RECONNECT_BACKOFF_FACTOR, TIMEOUTS } from "./constants";
import type { NativeMessage } from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  /** The port the request was posted on (its answer can only come there). */
  port: browser.runtime.Port;
}

const MAX_SEND_RETRIES = LIMITS.SEND_RETRIES;
const SEND_RETRY_DELAY_MS = TIMEOUTS.SEND_RETRY_DELAY;
const CONNECT_SETTLE_MS = TIMEOUTS.CONNECT_SETTLE;

const NATIVE_HOST_NAME = "inari_mcp";
/**
 * Off until the user allowed the connection on the consent page
 * (background.ts sets it from control-state.ts). While off, nothing opens a
 * port: not the startup, not the reconnect timers, not a request.
 */
let connectionAllowed = false;
const NOT_ALLOWED_ERROR = "Not allowed to connect to the native host (Inari MCP for Firefox is not allowed yet)";
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
    INITIAL_RECONNECT_DELAY * Math.pow(RECONNECT_BACKOFF_FACTOR, reconnectAttempts),
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
      `[InariMCP] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
    );
    // Reset after a while to allow a fresh cycle
    setTimeout(() => {
      reconnectAttempts = 0;
      connectNativeHost();
    }, TIMEOUTS.RECONNECT_RESTART);
    return;
  }

  const delay = getReconnectDelay();
  reconnectAttempts++;
  console.log(
    `[InariMCP] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
  );
  setTimeout(connectNativeHost, delay);
}

/**
 * Allow or withdraw the connection. Withdrawing closes the current port and
 * fails its requests; the reconnect timers already set then do nothing.
 * Allowing does not connect by itself: the caller does (recheckHost).
 */
export function setConnectionAllowed(allowed: boolean): void {
  connectionAllowed = allowed;
  const port = nativePort;
  if (allowed || port === null) return;

  clearPortState();
  releasePort(port);
  rejectPending(port, NOT_ALLOWED_ERROR);
  hooks.onDisconnected();
}

export function connectNativeHost(): void {
  if (!connectionAllowed) return;
  if (isConnected && nativePort) {
    console.log("[InariMCP] Already connected");
    return;
  }

  try {
    console.log(
      `[InariMCP] Connecting to native host (attempt ${reconnectAttempts + 1})...`,
    );
    nativePort = browser.runtime.connectNative(NATIVE_HOST_NAME);
    isConnected = true;
    hostConfirmed = false;
    hostConfirmedAt = null;
    // reconnectAttempts is NOT reset here: connectNative() returns a port
    // even when the host is missing or exits at once, so resetting now would
    // defeat the backoff (a new host process every second). It is reset in
    // handleDisconnect once a connection proved stable.
    console.log("[InariMCP] Port opened to native host");

    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(handleDisconnect);
    // The answer confirms the host (see hostConfirmed). A missing host
    // rejects this via handleDisconnect, which refreshes the badge itself.
    sendToNativeHost({ action: "ping" }).then(
      () => { hooks.onConfirmed(); },
      () => {},
    );
  } catch (error) {
    console.error("[InariMCP] Failed to connect to native host:", error);
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

/**
 * The current port is lost (onDisconnect, or posting on it failed): record
 * why, update the reconnect counter and forget the port. `error`: what the
 * browser reported; without it, a host that never answered is reported as
 * having exited.
 */
function forgetCurrentPort(error: string | undefined): void {
  if (error !== undefined) {
    lastHostError = error;
  } else if (!hostConfirmed) {
    lastHostError = "Native host exited without answering";
  }
  reconnectAttempts = nextReconnectAttempts(
    reconnectAttempts,
    hostConfirmedAt === null ? null : Date.now() - hostConfirmedAt,
    STABLE_CONNECTION_MS,
  );
  clearPortState();
}

/** No current port: nothing connected, the host not confirmed. */
function clearPortState(): void {
  isConnected = false;
  hostConfirmed = false;
  hostConfirmedAt = null;
  nativePort = null;
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
  console.log("[InariMCP] Disconnected from native host");
  if (port.error) console.error("[InariMCP] Disconnect error:", port.error);
  forgetCurrentPort(port.error?.message);

  rejectPending(null, "Native host disconnected - reconnecting...");
  // Nobody is left to receive an answer: open approval requests are
  // withdrawn, and the badge is refreshed (hooks set by background.ts).
  hooks.onDisconnected();

  scheduleReconnect();
}

/**
 * One-line summary of a Native Messaging frame for the console: action,
 * requestId and the top-level / data key names -- never the values, which
 * can hold typed text, form values or page content.
 */
export function describeNativeMessage(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return `(${typeof raw})`;
  const m = raw as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.action === "string") parts.push(`action=${clipText(m.action, LIMITS.NATIVE_SUMMARY_TEXT)}`);
  if (typeof m.requestId === "string" || typeof m.requestId === "number") {
    parts.push(`requestId=${clipText(String(m.requestId), LIMITS.NATIVE_SUMMARY_TEXT)}`);
  }
  if (typeof m.success === "boolean") parts.push(`success=${m.success}`);
  const keys = Object.keys(m).filter((k) => k !== "action" && k !== "requestId" && k !== "success");
  parts.push(...keyListPart("keys", keys), ...keyListPart("data", isRecord(m.data) ? Object.keys(m.data) : []));

  return parts.join(" ");
}

/** `label=[a,b,...]` of the first LIMITS.NATIVE_SUMMARY_KEYS names; nothing without names. */
function keyListPart(label: string, names: string[]): string[] {
  return names.length > 0 ? [`${label}=[${names.slice(0, LIMITS.NATIVE_SUMMARY_KEYS).join(",")}]`] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Native Messaging frame as a NativeMessage, or null when it is not one:
 * an object whose action / error (when there) are strings, requestId a
 * number or a string, tabId a number and data an object. The fields inside
 * `data` are not checked here (handlers read them defensively).
 */
export function parseNativeMessage(raw: unknown): NativeMessage | null {
  if (!isRecord(raw)) return null;
  const { action, requestId, tabId, data, error } = raw;
  const wellFormed =
    isOptional(action, isString) &&
    isOptional(requestId, isRequestId) &&
    isOptional(tabId, isNumber) &&
    isOptional(data, isRecord) &&
    isOptional(error, isString);
  if (!wellFormed) return null;
  return { ...raw, action, requestId, tabId, data, error };
}

/** A field that is absent (undefined) or passes `is`. */
function isOptional<T>(value: unknown, is: (v: unknown) => v is T): value is T | undefined {
  return value === undefined || is(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** A request id: a number or a string. */
function isRequestId(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function handleNativeMessage(raw: unknown): void {
  console.log(`[InariMCP] Received from native host: ${describeNativeMessage(raw)}`);

  // Any frame shows the host is up, a malformed one included.
  if (!hostConfirmed) {
    hostConfirmed = true;
    lastHostError = null;
    hostConfirmedAt = Date.now();
  }

  const message = parseNativeMessage(raw);
  if (message === null) {
    console.error("[InariMCP] Dropped a malformed message from the native host");
    return;
  }

  const requestId = message.requestId;
  const entry = typeof requestId === "number" ? pendingRequests.get(requestId) : undefined;
  if (typeof requestId === "number" && entry !== undefined) {
    pendingRequests.delete(requestId);
    // The request is answered: its timeout must not fire later.
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
 * and report the loss as handleDisconnect would (lastError, reconnect
 * counter, hooks), since its own onDisconnect is no longer listened to. The
 * caller then retries on a new port, or, out of retries, schedules the
 * reconnect handleDisconnect would have. True when `port` was the current
 * port.
 */
function dropFailedPort(port: browser.runtime.Port, error: unknown): boolean {
  const wasCurrent = port === nativePort;
  if (wasCurrent) forgetCurrentPort(errorMessage(error));
  releasePort(port);
  rejectPending(port, "Native host disconnected - reconnecting...");
  if (wasCurrent) hooks.onDisconnected();
  return wasCurrent;
}

function sendAttempt(message: NativeMessage, timeoutMs: number, retryCount: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const retry = (): void => {
      setTimeout(() => {
        sendAttempt(message, timeoutMs, retryCount + 1).then(resolve, reject);
      }, SEND_RETRY_DELAY_MS);
    };

    if (!connectionAllowed) {
      reject(new Error(NOT_ALLOWED_ERROR));
      return;
    }
    if (!isConnected || !nativePort) {
      connectNativeHost();

      setTimeout(() => {
        if (!isConnected || !nativePort) {
          if (retryCount < MAX_SEND_RETRIES) {
            console.log(
              `[InariMCP] Not connected, retrying (${retryCount + 1}/${MAX_SEND_RETRIES})...`,
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

        const wasCurrent = dropFailedPort(port, error);
        if (retryCount < MAX_SEND_RETRIES) {
          console.log("[InariMCP] Send failed, reconnecting and retrying...");
          retry();
        } else {
          // Out of retries: the broken port is dropped all the same (kept, it
          // would stay current until an onDisconnect that may never come), and
          // the connection comes back on the usual backoff.
          if (wasCurrent) scheduleReconnect();
          reject(error instanceof Error ? error : new Error(errorMessage(error)));
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
