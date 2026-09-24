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
  const { action, tabId, data } = message;
  let result: CommandResult = { success: false };

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
        result = await getAllTabs(data as GetAllTabsOptions);
        break;
      case "createTab":
        result = await createNewTab(data as { url?: string; active?: boolean });
        break;
      case "closeTab":
        if (tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await closeTab(tabId);
        break;
      case "focusTab":
        if (tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await focusTab(tabId);
        break;
      case "getTabInfo":
        if (tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await getTabInfo(tabId);
        break;
      case "findTabs":
        result = await findTabs(data as FindTabsOptions);
        break;
      case "screenshotAllTabs":
        result = await screenshotAllTabs(data as ScreenshotOptions);
        break;
      case "refresh":
      case "reload":
        result = await refreshTab(tabId, data as RefreshOptions);
        break;
      case "hardRefresh":
        result = await hardRefreshTab(tabId);
        break;
      case "reloadAll":
        result = await reloadAllTabs(data as ReloadAllOptions);
        break;
      case "reloadByUrl":
        result = await reloadTabsByUrl(data as ReloadByUrlOptions);
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
): Promise<CommandResult> {
  try {
    const tabs = await browser.tabs.query({});
    const currentTab = (
      await browser.tabs.query({ active: true, currentWindow: true })
    )[0];

    let targetTabs = tabs.filter((t) => !shouldSkipTab(t.url));

    if (options.urlPattern) {
      targetTabs = targetTabs.filter((t) => matchesPattern(t.url, options.urlPattern!));
    }

    const results: Record<string, unknown>[] = [];

    for (const tab of targetTabs) {
      try {
        await browser.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 200));

        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
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
        results.push({
          success: false,
          tabId: tab.id,
          url: tab.url ?? "",
          error: (e as Error).message,
        });
      }
    }

    if (currentTab) {
      await browser.tabs.update(currentTab.id, { active: true });
    }

    return {
      success: true,
      screenshots: results,
      count: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
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
    let tabs = await browser.tabs.query(queryOpts);
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

async function findTabs(options: FindTabsOptions): Promise<CommandResult> {
  try {
    const tabs = await browser.tabs.query({});
    let filtered = tabs;

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

async function createNewTab(data: {
  url?: string;
  active?: boolean;
}): Promise<CommandResult> {
  try {
    const tab = await browser.tabs.create({
      url: data.url || "about:blank",
      active: data.active !== false,
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
): Promise<CommandResult> {
  try {
    const tabs = await browser.tabs.query({});
    const results: { id: number; url: string; reloaded: boolean }[] = [];

    for (const tab of tabs) {
      if (shouldSkipTab(tab.url)) continue;

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
): Promise<CommandResult> {
  try {
    if (!options.url && !options.urlPattern) {
      return { success: false, error: "Must provide url or urlPattern" };
    }

    const tabs = await browser.tabs.query({});
    const results: { id: number; url: string; reloaded: boolean }[] = [];

    for (const tab of tabs) {
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
