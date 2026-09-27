// KitsuneMCP Background Script
// Handles native messaging, tab management, and coordination with content scripts
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NativeMessage {
  requestId?: number;
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
  current_window_only?: boolean;
  include_favicon?: boolean;
  url_pattern?: string;
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const NATIVE_HOST_NAME = "kitsune_mcp";
let nativePort: browser.runtime.Port | null = null;
let isConnected = false;
const pendingRequests = new Map<number, PendingRequest>();
let requestCounter = 0;

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
    reconnectAttempts = 0;
    console.log("[KitsuneMCP] Connected to native host");

    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(handleDisconnect);
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
  }
  isConnected = false;
  nativePort = null;

  for (const [, entry] of pendingRequests) {
    clearTimeout(entry.timeoutId);
    entry.reject(new Error("Native host disconnected - reconnecting..."));
  }
  pendingRequests.clear();

  scheduleReconnect();
}

function handleNativeMessage(raw: unknown): void {
  const message = raw as NativeMessage;
  console.log("[KitsuneMCP] Received from native host:", message);

  if (message.requestId && pendingRequests.has(message.requestId)) {
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
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    const result = (await browser.tabs.sendMessage(
      tab.id,
      message,
    )) as Record<string, unknown>;
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function handleCommand(message: NativeMessage): Promise<CommandResult> {
  const { action, data } = message;
  let tabId = message.tabId;
  let result: CommandResult = { success: false };

  // Container scope check (Layer 0, design.md 7.1). The MCP Server attaches
  // `containerScope` to every command when container_scope.enabled is true.
  const containerScope = parseContainerScope(message.containerScope);
  let scope: ScopeFilter | null = null;
  if (containerScope) {
    const decision = await enforceContainerScope(action, tabId, containerScope);
    if (!decision.allowed) {
      result = outOfScope(decision.error);
      if (nativePort && message.requestId) {
        nativePort.postMessage({ requestId: message.requestId, ...result });
      }
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
        result = await createNewTab(data as { url?: string; active?: boolean }, scope);
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
        const connected = nativePort !== null;
        result = {
          success: true,
          connected,
          version: "0.1.0",
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
      case "waitForNetworkIdle":
      case "observeElement":
      case "stopObserving":
      case "scrollAndCapture":
      case "clickAndWait":
      case "pressKey":
      case "getText":
        result = await sendToContentScript(tabId, { action, ...data });
        break;
      // Console and network logging
      case "startLogging":
        result = await sendToContentScript(tabId, {
          action: "startLogging",
          ...data,
        });
        break;
      case "stopLogging":
        result = await sendToContentScript(tabId, { action: "stopLogging" });
        break;
      case "getConsoleLogs":
        result = await sendToContentScript(tabId, {
          action: "getConsoleLogs",
          ...data,
        });
        break;
      case "getNetworkLogs":
        result = await sendToContentScript(tabId, {
          action: "getNetworkLogs",
          ...data,
        });
        break;
      case "clearLogs":
        result = await sendToContentScript(tabId, {
          action: "clearLogs",
          ...data,
        });
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

  if (nativePort && message.requestId) {
    nativePort.postMessage({ requestId: message.requestId, ...result });
  }

  return result;
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
        const fullPageData = await browser.tabs.sendMessage(targetTab.id, {
          action: "captureFullPage",
          format: options.format || "png",
        });
        return { success: true, data: fullPageData, type: "fullPage" };
      }

      return {
        success: true,
        data: dataUrl,
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
          data: options.includeData ? dataUrl : undefined,
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
        title: "Claude requests approval",
        message: (
          (data.message as string) || "Claude wants to perform an action"
        ).slice(0, 200),
        iconUrl: browser.runtime.getURL("icons/icon-48.png"),
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
          title: "Captcha needs solving",
          message:
            "Claude paused on a captcha and needs you to solve it.",
          iconUrl: browser.runtime.getURL("icons/icon-48.png"),
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
    return { success: true, url: data.url };
  } catch (error) {
    return { success: false, error: (error as Error).message };
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
    const currentWindowOnly = options.current_window_only !== false;
    const includeFavicon = options.include_favicon === true;
    const urlPattern = options.url_pattern
      ? new RegExp(options.url_pattern)
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
    const msg = message as { target?: string; [key: string]: unknown };
    if (msg.target === "background") {
      handleCommand({
        ...msg,
        tabId: sender.tab?.id,
      } as NativeMessage).then(sendResponse);
      return true;
    }
  },
);

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
  title: "Take Screenshot for KitsuneMCP",
  contexts: ["page"],
});

browser.contextMenus.create({
  id: "kitsune-inspect",
  title: "Inspect Element for KitsuneMCP",
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
            data: result.data,
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

connectNativeHost();
console.log("[KitsuneMCP] Background script initialized");
