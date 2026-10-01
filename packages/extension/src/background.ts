// KitsuneMCP Background Script
// Handles native messaging, tab management, and coordination with content scripts
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025
//
// Bundled with its imports into dist/background.js (scripts/build-extension.mjs).

import { t } from "./i18n";
import {
  parseApprovalPrompt,
  approvalCommandResult,
  APPROVAL_MESSAGE,
  type ApprovalView,
  type ApprovalDecision,
} from "./approval";
import type { SetupState } from "./types/setup";
import { isSingleTabAction, SELF_PROTECTED_ACTIONS } from "./background/action-policy";
import {
  TIMEOUTS,
  LOG_RECORD_MESSAGE,
  TOP_FRAME_ID,
  LOGGING_STATE_QUERY,
} from "./background/constants";
import {
  parseContainerScope,
  enforceContainerScope,
  outOfScope,
  listContainers,
  openInContainer,
} from "./background/container-scope";
import {
  startLoggingOnTab,
  stopLoggingOnTab,
  getLogsOfTab,
  clearLogsOfTab,
  isLoggingTab,
  acceptLogRecords,
  loggingStateFor,
  wantsEarlyInjection,
  forgetTab,
} from "./background/logging";
import { navigateTo, navigateNewTab, navigateHistory } from "./background/navigation";
import {
  performClick,
  performType,
  performScroll,
  getPageInfo,
  getElements,
  executeScript,
  highlightElement,
  waitForElement,
} from "./background/page-actions";
import { refreshTab, reloadAllTabs, reloadTabsByUrl } from "./background/reload";
import { takeScreenshot, screenshotAllTabs } from "./background/screenshot";
import { resolveTab, sendToContentScript } from "./background/tab-target";
import { waitForNavigation, waitForUrl } from "./background/tab-wait";
import {
  getAllTabs,
  createNewTab,
  closeTab,
  focusTab,
  getTabInfo,
  findTabs,
  findText,
} from "./background/tabs";
import type {
  NativeMessage,
  CommandResult,
  ScopeFilter,
  ScreenshotOptions,
  GetAllTabsOptions,
  FindTabsOptions,
  RefreshOptions,
  ReloadAllOptions,
  ReloadByUrlOptions,
} from "./background/types";
import {
  parseUrlPolicy,
  hasUrlLists,
  checkListedTarget,
  checkProtectedTarget,
} from "./background/url-policy";
import { resolveWireAction, toWireResponse } from "./background/wire";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reconnection helpers
// ---------------------------------------------------------------------------

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
function nextReconnectAttempts(
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

// ---------------------------------------------------------------------------
// Native messaging
// ---------------------------------------------------------------------------

function connectNativeHost(): void {
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
      () => { void refreshSetupState(); },
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
  // Nobody is left to receive an answer: withdraw open approval requests.
  cancelAllApprovals();

  void refreshSetupState();
  scheduleReconnect();
}

/**
 * One-line summary of a Native Messaging frame for the console: action,
 * requestId and the top-level / data key names -- never the values, which
 * can hold scripts, typed text, form values or page content.
 */
function describeNativeMessage(raw: unknown): string {
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
    handleCommand(message);
  }
}

