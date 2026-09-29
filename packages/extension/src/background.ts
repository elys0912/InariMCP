// KitsuneMCP Background Script
// Handles native messaging, tab management, and coordination with content scripts
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NativeMessage {
  // Numeric for extension-initiated requests (sendToNativeHost), string for
  // MCP Server commands (BrowserCommand.requestId).
  requestId?: number | string;
  action?: string;
  tabId?: number;
  data?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface CommandResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

interface ScreenshotOptions {
  format?: string;
  quality?: number;
  fullPage?: boolean;
  allowFocus?: boolean;
  restoreFocus?: boolean;
  includeData?: boolean;
  urlPattern?: string;
}

interface GetAllTabsOptions {
  currentWindowOnly?: boolean;
  includeFavicon?: boolean;
  urlPattern?: string;
  limit?: number;
}

interface FindTabsOptions {
  url?: string;
  urlPattern?: string;
  title?: string;
  active?: boolean;
  audible?: boolean;
}

interface RefreshOptions {
  bypassCache?: boolean;
  waitForLoad?: boolean;
}

interface ReloadAllOptions {
  urlPattern?: string;
  bypassCache?: boolean;
}

interface ReloadByUrlOptions {
  url?: string;
  urlPattern?: string;
  bypassCache?: boolean;
}

/** Layer 0 container scope as sent by the MCP Server. */
interface ContainerScope {
  containerName: string;
}

/**
 * Resolved container scope. cookieStoreId is null when the agent container
 * does not exist yet (then no existing tab is in scope).
 */
interface ScopeFilter {
  containerName: string;
  cookieStoreId: string | null;
}

type ScopeDecision =
  | { allowed: true; scope: ScopeFilter; tabId: number | undefined }
  | { allowed: false; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUTS = {
  COMMAND: 30_000,
  RECONNECT_MAX: 30_000,
  RECONNECT_INITIAL: 1_000,
  SCREENSHOT_DELAY: 150,
  NAVIGATION: 30_000,
} as const;

const EXCLUDED_URL_PREFIXES = ["about:", "moz-extension:"] as const;

function shouldSkipTab(url: string | undefined): boolean {
  if (!url) return true;
  return EXCLUDED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function matchesPattern(url: string | undefined, pattern: string): boolean {
  if (!url) return false;
  return new RegExp(pattern).test(url);
}

function waitForTabComplete(tabId: number, timeoutMs = TIMEOUTS.NAVIGATION): Promise<void> {
  return new Promise((resolve) => {
    const listener = (
      updatedTabId: number,
      changeInfo: browser.tabs.TabChangeInfo,
    ): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(listener);

    setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
  });
}

/**
 * Wait until a tab satisfies `isLoaded`, checked on every onUpdated event and
 * once against the current state. The listener is added before that check,
 * so a load that finishes in between is not missed. Resolves on timeout too.
 */
function waitForTabState(
  tabId: number,
  isLoaded: (tab: browser.tabs.Tab) => boolean,
  timeoutMs = TIMEOUTS.NAVIGATION,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (
      updatedTabId: number,
      _changeInfo: browser.tabs.TabChangeInfo,
      tab: browser.tabs.Tab,
    ): void => {
      if (updatedTabId === tabId && isLoaded(tab)) finish();
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.get(tabId).then((tab) => { if (isLoaded(tab)) finish(); }, finish);
  });
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

// Console / network logging: tabs where it is switched on, with the
// protected URL patterns attached to start_logging (empty when the server
// sent none, i.e. confirm_protected_actions is off). The records themselves
// stay in that tab's top-frame content script; this map only outlives
// reloads / navigations, so the next document resumes recording (content
// script query + early injection, see "Event listeners") -- except while the
// tab is on a protected page, where recording is paused. Cleared by
// stop_logging or when the tab closes.
interface LoggingTabState {
  patterns: RegExp[];
}
const loggingTabs = new Map<number, LoggingTabState>();
const TOP_FRAME_ID = 0;
/** Message type of the content script's "is logging on for my tab?" query. */
const LOGGING_STATE_QUERY = "kitsune:loggingState";

// Reconnection settings
let reconnectAttempts = 0;
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
    reconnectAttempts = 0;
    console.log("[KitsuneMCP] Connected to native host");

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
  isConnected = false;
  hostConfirmed = false;
  nativePort = null;

  for (const [, entry] of pendingRequests) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error("Native host disconnected - reconnecting..."));
  }
  pendingRequests.clear();

  void refreshSetupState();
  scheduleReconnect();
}