function sendToNativeHost(
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

// ---------------------------------------------------------------------------
// Setup state (popup guidance + toolbar badge)
// ---------------------------------------------------------------------------

/** Native Host reply to `status` (packages/native-host/src/index.ts). */
interface HostStatusReply {
  mcp_server?: { url?: string; available?: boolean; relays?: number | null };
  claude_register_command?: string;
}

const NATIVE_HOST_MISSING = /No such native application/i;
/** The host checks /health and /daemon/info with 3 s timeouts each. */
const SETUP_STATUS_TIMEOUT_MS = 5_000;
/** Matches the relay heartbeat, so a new session shows up within ~30 s. */
const SETUP_REFRESH_MS = 30_000;
const BADGE_COLOR = "#D9372B";

async function getSetupState(): Promise<SetupState> {
  if (!hostConfirmed || !nativePort) {
    if (lastHostError === null) return { kind: "connecting" };
    return NATIVE_HOST_MISSING.test(lastHostError)
      ? { kind: "hostMissing", error: lastHostError }
      : { kind: "hostError", error: lastHostError };
  }

  let reply: HostStatusReply;
  try {
    reply = (await Promise.race([
      sendToNativeHost({ action: "status" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Native host status timed out")), SETUP_STATUS_TIMEOUT_MS),
      ),
    ])) as HostStatusReply;
  } catch (error) {
    return { kind: "hostError", error: (error as Error).message };
  }

  const server = reply.mcp_server ?? {};
  const serverUrl = typeof server.url === "string" ? server.url : undefined;
  // Native Hosts before 0.1.2 do not send `relays` at all (current ones send
  // null when the daemon info is unavailable): not a daemon problem.
  if (server.available === true && !("relays" in server)) {
    return { kind: "hostOutdated", serverUrl };
  }
  if (server.available !== true || typeof server.relays !== "number") {
    return { kind: "daemonDown", serverUrl };
  }
  if (server.relays === 0) {
    return {
      kind: "noSession",
      serverUrl,
      registerCommand:
        typeof reply.claude_register_command === "string" ? reply.claude_register_command : undefined,
    };
  }
  return { kind: "ready", serverUrl, relays: server.relays };
}

/** Toolbar tooltip per state (message keys); null = the plain name. */
const BADGE_TITLE_KEYS: Record<SetupState["kind"], string | null> = {
  connecting: null,
  hostMissing: "badgeSetupNeeded",
  hostError: "badgeHostError",
  hostOutdated: "badgeHostOutdated",
  daemonDown: "badgeDaemonDown",
  noSession: "badgeNoSession",
  ready: null,
};

const APPROVAL_BADGE_COLOR = "#E5A00D";
let lastSetupState: SetupState = { kind: "connecting" };

function applyBadge(state: SetupState): void {
  lastSetupState = state;
  renderBadge();
}

/**
 * Pending approval requests take precedence (count on an amber badge): the
 * popup is where the human answers them. Otherwise the setup state.
 */
function renderBadge(): void {
  const pending = pendingApprovals.size;
  if (pending > 0) {
    browser.browserAction.setBadgeBackgroundColor({ color: APPROVAL_BADGE_COLOR }).catch(() => {});
    browser.browserAction.setBadgeText({ text: String(pending) }).catch(() => {});
    browser.browserAction.setTitle({ title: t("badgeApprovalPending", String(pending)) }).catch(() => {});
    return;
  }
  const state = lastSetupState;
  const attention = state.kind !== "ready" && state.kind !== "connecting";
  const titleKey = BADGE_TITLE_KEYS[state.kind];
  browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  browser.browserAction.setBadgeText({ text: attention ? "!" : "" }).catch(() => {});
  browser.browserAction
    .setTitle({ title: titleKey === null ? "KitsuneMCP" : t(titleKey) })
    .catch(() => {});
}

async function refreshSetupState(): Promise<SetupState> {
  const state = await getSetupState();
  applyBadge(state);
  return state;
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function handleCommand(message: NativeMessage): Promise<CommandResult> {
  const { data } = message;
  let tabId = message.tabId;
  let result: CommandResult = { success: false };

  // Normalize the wire action name (snake_case) to the internal name once,
  // before any check, so the scope sets and the switch below all see the
  // same name.
  const resolved = resolveWireAction(message.action);
  if (resolved.kind === "notImplemented") {
    result = { success: false, error: `Not implemented in extension: ${resolved.wireName}` };
    postWireResponse(message, result);
    return result;
  }
  // fox_navigate with newTab opens the URL in a fresh tab. Route it as
  // createTab so the scope check treats it like fox_create_tab: the new tab
  // is born inside the agent container instead of requiring the current
  // active tab to be in scope.
  const navigateInNewTab = resolved.action === "navigate" && data?.newTab === true;
  const action = navigateInNewTab ? "createTab" : resolved.action;

  // Resolve the target tab of a single-tab action ONCE (explicit tabId, else
  // the active tab of the current window) and pin its id: the container
  // scope check, the protected-domain check, the handler and the URL report
  // below then all see the same tab, even if the active tab changes
  // meanwhile. Undefined when it cannot be resolved -- the checks then fail
  // closed and the handler reports the missing tab.
  let target: browser.tabs.Tab | undefined;
  if (action !== undefined && isSingleTabAction(action)) {
    try {
      target = await resolveTab(tabId);
    } catch {
      target = undefined;
    }
    if (target) tabId = target.id;
  }

  // Container scope check (Layer 0). The MCP Server attaches
  // `containerScope` to every command when container_scope.enabled is true.
  const containerScope = parseContainerScope(message.containerScope);
  let scope: ScopeFilter | null = null;
  if (containerScope) {
    const decision = await enforceContainerScope(action, target, containerScope);
    if (!decision.allowed) {
      result = outOfScope(decision.error);
      postWireResponse(message, result);
      return result;
    }
    scope = decision.scope;
  }
  const policy = parseUrlPolicy(message);
  if (policy.invalid > 0) {
    result = {
      success: false,
      safetyDecision: "config_error",
      error:
        `Refused: ${policy.invalid} URL pattern(s) attached by the MCP Server could not be used ` +
        "(Extension and MCP Server versions may not match).",
    };
    postWireResponse(message, result);
    return result;
  }
  const protectedPatterns = policy.protectedRules;
  const urlLists = policy.lists;
  // Hostname a human approved for this one call (MCP Server approval token).
  const approvedHost = typeof message.approvedHost === "string" ? message.approvedHost : undefined;

  // blocked / allowed lists against the real URL of the target tab (the
  // guard only knows the last URL it saw for the tab, if any). The server
  // attaches them to the commands its own tab check covers; the multi-tab
  // actions skip such tabs themselves. A human approval does not lift this.
  if (hasUrlLists(urlLists) && action !== undefined && isSingleTabAction(action)) {
    const refusal = checkListedTarget(target, urlLists);
    if (refusal) {
      result = refusal;
      postWireResponse(message, result);
      return result;
    }
  }

  // Protected-domain check against the real URL of the target tab (not the
  // server's last-seen URL, which is shared by every session). The server
  // attaches the patterns, when confirm_protected_actions is true, to
  // single-tab captures and to every acting tool without a `url` argument;
  // the logging actions and the multi-tab actions (screenshot_all_tabs,
  // reload_all, reload_by_url) apply them themselves below. Actions that
  // act on no existing tab (new tab, tab list, approval, status) have no
  // target to check.
  if (
    protectedPatterns.length > 0 &&
    action !== undefined &&
    isSingleTabAction(action) &&
    !SELF_PROTECTED_ACTIONS.has(action)
  ) {
    const refusal = checkProtectedTarget(target, protectedPatterns, approvedHost);
    if (refusal) {
      result = refusal;
      postWireResponse(message, result);
      return result;
    }
  }

  try {
    switch (action) {
      case "screenshot":
        result = await takeScreenshot(tabId, data as ScreenshotOptions);
        break;
      case "click":
        result = await performClick(tabId, data);
        break;
      case "type":
        result = await performType(tabId, data);
        break;
      case "scroll":
        result = await performScroll(tabId, data);
        break;
      case "navigate":
        result = await navigateTo(tabId, data as { url: string });
        break;
      case "getPageInfo":
        result = await getPageInfo(tabId);
        break;
      case "getElements":
        result = await getElements(tabId, data);
        break;
      case "executeScript":
        result = await executeScript(tabId, data as { script: string });
        break;
      case "highlight":
        result = await highlightElement(tabId, data);
        break;
      case "waitForElement":
        result = await waitForElement(tabId, data);
        break;
      case "getTabs":
        result = await getAllTabs(data as GetAllTabsOptions, scope);
        break;
      case "createTab":
        result = navigateInNewTab
          ? await navigateNewTab(data as { url: string; waitForLoad?: boolean }, scope)
          : await createNewTab(data as { url?: string; active?: boolean }, scope);
        break;
      case "closeTab":
        if (tabId === undefined || message.tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await closeTab(tabId);
        break;
      case "focusTab":
        if (tabId === undefined || message.tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await focusTab(tabId);
        break;
      case "getTabInfo":
        if (tabId === undefined || message.tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await getTabInfo(tabId);
        break;
      case "findTabs":
        result = await findTabs(data as FindTabsOptions, scope);
        break;
      case "screenshotAllTabs":
        result = await screenshotAllTabs(data as ScreenshotOptions, scope, protectedPatterns, urlLists);
        break;
      case "refresh":
        result = await refreshTab(tabId, data as RefreshOptions);
        break;
      case "hardRefresh":
        result = await refreshTab(tabId, { ...(data as RefreshOptions), bypassCache: true });
        break;
      case "reloadAll":
        result = await reloadAllTabs(data as ReloadAllOptions, scope, protectedPatterns, urlLists);
        break;
      case "reloadByUrl":
        result = await reloadTabsByUrl(data as ReloadByUrlOptions, scope, protectedPatterns, urlLists);
        break;
      case "status": {
        // The popup asks for a recheck (e.g. right after running the
        // installer) so it need not wait for the reconnect backoff.
        if (data?.recheck === true && !hostConfirmed) {
          reconnectAttempts = 0;
          connectNativeHost();
        }
        const setup = await refreshSetupState();
        result = {
          success: true,
          connected: hostConfirmed,
          version: browser.runtime.getManifest().version,
          setup,
        };
        break;
      }
      case "goBack":
        result = await navigateHistory(tabId, "back");
        break;
      case "goForward":
        result = await navigateHistory(tabId, "forward");
        break;
      case "requestApproval":
        result = await requestApproval(message.requestId, data);
        break;
      case "solveCaptcha":
        result = await trackHumanWait(message.requestId, tabId, (id) =>
          solveCaptcha(id, data as { detectOnly?: boolean }),
        );
        break;
      case "cancelHumanWait":
        result = await cancelHumanWait(data);
        break;
      // Content-script-forwarded actions. Every command goes to the top
      // frame (sendToContentScript's default), never to whichever frame
      // answers first.
      case "getValue":
      case "setValue":
      case "selectOption":
      case "hover":
      case "waitForChange":
      case "observeElement":
      case "stopObserving":
      case "scrollAndCapture":
      case "clickAndWait":
      case "pressKey":
      case "getText":
      case "waitForNetworkIdle":
        result = await sendToContentScript(tabId, { action, ...data });
        break;
      case "waitForNavigation":
        result = await waitForNavigation(tabId, data);
        break;
      case "waitForUrl":
        result = await waitForUrl(tabId, data);
        break;
      case "startLogging":
        result = await startLoggingOnTab(target, data, protectedPatterns, approvedHost);
        break;
      case "stopLogging":
        result = await stopLoggingOnTab(target);
        break;
      case "getConsoleLogs":
      case "getNetworkLogs":
        result = await getLogsOfTab(action, target, data, protectedPatterns);
        break;
      case "clearLogs":
        result = await clearLogsOfTab(target, data);
        break;
      case "list_containers":
        result = await listContainers(scope);
        break;
      case "open_in_container":
        result = await openInContainer(data as { url: string; containerName?: string; cookieStoreId?: string; color?: string; icon?: string; active?: boolean }, scope);
        break;
      case "find_text":
        result = await findText(target, data);
        break;
      default:
        result = { success: false, error: `Unknown action: ${action}` };
    }
  } catch (error) {
    result = { success: false, error: (error as Error).message };
  }

  // Report the target tab's URL after the operation so the server's guard
  // can track the current page (data.url). Only for single-tab actions; the
  // tab-creating actions set `url` themselves, and a closed tab has none.
  if (
    result.success &&
    typeof result.url !== "string" &&
    action !== undefined &&
    isSingleTabAction(action) &&
    action !== "closeTab"
  ) {
    try {
      const tab = await resolveTab(tabId);
      if (tab && tab.url) {
        result = { ...result, url: tab.url };
      }
    } catch {
      // Tab vanished -- report the result without a URL
    }
  }

  postWireResponse(message, result);

  return result;
}

// ---------------------------------------------------------------------------
// Wire protocol helpers
// ---------------------------------------------------------------------------

/**
 * Send the result of a native command back to the native host. Messages from
 * the popup / content script carry no requestId and get the raw result via
 * sendResponse instead.
 */
function postWireResponse(message: NativeMessage, result: CommandResult): void {
  if (nativePort && message.requestId) {
    try {
      nativePort.postMessage(toWireResponse(message.requestId, result));
    } catch (e) {
      // Port disconnected meanwhile, or the result is not serializable. The
      // server fails the request on its own timeout / WS disconnect.
      console.error(
        `Failed to send response for requestId ${message.requestId}:`,
        e,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Approval requests (toolbar popup, never the page)
// ---------------------------------------------------------------------------
//
// A request_approval command stays pending here until the human decides in
// the popup (APPROVAL_MESSAGE.DECIDE, accepted from extension pages only),
// it times out, the server withdraws it (cancel_human_wait) or the Native
// Host disconnects. The badge shows how many are pending. The answer is the
// command's response, on the server's own requestId.

interface PendingApproval {
  view: ApprovalView;
  /** requestId of the request_approval command (cancel_human_wait key). */
  requestId: string;
  finish: (decision: ApprovalDecision) => void;
}

/** Pending requests by ApprovalView.id, in arrival order. */
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_NOTIFICATION_PREFIX = "kitsune-approval-";

function requestApproval(
  requestId: number | string | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  const key = requestId === undefined ? `local-${Date.now()}` : String(requestId);
  const view = parseApprovalPrompt(data, key, Date.now(), TIMEOUTS.APPROVAL);
  if (view === null) {
    return Promise.resolve({ success: false, error: "Malformed approval request" });
  }
  // A repeated id (server retry) replaces the older entry.
  pendingApprovals.get(view.id)?.finish("cancelled");

  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    const finish = (decision: ApprovalDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingApprovals.get(view.id)?.finish === finish) pendingApprovals.delete(view.id);
      browser.notifications?.clear?.(APPROVAL_NOTIFICATION_PREFIX + view.id)?.catch(() => {});
      renderBadge();
      resolve(approvalCommandResult(view, decision, Date.now()));
    };
    const timer = setTimeout(() => finish("timeout"), Math.max(0, view.deadline - Date.now()));
    pendingApprovals.set(view.id, { view, requestId: key, finish });
    renderBadge();
    notifyApproval(view);
  });
}

/** OS notification pointing at the toolbar popup (best effort). */
function notifyApproval(view: ApprovalView): void {
  try {
    if (!browser.notifications) return;
    const message =
      view.kind === "protected_action"
        ? t("notifyApprovalProtected", [view.toolName ?? "", view.host ?? ""])
        : t("notifyApprovalQuestion", (view.message || t("notifyApprovalDefault")).slice(0, 160));
    browser.notifications
      .create(APPROVAL_NOTIFICATION_PREFIX + view.id, {
        type: "basic",
        title: t("notifyApprovalTitle"),
        message,
        iconUrl: browser.runtime.getURL("icons/icon.svg"),
      })
      .catch(() => {});
  } catch {
    // Notifications unavailable -- the badge still shows the request
  }
}

function cancelAllApprovals(): void {
  for (const entry of [...pendingApprovals.values()]) entry.finish("cancelled");
}

/** Popup: the pending requests, oldest first. */
function listApprovals(): ApprovalView[] {
  return [...pendingApprovals.values()].map((entry) => entry.view);
}

/** Popup: the human's decision on one request. */
function decideApproval(id: unknown, approved: unknown): CommandResult {
  const entry = typeof id === "string" ? pendingApprovals.get(id) : undefined;
  if (!entry) return { success: false, error: "This request is no longer pending" };
  if (typeof approved !== "boolean") return { success: false, error: "approved must be a boolean" };
  entry.finish(approved ? "approved" : "denied");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Captcha
// ---------------------------------------------------------------------------

/**
 * Tabs showing a captcha banner for a server command (requestId → tabId),
 * so that cancel_human_wait can withdraw it after the server stopped waiting.
 */
const humanWaits = new Map<string, number>();

/**
 * Run a banner-showing handler on a pinned tab and remember that tab under
 * the command's requestId while the handler waits for the human.
 */
async function trackHumanWait(
  requestId: number | string | undefined,
  tabId: number | undefined,
  run: (tabId: number | undefined) => Promise<CommandResult>,
): Promise<CommandResult> {
  let pinned = tabId;
  try {
    pinned = (await resolveTab(tabId))?.id ?? tabId;
  } catch {
    // run() reports the missing tab itself
  }
  const key = requestId === undefined ? undefined : String(requestId);
  if (key !== undefined && pinned !== undefined) humanWaits.set(key, pinned);
  try {
    return await run(pinned);
  } finally {
    if (key !== undefined) humanWaits.delete(key);
  }
}

/**
 * The server gave up waiting on a command: withdraw its approval request,
 * or the captcha banner it showed.
 */
async function cancelHumanWait(data: Record<string, unknown> = {}): Promise<CommandResult> {
  const target = data.requestId;
  if (typeof target !== "string" && typeof target !== "number") {
    return { success: true, cancelled: false };
  }
  const key = String(target);
  for (const entry of pendingApprovals.values()) {
    if (entry.requestId === key) {
      entry.finish("cancelled");
      return { success: true, cancelled: true };
    }
  }
  const tabId = humanWaits.get(key);
  if (tabId === undefined) return { success: true, cancelled: false };
  return sendToContentScript(tabId, { action: "cancelHumanWait" });
}

async function solveCaptcha(
  tabId: number | undefined,
  data: { detectOnly?: boolean } & Record<string, unknown> = {},
): Promise<CommandResult> {
  if (!data.detectOnly) {
    try {
      if (browser.notifications) {
        await browser.notifications.create({
          type: "basic",
          title: t("notifyCaptchaTitle"),
          message: t("notifyCaptchaMessage"),
          iconUrl: browser.runtime.getURL("icons/icon.svg"),
        });
      }
    } catch {
      // Notifications unavailable
    }
  }
  return sendToContentScript(tabId, { action: "solveCaptcha", ...data });
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Content script messages
browser.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: browser.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean | void => {
    const msg = message as { target?: string; type?: string; [key: string]: unknown };
    if (msg.type === APPROVAL_MESSAGE.LIST || msg.type === APPROVAL_MESSAGE.DECIDE) {
      // Only the toolbar popup may see or answer approval requests: never a
      // content script (page JS, fox_execute_script), and for a decision not
      // even an extension page loaded in a tab.
      if (!isExtensionPage(sender) || (msg.type === APPROVAL_MESSAGE.DECIDE && sender.tab)) {
        console.error("[KitsuneMCP] Refused approval message from", sender.url);
        sendResponse({ success: false, error: "Approval requests are answered in the KitsuneMCP toolbar popup" });
        return;
      }
      sendResponse(
        msg.type === APPROVAL_MESSAGE.LIST
          ? { success: true, approvals: listApprovals() }
          : decideApproval(msg.id, msg.approved),
      );
      return;
    }
    if (msg.type === LOG_RECORD_MESSAGE) {
      // A batch from the top frame of a tab whose logging is on. The page
      // URL checked is the browser's (sender), never one from the message.
      const senderTabId = sender.tab?.id;
      const accepted =
        sender.frameId === TOP_FRAME_ID &&
        senderTabId !== undefined &&
        isLoggingTab(senderTabId);
      if (accepted) acceptLogRecords(senderTabId, [sender.tab?.url, sender.url], msg as { console?: unknown; network?: unknown });
      sendResponse({ accepted });
      return;
    }
    if (msg.type === LOGGING_STATE_QUERY) {
      // Answered from the sender the browser reports (logging.ts).
      sendResponse(loggingStateFor(sender));
      return;
    }
    if (msg.target === "background") {
      // Only the Extension's own pages (the popup) may drive the dispatcher
      // directly. Content scripts -- including code run by fox_execute_script
      // -- could otherwise call every handler without the containerScope /
      // protectedUrlPatterns the MCP Server attaches (Layer 0 bypass).
      if (!isExtensionPage(sender)) {
        console.error("[KitsuneMCP] Refused background command from", sender.url);
        sendResponse({ success: false, error: "Background commands are only accepted from extension pages" });
        return;
      }
      handleCommand({
        ...msg,
        tabId: sender.tab?.id,
      } as NativeMessage).then(sendResponse);
      return true;
    }
  },
);

/**
 * True for a message from one of this Extension's own pages (popup, or the
 * popup page opened in a tab). Content scripts report the web page's URL.
 */
function isExtensionPage(sender: browser.runtime.MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(browser.runtime.getURL("/"))
  );
}

// Logging tabs: inject the content script at document_start as soon as a new
// document commits, so the page hooks catch the page's first scripts (the
// manifest content script only runs at document_end). Best effort: the
// injection is asynchronous and may still land after some early scripts.
// The injected copy confirms the state with the background before keeping
// anything (resumeLoggingFromBackground); the later manifest copy is a no-op
// thanks to the __fox_injected guard (same sandbox).
browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== TOP_FRAME_ID) return;
  if (!wantsEarlyInjection(details.tabId, details.url)) return;
  console.log(`[KitsuneMCP] Early logging injection requested (tab ${details.tabId})`);
  // dist/content.js is self-contained (url-rule.ts is bundled into it).
  browser.tabs
    .executeScript(details.tabId, { file: "/dist/content.js", runAt: "document_start", frameId: TOP_FRAME_ID })
    .then(() => {
      console.log(`[KitsuneMCP] Early logging injection done (tab ${details.tabId})`);
    })
    .catch((error: unknown) => {
      // Page where extensions cannot inject (e.g. addons.mozilla.org, or
      // a non-web URL). Nothing to resume there.
      console.warn(
        `[KitsuneMCP] Early logging injection failed (tab ${details.tabId}):`,
        (error as Error).message,
      );
    });
});

browser.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
});

// Clicking an approval notification opens the toolbar popup where it is
// answered (best effort: Firefox may refuse openPopup outside a user action).
browser.notifications?.onClicked?.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return;
  browser.browserAction.openPopup?.()?.catch(() => {});
});