function handleNativeMessage(raw: unknown): void {
  const message = raw as NativeMessage;
  console.log("[KitsuneMCP] Received from native host:", message);

  if (!hostConfirmed) {
    hostConfirmed = true;
    lastHostError = null;
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

/**
 * What the user has to do next, as far as the Extension can tell:
 *   hostMissing  Native Host not registered with Firefox (installer not run)
 *   hostError    Native Host registered but failed (e.g. stale node path)
 *   hostOutdated Native Host from an older checkout (no session count): tools
 *                work, but the checkout needs git pull + npm run build
 *   daemonDown   Native Host runs, but the MCP daemon does not answer
 *   noSession    all set on the Firefox side, no Claude Code session connected
 *   ready        at least one Claude Code session connected
 */
type SetupState =
  | { kind: "connecting" }
  | { kind: "hostMissing"; error: string }
  | { kind: "hostError"; error: string }
  | { kind: "hostOutdated"; serverUrl?: string }
  | { kind: "daemonDown"; serverUrl?: string }
  | { kind: "noSession"; serverUrl?: string; registerCommand?: string }
  | { kind: "ready"; serverUrl?: string; relays: number };

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

function applyBadge(state: SetupState): void {
  const attention = state.kind !== "ready" && state.kind !== "connecting";
  const titleKey = BADGE_TITLE_KEYS[state.kind];
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
// Tab resolution helper
// ---------------------------------------------------------------------------

async function resolveTab(
  tabId: number | undefined,
): Promise<browser.tabs.Tab> {
  if (tabId) return browser.tabs.get(tabId);
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0];
}

// ---------------------------------------------------------------------------
// Content script messaging
// ---------------------------------------------------------------------------

async function sendToContentScript(
  tabId: number | undefined,
  message: Record<string, unknown>,
  frameId?: number,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    const result = (await (frameId === undefined
      ? browser.tabs.sendMessage(tab.id, message)
      : browser.tabs.sendMessage(tab.id, message, { frameId }))) as Record<string, unknown>;
    return { success: true, ...result };
  } catch (error) {
    const msg = (error as Error).message;
    return {
      success: false,
      error: NO_CONTENT_SCRIPT.test(msg) ? NO_CONTENT_SCRIPT_MESSAGE : msg,
    };
  }
}

/** tabs.sendMessage error when the tab has no content script to answer. */
const NO_CONTENT_SCRIPT = /Receiving end does not exist/i;
const NO_CONTENT_SCRIPT_MESSAGE =
  "KitsuneMCP cannot reach this page: Firefox does not let extensions into it " +
  "(JSON viewer, about: pages, addons.mozilla.org, other extensions' pages), " +
  "or it was opened before KitsuneMCP was installed or updated (reload the tab). " +
  "Tab-level tools such as fox_screenshot and fox_get_tabs still work.";

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

  // Container scope check (Layer 0). The MCP Server attaches
  // `containerScope` to every command when container_scope.enabled is true.
  const containerScope = parseContainerScope(message.containerScope);
  let scope: ScopeFilter | null = null;
  if (containerScope) {
    const decision = await enforceContainerScope(action, tabId, containerScope);
    if (!decision.allowed) {
      result = outOfScope(decision.error);
      postWireResponse(message, result);
      return result;
    }
    scope = decision.scope;
    // Pin the tab that passed the check so the handler cannot drift to a
    // different active tab between the check and the operation.
    if (decision.tabId !== undefined) {
      tabId = decision.tabId;
    }
  }
  const protectedPatterns = parseProtectedPatterns(message.protectedUrlPatterns);

  // Protected-domain check for single-tab captures (screenshot and
  // scroll_and_capture), against the real URL of the target tab (not the
  // server's last navigated URL). The server only attaches the patterns when
  // confirm_protected_actions is true.
  if (
    (action === "screenshot" || action === "scrollAndCapture") &&
    protectedPatterns.length > 0
  ) {
    const refusal = await checkProtectedScreenshot(tabId, protectedPatterns);
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
        result = await screenshotAllTabs(data as ScreenshotOptions, scope, protectedPatterns);
        break;
      case "refresh":
      case "reload":
        result = await refreshTab(tabId, data as RefreshOptions);
        break;
      case "hardRefresh":
        result = await hardRefreshTab(tabId);
        break;
      case "reloadAll":
        result = await reloadAllTabs(data as ReloadAllOptions, scope);
        break;
      case "reloadByUrl":
        result = await reloadTabsByUrl(data as ReloadByUrlOptions, scope);
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
        result = await requestApproval(tabId, data);
        break;
      case "solveCaptcha":
        result = await solveCaptcha(tabId, data as { detectOnly?: boolean });
        break;
      // Content-script-forwarded actions
      case "getValue":
      case "setValue":
      case "selectOption":
      case "hover":
      case "getAttribute":
      case "focus":
      case "getComputedStyles":
      case "getBoundingRect":
      case "waitForChange":
      case "observeElement":
      case "stopObserving":
      case "scrollAndCapture":
      case "clickAndWait":
      case "pressKey":
      case "getText":
        result = await sendToContentScript(tabId, { action, ...data });
        break;
      // Page-activity tracking and console / network logging live in the
      // top frame's content script (frame 0), so every command for them goes
      // there -- not to whichever frame happens to answer first.
      case "waitForNetworkIdle":
        result = await sendToContentScript(tabId, { action, ...data }, TOP_FRAME_ID);
        break;
      case "startLogging": {
        const tab = await resolveTab(tabId);
        // Same rule as a single-tab screenshot: refuse on a protected page,
        // judged by the tab's real URL.
        const refusal = await checkProtectedScreenshot(tab.id, protectedPatterns);
        if (refusal) {
          result = refusal;
          break;
        }
        result = await sendToContentScript(
          tab.id,
          {
            action: "startLogging",
            ...data,
            protectedPatterns: protectedPatterns.map((p) => p.source),
          },
          TOP_FRAME_ID,
        );
        if (result.success) loggingTabs.set(tab.id, { patterns: protectedPatterns });
        break;
      }
      case "stopLogging": {
        const tab = await resolveTab(tabId);
        loggingTabs.delete(tab.id);
        result = await sendToContentScript(tab.id, { action: "stopLogging" }, TOP_FRAME_ID);
        break;
      }
      case "getConsoleLogs":
      case "getNetworkLogs": {
        const tab = await resolveTab(tabId);
        result = await sendToContentScript(tab.id, { action, ...data }, TOP_FRAME_ID);
        if (result.success) {
          result = {
            ...result,
            pausedForProtectedDomain: isLoggingPausedForTab(tab, protectedPatterns),
          };
        }
        break;
      }
      case "clearLogs":
        result = await sendToContentScript(
          tabId,
          { action: "clearLogs", ...data },
          TOP_FRAME_ID,
        );
        break;
      case "list_containers":
        result = await listContainers(scope);
        break;
      case "open_in_container":
        result = await openInContainer(data as { url: string; containerName?: string; cookieStoreId?: string; color?: string; icon?: string; active?: boolean }, scope);
        break;
      case "find_text": {
        const findQuery = (data as { query: string }).query;
        const caseSensitive = (data as { caseSensitive?: boolean }).caseSensitive ?? false;
        const entireWord = (data as { entireWord?: boolean }).entireWord ?? false;
        const includeRectData = (data as { includeRectData?: boolean }).includeRectData ?? false;

        const tab = await resolveTab(tabId);
        const findResult = await browser.find.find(findQuery, {
          tabId: tab.id,
          caseSensitive,
          entireWord,
          includeRangeData: true,
          includeRectData,
        });

        result = {
          success: true,
          count: findResult.count,
          rangeData: findResult.rangeData,
          rectData: includeRectData ? findResult.rectData : undefined,
        };
        break;
      }
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

type ResolvedAction =
  | { kind: "action"; action: string | undefined }
  | { kind: "notImplemented"; wireName: string };

/**
 * Convert a wire action name (snake_case, see action-map.ts) to the internal
 * name. Names not in the table pass through unchanged: internal callers
 * (popup, content script) already use internal names such as "status", and
 * anything unknown still ends in the dispatcher's "Unknown action" branch.
 */
function resolveWireAction(raw: string | undefined): ResolvedAction {
  if (raw === undefined) return { kind: "action", action: undefined };
  const mapped = WIRE_ACTION_MAP.get(raw);
  if (mapped === null) return { kind: "notImplemented", wireName: raw };
  return { kind: "action", action: mapped ?? raw };
}

/** Response envelope sent back over Native Messaging (BrowserResponse). */
interface WireResponse {
  requestId: number | string;
  success: boolean;
  error?: string;
  safetyDecision?: string;
  data?: Record<string, unknown>;
}

/**
 * Wrap a handler result in the wire contract: success / error /
 * safetyDecision stay top-level, every other field goes into `data`.
 */
function toWireResponse(requestId: number | string, result: CommandResult): WireResponse {
  const { success, error, safetyDecision, ...rest } = result;
  const response: WireResponse = { requestId, success };
  if (typeof error === "string") response.error = error;
  if (typeof safetyDecision === "string") response.safetyDecision = safetyDecision;
  if (Object.keys(rest).length > 0) response.data = rest;
  return response;
}

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

/**
 * Refuse a screenshot when the target tab (same resolution as the container
 * scope check / takeScreenshot) is on a protected domain. Returns null when
 * the capture may proceed. Fails closed if the tab cannot be resolved.
 */
async function checkProtectedScreenshot(
  tabId: number | undefined,
  patterns: RegExp[],
): Promise<CommandResult | null> {
  let tab: browser.tabs.Tab | undefined;
  try {
    tab = await resolveTab(tabId);
  } catch {
    tab = undefined;
  }
  if (!tab) {
    return {
      success: false,
      error: "Could not resolve the target tab for the protected domain check",
    };
  }
  const tabUrl = tab.url;
  const matched = findProtectedMatch(tabUrl, patterns);
  if (tabUrl && matched) {
    // url / matchedPattern end up in the wire response's `data`, so the
    // server can name the page that was actually refused (its own
    // last-known URL may be stale).
    return {
      success: false,
      safetyDecision: "confirmation_required",
      error: "Protected domain: confirmation required",
      url: tabUrl,
      matchedPattern: matched.source,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

async function takeScreenshot(
  tabId: number | undefined,
  options: ScreenshotOptions = {},
): Promise<CommandResult> {
  try {
    const currentTab = (
      await browser.tabs.query({ active: true, currentWindow: true })
    )[0];
    const targetTab = tabId ? await browser.tabs.get(tabId) : currentTab;

    const needsFocus = tabId !== undefined && tabId !== currentTab?.id;
    let originalActiveTab: browser.tabs.Tab | null = null;

    if (needsFocus && options.allowFocus !== false) {
      originalActiveTab = currentTab;
      await browser.tabs.update(targetTab.id, { active: true });
      await new Promise((r) => setTimeout(r, TIMEOUTS.SCREENSHOT_DELAY));
    }

    try {
      const dataUrl = await browser.tabs.captureVisibleTab(
        targetTab.windowId,
        {
          format: options.format || "png",
          quality: options.quality || 90,
        },
      );

      if (options.fullPage) {
        return await captureFullPageImage(targetTab, dataUrl, options);
      }

      return {
        success: true,
        imageData: dataUrl,
        type: "visible",
        tab: {
          id: targetTab.id,
          url: targetTab.url,
          title: targetTab.title,
        },
        wasFocused: needsFocus,
      };
    } finally {
      if (originalActiveTab && options.restoreFocus !== false) {
        await browser.tabs.update(originalActiveTab.id, { active: true });
      }
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Full-page capture. The content script only reports the page dimensions
 * ("captureFullPage"), so the image itself is taken with captureTab's `rect`
 * option. If that fails (page too large for a single canvas, content script
 * unavailable), the visible-area capture is
 * returned instead and `fullPageCaptured` is false.
 */
async function captureFullPageImage(
  targetTab: browser.tabs.Tab,
  visibleDataUrl: string,
  options: ScreenshotOptions,
): Promise<CommandResult> {
  const tabInfo = {
    id: targetTab.id,
    url: targetTab.url,
    title: targetTab.title,
  };
  let dimensions: Record<string, unknown> | null = null;
  try {
    dimensions = (await browser.tabs.sendMessage(targetTab.id, {
      action: "captureFullPage",
      format: options.format || "png",
    })) as Record<string, unknown>;
    const width = dimensions.scrollWidth;
    const height = dimensions.scrollHeight;
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      const fullDataUrl = await browser.tabs.captureTab(targetTab.id, {
        format: options.format || "png",
        quality: options.quality || 90,
        rect: { x: 0, y: 0, width, height },
      });
      return {
        success: true,
        imageData: fullDataUrl,
        type: "fullPage",
        fullPageCaptured: true,
        pageDimensions: dimensions,
        tab: tabInfo,
      };
    }
  } catch (error) {
    console.warn("[KitsuneMCP] Full-page capture failed, using visible area:", error);
  }
  return {
    success: true,
    imageData: visibleDataUrl,
    type: "fullPage",
    fullPageCaptured: false,
    pageDimensions: dimensions,
    tab: tabInfo,
  };
}

async function screenshotAllTabs(
  options: ScreenshotOptions = {},
  scope: ScopeFilter | null = null,
  protectedPatterns: RegExp[] = [],
): Promise<CommandResult> {
  try {
    const tabs = await browser.tabs.query({});

    let targetTabs = tabs.filter((t) => !shouldSkipTab(t.url) && isTabInScope(t, scope));

    if (options.urlPattern) {
      targetTabs = targetTabs.filter((t) => matchesPattern(t.url, options.urlPattern!));
    }

    // Protected domains (banking, payments, ...) are excluded by default.
    // Only the count is reported -- never the URL or title of excluded tabs.
    const beforeProtected = targetTabs.length;
    if (protectedPatterns.length > 0) {
      targetTabs = targetTabs.filter((t) => !matchesAnyPattern(t.url, protectedPatterns));
    }
    const excludedProtected = beforeProtected - targetTabs.length;

    const results: Record<string, unknown>[] = [];

    for (const tab of targetTabs) {
      try {
        const dataUrl = await browser.tabs.captureTab(tab.id, {
          format: options.format || "png",
          quality: options.quality || 90,
        });

        results.push({
          success: true,
          tabId: tab.id,
          url: tab.url ?? "",
          title: tab.title ?? "",
          imageData: options.includeData ? dataUrl : undefined,
          timestamp: Date.now(),
        });
      } catch (e) {
        console.warn(`captureTab failed for tab ${tab.id} (${tab.url}):`, e);
        results.push({
          success: false,
          tabId: tab.id,
          url: tab.url ?? "",
          error: (e as Error).message,
        });
      }
    }

    return {
      success: true,
      screenshots: results,
      count: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      excludedProtected,
      ...(excludedProtected > 0
        ? {
          excludedReason:
            "Tabs matching protected_url_patterns in safety.json were not captured " +
            "(set confirm_protected_actions to false to include them).",
        }
        : {}),
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Approval & captcha
// ---------------------------------------------------------------------------

async function requestApproval(
  tabId: number | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  try {
    if (browser.notifications) {
      await browser.notifications.create({
        type: "basic",
        title: t("notifyApprovalTitle"),
        message: (
          (data.message as string) || t("notifyApprovalDefault")
        ).slice(0, 200),
        iconUrl: browser.runtime.getURL("icons/icon.svg"),
      });
    }
  } catch {
    // Notifications unavailable -- the in-page banner still works
  }
  return sendToContentScript(tabId, { action: "requestApproval", ...data });
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
// Navigation
// ---------------------------------------------------------------------------

async function navigateTo(
  tabId: number | undefined,
  data: { url: string },
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    await browser.tabs.update(tab.id, { url: data.url });
    await waitForTabComplete(tab.id);
    // Report the URL actually loaded (after redirects), so the server's guard
    // tracks the real page; fall back to the requested URL.
    let finalUrl = data.url;
    try {
      const updated = await browser.tabs.get(tab.id);
      if (updated.url) finalUrl = updated.url;
    } catch {
      // keep the requested URL
    }
    return { success: true, url: finalUrl };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function navigateNewTab(
  data: { url: string; waitForLoad?: boolean },
  scope: ScopeFilter | null,
): Promise<CommandResult> {
  const created = await createNewTab({ url: data.url, active: true }, scope);
  const tabId = (created.tab as { id?: number } | undefined)?.id;
  if (!created.success || tabId === undefined) return created;
  try {
    if (data.waitForLoad !== false) {
      // A tab from tabs.create({ url }) can first report status "complete"
      // while still on the initial about:blank, before the requested URL
      // starts loading (seen on the first new tab after Firefox starts).
      // Treat about:blank as loaded only when it is what was asked for.
      const wantsBlank = data.url === "about:blank";
      await waitForTabState(
        tabId,
        (tab) => tab.status === "complete" && (wantsBlank || tab.url !== "about:blank"),
      );
    }
    // Same shape as navigateTo (url after redirects), plus the new tab's id.
    const updated = await browser.tabs.get(tabId);
    return { success: true, url: updated.url || data.url, tabId };
  } catch (error) {
    return { success: false, error: (error as Error).message, tabId };
  }
}

async function navigateHistory(
  tabId: number | undefined,
  direction: "back" | "forward",
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (direction === "back") {
      await browser.tabs.goBack(tab.id);
    } else {
      await browser.tabs.goForward(tab.id);
    }
    await new Promise((r) => setTimeout(r, 300));
    const updated = await browser.tabs.get(tab.id);
    return { success: true, url: updated.url, title: updated.title };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Element interaction (forwarded to content script)
// ---------------------------------------------------------------------------

async function performClick(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "click", ...data });
}

async function performType(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "type", ...data });
}

async function performScroll(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "scroll", ...data });
}

async function getPageInfo(
  tabId: number | undefined,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    const result = (await browser.tabs.sendMessage(tab.id, {
      action: "getPageInfo",
    })) as Record<string, unknown>;
    return {
      success: true,
      tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
      ...result,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function getElements(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "getElements", ...data });
}

async function executeScript(
  tabId: number | undefined,
  data: { script: string },
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    const result = await browser.tabs.executeScript(tab.id, {
      code: data.script,
    });
    return { success: true, result: result[0] };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function highlightElement(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "highlight", ...data });
}

async function waitForElement(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "waitForElement", ...data });
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

async function getAllTabs(
  options: GetAllTabsOptions = {},
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const currentWindowOnly = options.currentWindowOnly !== false;
    const includeFavicon = options.includeFavicon === true;
    const urlPattern = options.urlPattern
      ? new RegExp(options.urlPattern)
      : null;
    const limit = Number.isInteger(options.limit)
      ? (options.limit as number)
      : 50;

    const queryOpts: browser.tabs.QueryInfo = currentWindowOnly
      ? { currentWindow: true }
      : {};
    let tabs = (await browser.tabs.query(queryOpts)).filter((t) => isTabInScope(t, scope));
    const windows = await browser.windows.getAll();
    const windowMap = new Map(windows.map((w) => [w.id, w]));

    const totalMatched = urlPattern
      ? tabs.filter((t) => t.url && urlPattern.test(t.url)).length
      : tabs.length;
    if (urlPattern) {
      tabs = tabs.filter((t) => t.url && urlPattern.test(t.url));
    }

    const truncated = tabs.length > limit;
    const pageTabs = tabs.slice(0, limit);

    return {
      success: true,
      tabs: pageTabs.map((t) => {
        const win = windowMap.get(t.windowId);
        const base: Record<string, unknown> = {
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
          pinned: t.pinned,
          status: t.status,
          audible: t.audible,
        };
        if (includeFavicon) {
          base.favIconUrl = t.favIconUrl;
        }
        if (!currentWindowOnly) {
          base.windowFocused = win?.focused || false;
        }
        return base;
      }),
      returnedTabs: pageTabs.length,
      truncated,
      scope: currentWindowOnly ? "current_window" : "all_windows",
      windowCount: windows.length,
      totalTabs: totalMatched,
      summary: {
        active: tabs.filter((t) => t.active).length,
        loading: tabs.filter((t) => t.status === "loading").length,
        discarded: tabs.filter((t) => t.discarded).length,
        audible: tabs.filter((t) => t.audible).length,
      },
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function getTabInfo(tabId: number): Promise<CommandResult> {
  try {
    const tab = await browser.tabs.get(tabId);
    const win = await browser.windows.get(tab.windowId);

    let pageInfo: unknown = null;
    try {
      pageInfo = await browser.tabs.sendMessage(tabId, {
        action: "getPageInfo",
      });
    } catch {
      pageInfo = { error: "Content script not available" };
    }

    return {
      success: true,
      tab: {
        id: tab.id,
        url: tab.url ?? "",
        title: tab.title ?? "",
        active: tab.active,
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
        status: tab.status,
        discarded: tab.discarded,
        audible: tab.audible,
        favIconUrl: tab.favIconUrl,
      },
      window: {
        id: win.id,
        focused: win.focused,
        state: win.state,
        type: win.type,
      },
      pageInfo,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function findTabs(
  options: FindTabsOptions,
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const tabs = await browser.tabs.query({});
    let filtered = tabs.filter((t) => isTabInScope(t, scope));

    if (options.url) {
      filtered = filtered.filter((t) => t.url?.startsWith(options.url!));
    }
    if (options.urlPattern) {
      filtered = filtered.filter((t) => matchesPattern(t.url, options.urlPattern!));
    }
    if (options.title) {
      const titleLower = options.title.toLowerCase();
      filtered = filtered.filter((t) =>
        t.title?.toLowerCase().includes(titleLower),
      );
    }
    if (options.active !== undefined) {
      filtered = filtered.filter((t) => t.active === options.active);
    }
    if (options.audible !== undefined) {
      filtered = filtered.filter((t) => t.audible === options.audible);
    }

    return {
      success: true,
      tabs: filtered.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        status: t.status,
      })),
      count: filtered.length,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function createNewTab(
  data: {
    url?: string;
    active?: boolean;
  },
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    // With container scope, the new tab must be born inside the agent
    // container -- otherwise every follow-up command on it is out_of_scope.
    let cookieStoreId: string | undefined;
    if (scope) {
      cookieStoreId = scope.cookieStoreId ?? await ensureScopeContainer(scope);
    }
    const tab = await browser.tabs.create({
      url: data.url || "about:blank",
      active: data.active !== false,
      ...(cookieStoreId ? { cookieStoreId } : {}),
    });
    return {
      success: true,
      tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
      // The new tab is usually still about:blank here; report the requested URL.
      url: data.url || "about:blank",
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function closeTab(tabId: number): Promise<CommandResult> {
  try {
    await browser.tabs.remove(tabId);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function focusTab(tabId: number): Promise<CommandResult> {
  try {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Refresh / Reload
// ---------------------------------------------------------------------------

async function refreshTab(
  tabId: number | undefined,
  options: RefreshOptions = {},
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);

    await browser.tabs.reload(tab.id, {
      bypassCache: options.bypassCache || false,
    });

    if (options.waitForLoad !== false) {
      await waitForTabComplete(tab.id);
      return {
        success: true,
        refreshed: true,
        tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
        bypassCache: options.bypassCache || false,
      };
    }

    return {
      success: true,
      refreshed: true,
      tab: { id: tab.id, url: tab.url ?? "" },
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function hardRefreshTab(
  tabId: number | undefined,
): Promise<CommandResult> {
  return refreshTab(tabId, { bypassCache: true });
}

async function reloadAllTabs(
  options: ReloadAllOptions = {},
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const tabs = await browser.tabs.query({});
    const results: { id: number; url: string; reloaded: boolean }[] = [];

    for (const tab of tabs) {
      if (shouldSkipTab(tab.url)) continue;
      if (!isTabInScope(tab, scope)) continue;

      if (options.urlPattern) {
        if (!matchesPattern(tab.url, options.urlPattern)) continue;
      }

      await browser.tabs.reload(tab.id, {
        bypassCache: options.bypassCache || false,
      });
      results.push({ id: tab.id, url: tab.url ?? "", reloaded: true });
    }

    return {
      success: true,
      reloadedCount: results.length,
      tabs: results,
      bypassCache: options.bypassCache || false,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function reloadTabsByUrl(
  options: ReloadByUrlOptions,
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    if (!options.url && !options.urlPattern) {
      return { success: false, error: "Must provide url or urlPattern" };
    }

    const tabs = await browser.tabs.query({});
    const results: { id: number; url: string; reloaded: boolean }[] = [];

    for (const tab of tabs) {
      if (!isTabInScope(tab, scope)) continue;
      let matches = false;

      if (options.url) {
        matches = !!tab.url &&
          (tab.url === options.url || tab.url.startsWith(options.url));
      } else if (options.urlPattern) {
        matches = matchesPattern(tab.url, options.urlPattern);
      }

      if (matches) {
        await browser.tabs.reload(tab.id, {
          bypassCache: options.bypassCache !== false,
        });
        results.push({ id: tab.id, url: tab.url ?? "", reloaded: true });
      }
    }

    return {
      success: true,
      reloadedCount: results.length,
      tabs: results,
      bypassCache: options.bypassCache !== false,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Container helpers
// ---------------------------------------------------------------------------

/** Parse the `containerScope` field attached by the MCP Server. */
function parseContainerScope(raw: unknown): ContainerScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const name = (raw as Record<string, unknown>).containerName;
  return typeof name === "string" && name !== "" ? { containerName: name } : null;
}

/** Compile the `protectedUrlPatterns` field (same semantics as the server: case-insensitive). */
function parseProtectedPatterns(raw: unknown): RegExp[] {
  if (!Array.isArray(raw)) return [];
  const compiled: RegExp[] = [];
  for (const pattern of raw) {
    if (typeof pattern !== "string") continue;
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch {
      console.warn(`[KitsuneMCP] Invalid protected URL pattern ignored: ${pattern}`);
    }
  }
  return compiled;
}

/** The first protected pattern that matches the URL, if any. */
function findProtectedMatch(url: string | undefined, patterns: RegExp[]): RegExp | undefined {
  if (!url) return undefined;
  return patterns.find((p) => p.test(url));
}

/**
 * Whether logging on this tab is paused because the tab is on a protected
 * page: the tab's real URL against the patterns kept at start_logging and
 * those attached to the current command (either set matching pauses).
 */
function isLoggingPausedForTab(tab: browser.tabs.Tab, commandPatterns: RegExp[]): boolean {
  const state = loggingTabs.get(tab.id);
  if (!state) return false;
  return (
    findProtectedMatch(tab.url, state.patterns) !== undefined ||
    findProtectedMatch(tab.url, commandPatterns) !== undefined
  );
}

function matchesAnyPattern(url: string | undefined, patterns: RegExp[]): boolean {
  if (!url) return false;
  return patterns.some((p) => p.test(url));
}

function outOfScope(error: string): CommandResult {
  return { success: false, safetyDecision: "out_of_scope", error };
}

/**
 * Look up the agent container's cookieStoreId by name. Returns null when no
 * such container exists (then no existing tab can be in scope). If several
 * containers share the name, the first one is used -- the same rule as
 * open_in_container.
 */
async function findScopeContainer(containerName: string): Promise<string | null> {
  const matches = await browser.contextualIdentities.query({ name: containerName });
  const first = matches[0];
  return first ? first.cookieStoreId : null;
}

/**
 * Create the agent container on demand. Used only by tab-creating actions,
 * matching open_in_container's existing auto-create behaviour.
 */
async function ensureScopeContainer(scope: ScopeFilter): Promise<string> {
  const existing = await findScopeContainer(scope.containerName);
  if (existing) return existing;
  const created = await browser.contextualIdentities.create({
    name: scope.containerName,
    color: "toolbar",
    icon: "circle",
  });
  return created.cookieStoreId;
}

function isTabInScope(tab: browser.tabs.Tab, scope: ScopeFilter | null): boolean {
  if (scope === null) return true;
  return scope.cookieStoreId !== null && tab.cookieStoreId === scope.cookieStoreId;
}

/**
 * Actions that do not target a single tab and enforce the scope themselves
 * (by filtering tabs / containers, or by choosing the container of a new
 * tab). Every other action is treated as single-tab and checked up front,
 * so unknown actions fall into the strict branch (default deny).
 */
const SCOPE_SELF_ENFORCED_ACTIONS: ReadonlySet<string> = new Set([
  // multi-tab: targets / results filtered to the agent container
  "getTabs",
  "findTabs",
  "screenshotAllTabs",
  "reloadAll",
  "reloadByUrl",
  // new tab: created inside the agent container
  "createTab",
  // container management: restricted to the agent container
  "list_containers",
  "open_in_container",
]);

/** Actions that touch no tab and no container at all. */
const SCOPE_NO_TAB_ACTIONS: ReadonlySet<string> = new Set([
  "status",
]);

/** Internal action that targets one tab (the strict branch of the scope check). */
function isSingleTabAction(action: string): boolean {
  return !SCOPE_SELF_ENFORCED_ACTIONS.has(action) && !SCOPE_NO_TAB_ACTIONS.has(action);
}

/**
 * Layer 0 enforcement. For single-tab actions, resolves the target tab
 * (explicit tabId, else the active tab -- same logic as resolveTab()) and
 * requires its cookieStoreId to be the agent container's. Anything that
 * cannot be resolved is refused.
 */
async function enforceContainerScope(
  action: string | undefined,
  tabId: number | undefined,
  containerScope: ContainerScope,
): Promise<ScopeDecision> {
  const { containerName } = containerScope;
  let cookieStoreId: string | null;
  try {
    cookieStoreId = await findScopeContainer(containerName);
  } catch (error) {
    return {
      allowed: false,
      error: `Container scope check failed: ${(error as Error).message}`,
    };
  }
  const scope: ScopeFilter = { containerName, cookieStoreId };

  if (
    action !== undefined &&
    (SCOPE_SELF_ENFORCED_ACTIONS.has(action) || SCOPE_NO_TAB_ACTIONS.has(action))
  ) {
    return { allowed: true, scope, tabId: undefined };
  }

  if (cookieStoreId === null) {
    return {
      allowed: false,
      error:
        `Container '${containerName}' does not exist, so no tab is inside the container scope. ` +
        "Open a tab with fox_create_tab or fox_open_in_container first.",
    };
  }

  let tab: browser.tabs.Tab | undefined;
  try {
    tab = await resolveTab(tabId);
  } catch {
    tab = undefined;
  }
  if (!tab) {
    return {
      allowed: false,
      error: "Could not resolve the target tab for the container scope check",
    };
  }
  if (tab.cookieStoreId !== cookieStoreId) {
    return {
      allowed: false,
      error: `Tab ${tab.id} is outside the container scope (container '${containerName}')`,
    };
  }
  return { allowed: true, scope, tabId: tab.id };
}

async function listContainers(
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const all = await browser.contextualIdentities.query({});
    // With container scope, only the agent container is visible.
    const containers = scope
      ? all.filter((c) => c.cookieStoreId === scope.cookieStoreId)
      : all;
    return {
      success: true,
      containers: containers.map((c) => ({
        name: c.name,
        color: c.color,
        icon: c.icon,
        cookieStoreId: c.cookieStoreId,
      })),
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function openInContainer(
  data: {
    url: string;
    containerName?: string;
    cookieStoreId?: string;
    color?: string;
    icon?: string;
    active?: boolean;
  },
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    // Container scope: opening a tab in any container other than the agent
    // container is refused (user decision -- no new tabs outside the scope).
    if (scope) {
      if (data.containerName !== undefined && data.containerName !== scope.containerName) {
        return outOfScope(
          `Container '${data.containerName}' is outside the container scope ` +
          `(only '${scope.containerName}' is allowed)`,
        );
      }
      if (
        data.cookieStoreId !== undefined &&
        (scope.cookieStoreId === null || data.cookieStoreId !== scope.cookieStoreId)
      ) {
        return outOfScope(
          `cookieStoreId '${data.cookieStoreId}' is outside the container scope ` +
          `(only '${scope.containerName}' is allowed)`,
        );
      }
    }

    let storeId = data.cookieStoreId;

    if (storeId) {
      // Verify the container exists before handing the ID to tabs.create.
      try {
        await browser.contextualIdentities.get(storeId);
      } catch {
        return {
          success: false,
          error: `Container with cookieStoreId '${storeId}' does not exist`,
        };
      }
    }

    if (!storeId && data.containerName) {
      const matches = await browser.contextualIdentities.query({
        name: data.containerName,
      });
      if (matches.length > 0) {
        storeId = matches[0].cookieStoreId;
      } else {
        const created = await browser.contextualIdentities.create({
          name: data.containerName,
          color: data.color || "toolbar",
          icon: data.icon || "circle",
        });
        storeId = created.cookieStoreId;
      }
    }

    if (!storeId) {
      return {
        success: false,
        error: "Either containerName or cookieStoreId is required",
      };
    }

    const tab = await browser.tabs.create({
      url: data.url || "about:blank",
      cookieStoreId: storeId,
      active: data.active !== false,
    });

    return {
      success: true,
      tabId: tab.id,
      cookieStoreId: storeId,
      url: data.url || "about:blank",
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
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
    if (msg.type === LOGGING_STATE_QUERY) {
      // Only the top frame records (commands go to frame 0). The URL is the
      // one the browser reports for the sender (tab and document), never a
      // value supplied in the message.
      const senderTabId = sender.tab?.id;
      const state = senderTabId !== undefined ? loggingTabs.get(senderTabId) : undefined;
      if (sender.frameId !== TOP_FRAME_ID || !state) {
        sendResponse({ enabled: false });
        return;
      }
      if (
        findProtectedMatch(sender.tab?.url, state.patterns) ||
        findProtectedMatch(sender.url, state.patterns)
      ) {
        // Paused while on a protected page; resumes on the next
        // non-protected document (logging stays on for the tab).
        sendResponse({ enabled: false, pausedForProtectedDomain: true });
        return;
      }
      sendResponse({
        enabled: true,
        protectedPatterns: state.patterns.map((p) => p.source),
      });
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
  const state = loggingTabs.get(details.tabId);
  if (!state || shouldSkipTab(details.url)) return;
  // Protected page: recording is paused there, so no early hooks either.
  if (findProtectedMatch(details.url, state.patterns)) return;
  console.log(`[KitsuneMCP] Early logging injection requested (tab ${details.tabId})`);
  browser.tabs
    .executeScript(details.tabId, {
      file: "/dist/content.js",
      runAt: "document_start",
      frameId: TOP_FRAME_ID,
    })
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
  loggingTabs.delete(tabId);
});

// Block external messages (design doc 7.8 -- prevent command injection from
// other extensions)
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
    info: { menuItemId: string; pageX?: number; pageY?: number },
    tab: browser.tabs.Tab,
  ): void => {
    if (info.menuItemId === "kitsune-screenshot") {
      takeScreenshot(tab.id).then((result) => {
        if (result.success && nativePort) {
          nativePort.postMessage({
            action: "screenshotTaken",
            data: result.imageData,
            tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
          });
        }
      });
    } else if (info.menuItemId === "kitsune-inspect") {
      browser.tabs.sendMessage(tab.id, {
        action: "inspectElement",
        x: info.pageX,
        y: info.pageY,
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