// Block external messages: no other extension may send commands (prevents
// command injection through runtime.sendMessage from another extension)
browser.runtime.onMessageExternal.addListener(
  (
    _message: unknown,
    sender: browser.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    console.error("[KitsuneMCP] Refused external message from", sender?.id);
    sendResponse({ success: false, error: "External messages are not accepted" });
    return false;
  },
);

// Context menus
browser.contextMenus.create({
  id: "kitsune-screenshot",
  title: t("menuScreenshot"),
  contexts: ["page"],
});

browser.contextMenus.create({
  id: "kitsune-inspect",
  title: t("menuInspect"),
  contexts: ["all"],
});

browser.contextMenus.onClicked.addListener(
  (
    info: { menuItemId: string; pageX?: number; pageY?: number; frameId?: number },
    tab: browser.tabs.Tab,
  ): void => {
    if (info.menuItemId === "kitsune-screenshot") {
      void takeScreenshot(tab.id).then((result) => {
        if (!result.success || !nativePort) return;
        try {
          nativePort.postMessage({
            action: "screenshotTaken",
            data: result.imageData,
            tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
          });
        } catch (error) {
          console.warn("[KitsuneMCP] Could not hand the screenshot to the native host:", (error as Error).message);
        }
      });
    } else if (info.menuItemId === "kitsune-inspect") {
      // The frame the menu was opened in (its content script handles it).
      browser.tabs
        .sendMessage(
          tab.id,
          { action: "inspectElement", x: info.pageX, y: info.pageY },
          { frameId: info.frameId ?? TOP_FRAME_ID },
        )
        .catch((error: unknown) => {
          // No content script in that frame (e.g. a page extensions cannot enter)
          console.warn("[KitsuneMCP] Inspect element failed:", (error as Error).message);
        });
    }
  },
);

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
connectNativeHost();
// Session count changes without any event reaching the Extension.
setInterval(() => { void refreshSetupState(); }, SETUP_REFRESH_MS);
console.log("[KitsuneMCP] Background script initialized");
