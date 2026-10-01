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
  /** false: capture nothing (the image would have nowhere to go). */
  saveToFile?: boolean;
  /** all_tabs: attach imageData per tab (the MCP Server always sets it). */
  includeData?: boolean;
  urlPattern?: string;
  /** all_tabs: time budget of the whole run (ms). */
  timeout?: number;
}

const NO_IMAGE_NOTE =
  "saveToFile is false: no image was captured. KitsuneMCP returns screenshots only " +
  "as saved files (resource_link), never inline.";

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
  /** fox_wait_for_navigation without a timeout argument. */
  NAVIGATION: 30_000,
  /**
   * Load wait of navigate / refresh / new tab. Shorter than the daemon's 30 s
   * default for these commands, so the Extension reports the timeout itself.
   */
  PAGE_LOAD: 25_000,
  /** No "loading" status this long after tabs.update / reload: nothing to load. */
  TAB_LOAD_SETTLE: 1_000,
  /** One tabs.captureTab call of screenshot all_tabs. */
  CAPTURE_TAB: 5_000,
  /** Whole screenshot all_tabs run without a timeout argument (< daemon 30 s). */
  ALL_TABS_BUDGET: 20_000,
  /** request_approval without a timeout argument (popup wait). */
  APPROVAL: 60_000,
} as const;

const EXCLUDED_URL_PREFIXES = ["about:", "moz-extension:"] as const;

function shouldSkipTab(url: string | undefined): boolean {
  if (!url) return true;
  return EXCLUDED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

type UrlPatternArg = { ok: true; pattern: RegExp | null } | { ok: false; result: CommandResult };

/**
 * Compile a `urlPattern` argument: a regex without flags (case-sensitive),
 * as on every urlPattern tool of both backends. null pattern when absent;
 * a failure result when it does not compile.
 */
function urlPatternArg(source: unknown): UrlPatternArg {
  if (typeof source !== "string" || source === "") return { ok: true, pattern: null };
  try {
    return { ok: true, pattern: new RegExp(source) };
  } catch (error) {
    return { ok: false, result: { success: false, error: `Invalid urlPattern: ${(error as Error).message}` } };
  }
}

function urlMatches(url: string | undefined, pattern: RegExp): boolean {
  return !!url && pattern.test(url);
}

type TabLoadOutcome = "complete" | "timeout" | "removed";

/** The part of browser.tabs that waitForTabLoad uses (a fake in tests). */
interface TabLoadApi {
  onUpdated: {
    addListener(fn: (tabId: number, changeInfo: browser.tabs.TabChangeInfo, tab: browser.tabs.Tab) => void): void;
    removeListener(fn: (tabId: number, changeInfo: browser.tabs.TabChangeInfo, tab: browser.tabs.Tab) => void): void;
  };
  onRemoved: {
    addListener(fn: (tabId: number) => void): void;
    removeListener(fn: (tabId: number) => void): void;
  };
  get(tabId: number): Promise<browser.tabs.Tab>;
}

/**
 * Run `trigger` (tabs.update / tabs.reload, or nothing for a tab that was
 * just created) and wait until the tab has loaded. The listeners go in
 * before the trigger, so a fast load is not missed.
 *
 *   requireLoading true   (navigate / reload) the tab must go through
 *                         "loading" after the trigger; a "complete" status
 *                         left over from the previous document does not
 *                         count. If no load starts within `settleMs` (same-
 *                         document navigation, nothing to load), the tab's
 *                         current state decides.
 *   requireLoading false  (new tab) the current state counts at once.
 *
 * Outcomes: "complete", "timeout" after `timeoutMs`, or "removed" when the
 * tab is closed meanwhile. A trigger that throws rejects (listeners removed).
 */
function waitForTabLoad(
  tabs: TabLoadApi,
  tabId: number,
  trigger: () => Promise<unknown>,
  isLoaded: (tab: browser.tabs.Tab) => boolean,
  options: { timeoutMs: number; settleMs: number; requireLoading: boolean },
): Promise<TabLoadOutcome> {
  return new Promise<TabLoadOutcome>((resolve, reject) => {
    let done = false;
    let sawLoading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      done = true;
      tabs.onUpdated.removeListener(onUpdated);
      tabs.onRemoved.removeListener(onRemoved);
      if (timer !== undefined) clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
    };
    const finish = (outcome: TabLoadOutcome): void => {
      if (done) return;
      cleanup();
      resolve(outcome);
    };
    const checkCurrent = (): void => {
      if (done) return;
      tabs.get(tabId).then(
        (tab) => { if (isLoaded(tab)) finish("complete"); },
        () => finish("removed"),
      );
    };
    const onUpdated = (
      updatedTabId: number,
      changeInfo: browser.tabs.TabChangeInfo,
      tab: browser.tabs.Tab,
    ): void => {
      if (updatedTabId !== tabId || done) return;
      if (changeInfo.status === "loading") sawLoading = true;
      if ((sawLoading || !options.requireLoading) && isLoaded(tab)) finish("complete");
    };
    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) finish("removed");
    };
    tabs.onUpdated.addListener(onUpdated);
    tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => finish("timeout"), options.timeoutMs);

    trigger().then(
      () => {
        if (done) return;
        if (!options.requireLoading) {
          checkCurrent();
          return;
        }
        settleTimer = setTimeout(() => {
          if (!sawLoading) checkCurrent();
        }, options.settleMs);
      },
      (error: unknown) => {
        if (done) return;
        cleanup();
        reject(error);
      },
    );
  });
}

/** Error text for a load wait that did not complete. */
function tabLoadError(outcome: TabLoadOutcome, timeoutMs: number, currentUrl: string | undefined): string {
  return outcome === "removed"
    ? "The tab was closed before the page finished loading"
    : `The page did not finish loading within ${timeoutMs}ms` +
        ` (current URL: ${currentUrl ?? "unknown"}). The navigation may still complete;` +
        " check with fox_get_tabs or fox_wait_for_url.";
}

/** A positive number from the command data, or the fallback. */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * fox_wait_for_navigation: wait for the tab's next top-level navigation to
 * finish ("load" = webNavigation.onCompleted, "domcontentloaded" =
 * onDOMContentLoaded). With urlPattern, navigations to other URLs are
 * skipped. As on the headless backend (Playwright waitForNavigation), a
 * navigation that finished before the command arrived does not count.
 */
async function waitForNavigation(
  tabId: number | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  const tab = await resolveTab(tabId);
  if (!tab?.id) return { success: false, error: "No target tab" };
  const targetId = tab.id;
  const timeoutMs = positiveOr(data.timeout, TIMEOUTS.NAVIGATION);
  const patternSrc = typeof data.urlPattern === "string" && data.urlPattern ? data.urlPattern : null;
  const patternArg = urlPatternArg(patternSrc);
  if (!patternArg.ok) return patternArg.result;
  const pattern = patternArg.pattern;
  const event =
    data.waitUntil === "domcontentloaded"
      ? browser.webNavigation.onDOMContentLoaded
      : browser.webNavigation.onCompleted;

  const url = await new Promise<string | null>((resolve) => {
    const listener = (details: browser.webNavigation.NavigationDetails): void => {
      if (details.tabId !== targetId || details.frameId !== 0) return;
      if (pattern && !pattern.test(details.url)) return;
      finish(details.url);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(value: string | null): void {
      clearTimeout(timer);
      event.removeListener(listener);
      resolve(value);
    }
    event.addListener(listener);
  });

  if (url === null) {
    return {
      success: false,
      error:
        `No navigation${patternSrc ? ` to a URL matching /${patternSrc}/` : ""} ` +
        `finished within ${timeoutMs}ms`,
    };
  }
  const now = await browser.tabs.get(targetId);
  return { success: true, url, title: now.title };
}

/**
 * fox_wait_for_url: wait until the tab's URL equals `url` (exact) or matches
 * `urlPattern` (regex) and the page has finished loading. Returns at once if
 * that is already the case. URL changes through the History API count too.
 */
async function waitForUrl(
  tabId: number | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  const exact = typeof data.url === "string" && data.url ? data.url : null;
  const patternSrc = typeof data.urlPattern === "string" && data.urlPattern ? data.urlPattern : null;
  if (!exact && !patternSrc) return { success: false, error: "Must provide url or urlPattern" };
  const patternArg = urlPatternArg(exact ? null : patternSrc);
  if (!patternArg.ok) return patternArg.result;
  const pattern = patternArg.pattern;
  const matches = (u: string | undefined): boolean =>
    !!u && (exact ? u === exact : pattern!.test(u));

  const tab = await resolveTab(tabId);
  if (!tab?.id) return { success: false, error: "No target tab" };
  const targetId = tab.id;
  const timeoutMs = positiveOr(data.timeout, 15_000);

  const reached = await new Promise<browser.tabs.Tab | null>((resolve) => {
    let done = false;
    const finish = (value: browser.tabs.Tab | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve(value);
    };
    const check = (t: browser.tabs.Tab): void => {
      if (matches(t.url) && t.status === "complete") finish(t);
    };
    const listener = (
      updatedTabId: number,
      _changeInfo: browser.tabs.TabChangeInfo,
      t: browser.tabs.Tab,
    ): void => {
      if (updatedTabId === targetId) check(t);
    };
    // Listener first, then the current state, so a change in between is not missed.
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(null), timeoutMs);
    browser.tabs.get(targetId).then(check, () => finish(null));
  });

  if (!reached) {
    const current = await browser.tabs.get(targetId).catch(() => undefined);
    return {
      success: false,
      error:
        `URL did not ${exact ? `become ${exact}` : `match /${patternSrc}/`} within ` +
        `${timeoutMs}ms (current: ${current?.url ?? "unknown"})`,
    };
  }
  return { success: true, url: reached.url };
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
// sent none, i.e. confirm_protected_actions is off). The records are kept
// per tab in logBuffers (see "Console / network log buffers"); this map
// tells the next document after a reload / navigation to resume recording
// (content script query + early injection, see "Event listeners") -- except
// while the tab is on a protected page, where recording is paused. Cleared
// by stop_logging or when the tab closes.
interface LoggingTabState {
  patterns: CompiledUrlRule[];
}
const loggingTabs = new Map<number, LoggingTabState>();
const TOP_FRAME_ID = 0;
/** Message type of the content script's "is logging on for my tab?" query. */
const LOGGING_STATE_QUERY = "kitsune:loggingState";

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

/**
 * Send a command to the tab's content script in one frame -- the top frame
 * (0) unless a caller names another. The content script runs in every frame
 * (all_frames), and tabs.sendMessage without a frameId goes to all of them
 * and takes the first answer, so any iframe (including a hostile one) could
 * answer or be the one that acts.
 */
async function sendToContentScript(
  tabId: number | undefined,
  message: Record<string, unknown>,
  frameId: number = TOP_FRAME_ID,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return { success: false, error: "No target tab" };
    const result = (await browser.tabs.sendMessage(tab.id, message, { frameId })) as Record<string, unknown>;
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
      case "find_text": {
        const findQuery = (data as { query: string }).query;
        const caseSensitive = (data as { caseSensitive?: boolean }).caseSensitive ?? false;
        const entireWord = (data as { entireWord?: boolean }).entireWord ?? false;
        const includeRectData = (data as { includeRectData?: boolean }).includeRectData ?? false;

        if (!target) {
          result = { success: false, error: "No target tab" };
          break;
        }
        const findResult = await browser.find.find(findQuery, {
          tabId: target.id,
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
 * Actions that apply `protectedUrlPatterns` in their own handler instead of
 * being refused up front: all_tabs, reload_all and reload_by_url skip
 * protected tabs, start_logging refuses on its own tab, get_*_logs report a
 * pause.
 */
const SELF_PROTECTED_ACTIONS: ReadonlySet<string> = new Set([
  "screenshotAllTabs",
  "reloadAll",
  "reloadByUrl",
  "startLogging",
  "getConsoleLogs",
  "getNetworkLogs",
]);

/**
 * Refuse a command when its target tab (resolved once in handleCommand, the
 * same tab the container scope check and the handler use) is on a
 * protected domain. Returns null when the command may proceed. Fails closed
 * if the tab could not be resolved.
 * `approvedHost`: the human approved this one call for that hostname (the
 * MCP Server consumed an approval token); a protected tab on exactly that
 * hostname is let through.
 */
function checkProtectedTarget(
  tab: browser.tabs.Tab | undefined,
  patterns: CompiledUrlRule[],
  approvedHost?: string,
): CommandResult | null {
  if (!tab) {
    return {
      success: false,
      error: "Could not resolve the target tab for the protected domain check",
    };
  }
  const tabUrl = tab.url;
  const matched = findProtectedMatch(tabUrl, patterns);
  if (tabUrl && matched && !isApprovedHost(tabUrl, approvedHost)) {
    // url / matchedPattern end up in the wire response's `data`, so the
    // server can name the page that was actually refused (its own
    // last-known URL may be stale).
    return {
      success: false,
      safetyDecision: "confirmation_required",
      error: "Protected domain: confirmation required",
      url: tabUrl,
      matchedPattern: matched.rule.source,
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
    if (!targetTab) return { success: false, error: "No target tab" };

    // saveToFile false: images reach the MCP client only as files the
    // Native Host saves (never as base64), so nothing is captured.
    if (options.saveToFile === false) {
      return {
        success: true,
        type: options.fullPage ? "fullPage" : "visible",
        imageSaved: false,
        note: NO_IMAGE_NOTE,
        tab: { id: targetTab.id, url: targetTab.url, title: targetTab.title },
      };
    }

    const needsFocus = tabId !== undefined && tabId !== currentTab?.id;
    let originalActiveTab: browser.tabs.Tab | null = null;

    if (needsFocus && options.allowFocus !== false) {
      originalActiveTab = currentTab;
      await browser.tabs.update(targetTab.id, { active: true });
      await new Promise((r) => setTimeout(r, TIMEOUTS.SCREENSHOT_DELAY));
    }

    try {
      // captureTab(tabId), not captureVisibleTab(windowId): the latter takes
      // whatever tab is visible in that window, which is another tab when
      // the target is in a different window or was not focused.
      const dataUrl = await browser.tabs.captureTab(targetTab.id, {
        format: options.format || "png",
        quality: options.quality || 90,
      });

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
    dimensions = (await browser.tabs.sendMessage(
      targetTab.id,
      { action: "captureFullPage", format: options.format || "png" },
      { frameId: TOP_FRAME_ID },
    )) as Record<string, unknown>;
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
  protectedRules: CompiledUrlRule[] = [],
  lists: UrlLists = NO_URL_LISTS,
): Promise<CommandResult> {
  try {
    const patternArg = urlPatternArg(options.urlPattern);
    if (!patternArg.ok) return patternArg.result;
    const urlPattern = patternArg.pattern;
    const tabs = await browser.tabs.query({});

    let targetTabs = tabs.filter((t) => !shouldSkipTab(t.url) && isTabInScope(t, scope));

    if (urlPattern) {
      targetTabs = targetTabs.filter((t) => urlMatches(t.url, urlPattern));
    }

    // Tabs on blocked / not allowlisted sites, then protected domains
    // (banking, payments, ...) are excluded. Only the counts are reported --
    // never the URL or title of excluded tabs.
    const beforeLists = targetTabs.length;
    targetTabs = targetTabs.filter((t) => violatesUrlLists(t.url, lists) === null);
    const excludedBlocked = beforeLists - targetTabs.length;
    const beforeProtected = targetTabs.length;
    if (protectedRules.length > 0) {
      targetTabs = targetTabs.filter((t) => findUrlRule(t.url, protectedRules) === undefined);
    }
    const excludedProtected = beforeProtected - targetTabs.length;
    const excluded = {
      ...(excludedBlocked > 0
        ? {
          excludedBlocked,
          excludedBlockedReason:
            "Tabs on sites refused by blocked_url_patterns / allowed_url_patterns in safety.json were not captured.",
        }
        : {}),
      ...(excludedProtected > 0
        ? {
          excludedReason:
            "Tabs matching protected_url_patterns in safety.json were not captured " +
            "(set confirm_protected_actions to false to include them).",
        }
        : {}),
    };

    if (options.saveToFile === false) {
      return {
        success: true,
        screenshots: targetTabs.map((t) => ({
          tabId: t.id, url: t.url ?? "", title: t.title ?? "", imageSaved: false,
        })),
        count: 0,
        failed: 0,
        note: NO_IMAGE_NOTE,
        excludedProtected,
        ...excluded,
      };
    }

    const budgetMs = positiveOr(options.timeout, TIMEOUTS.ALL_TABS_BUDGET);
    const results = await captureTabsWithin(
      targetTabs,
      (tab) => browser.tabs.captureTab(tab.id, {
        format: options.format || "png",
        quality: options.quality || 90,
      }),
      { perTabMs: TIMEOUTS.CAPTURE_TAB, budgetMs, keepData: options.includeData === true },
    );
    const count = results.filter((r) => r.success).length;
    const failed = results.length - count;

    return {
      // Nothing captured although there were tabs to capture: a failure.
      success: results.length === 0 || count > 0,
      ...(results.length > 0 && count === 0
        ? { error: `No tab could be captured (${failed} failed; see screenshots[].error)` }
        : {}),
      screenshots: results,
      count,
      failed,
      excludedProtected,
      ...excluded,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Capture `tabs` one after another within `budgetMs` overall, giving each
 * capture at most `perTabMs` (or what is left of the budget). Tabs reached
 * after the budget is used up are reported as skipped, not captured. Each
 * entry has success / tabId / url, plus imageData (keepData) or error.
 */
async function captureTabsWithin(
  tabs: browser.tabs.Tab[],
  capture: (tab: browser.tabs.Tab) => Promise<string>,
  options: { perTabMs: number; budgetMs: number; keepData: boolean },
): Promise<Record<string, unknown>[]> {
  const started = Date.now();
  const results: Record<string, unknown>[] = [];
  for (const tab of tabs) {
    const base = { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
    const left = options.budgetMs - (Date.now() - started);
    if (left <= 0) {
      results.push({
        ...base,
        success: false,
        skipped: true,
        error: `Skipped: the ${options.budgetMs}ms budget of this capture was used up`,
      });
      continue;
    }
    const limit = Math.min(options.perTabMs, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const dataUrl = await Promise.race([
        capture(tab),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`captureTab timed out after ${limit}ms`)), limit);
        }),
      ]);
      results.push({
        ...base,
        success: true,
        ...(options.keepData ? { imageData: dataUrl } : {}),
        timestamp: Date.now(),
      });
    } catch (e) {
      results.push({ ...base, success: false, error: (e as Error).message });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return results;
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
// Navigation
// ---------------------------------------------------------------------------

const TAB_LOAD_OPTIONS = {
  timeoutMs: TIMEOUTS.PAGE_LOAD,
  settleMs: TIMEOUTS.TAB_LOAD_SETTLE,
} as const;

async function navigateTo(
  tabId: number | undefined,
  data: { url: string; waitForLoad?: boolean },
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return { success: false, error: "No target tab" };
    const navigate = (): Promise<unknown> => browser.tabs.update(tab.id, { url: data.url });
    if (data.waitForLoad === false) {
      await navigate();
      return { success: true, url: data.url, waited: false };
    }
    const outcome = await waitForTabLoad(
      browser.tabs, tab.id, navigate, (t) => t.status === "complete",
      { ...TAB_LOAD_OPTIONS, requireLoading: true },
    );
    // Report the URL actually loaded (after redirects), so the server's guard
    // tracks the real page; fall back to the requested URL.
    const updated = await browser.tabs.get(tab.id).catch(() => undefined);
    if (outcome !== "complete") {
      return { success: false, error: tabLoadError(outcome, TAB_LOAD_OPTIONS.timeoutMs, updated?.url) };
    }
    return { success: true, url: updated?.url || data.url };
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
      const outcome = await waitForTabLoad(
        browser.tabs,
        tabId,
        () => Promise.resolve(),
        (tab) => tab.status === "complete" && (wantsBlank || tab.url !== "about:blank"),
        { ...TAB_LOAD_OPTIONS, requireLoading: false },
      );
      if (outcome !== "complete") {
        const now = await browser.tabs.get(tabId).catch(() => undefined);
        return { success: false, error: tabLoadError(outcome, TAB_LOAD_OPTIONS.timeoutMs, now?.url), tabId };
      }
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
    const result = (await browser.tabs.sendMessage(
      tab.id,
      { action: "getPageInfo" },
      { frameId: TOP_FRAME_ID },
    )) as Record<string, unknown>;
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
    const patternArg = urlPatternArg(options.urlPattern);
    if (!patternArg.ok) return patternArg.result;
    const urlPattern = patternArg.pattern;
    const limit = Number.isInteger(options.limit)
      ? (options.limit as number)
      : 50;

    const queryOpts: browser.tabs.QueryInfo = currentWindowOnly
      ? { currentWindow: true }
      : {};
    let tabs = (await browser.tabs.query(queryOpts)).filter((t) => isTabInScope(t, scope));
    const windows = await browser.windows.getAll();
    const windowMap = new Map(windows.map((w) => [w.id, w]));
    // Under container scope, count only windows holding an in-scope tab, so
    // the result says nothing about windows outside the scope.
    const windowCount = scope
      ? new Set(
          (await browser.tabs.query({}))
            .filter((t) => isTabInScope(t, scope))
            .map((t) => t.windowId),
        ).size
      : windows.length;

    if (urlPattern) {
      tabs = tabs.filter((t) => urlMatches(t.url, urlPattern));
    }
    const totalMatched = tabs.length;

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
      windowCount,
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
      pageInfo = await browser.tabs.sendMessage(
        tabId,
        { action: "getPageInfo" },
        { frameId: TOP_FRAME_ID },
      );
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
    const patternArg = urlPatternArg(options.urlPattern);
    if (!patternArg.ok) return patternArg.result;
    const urlPattern = patternArg.pattern;
    if (urlPattern) {
      filtered = filtered.filter((t) => urlMatches(t.url, urlPattern));
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
    // `closed`: the MCP Server's guard forgets this tab's last URL.
    return { success: true, closed: tabId };
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
    if (!tab) return { success: false, error: "No target tab" };
    const bypassCache = options.bypassCache || false;
    const reload = (): Promise<unknown> => browser.tabs.reload(tab.id, { bypassCache });

    if (options.waitForLoad === false) {
      await reload();
      return { success: true, refreshed: true, tab: { id: tab.id, url: tab.url ?? "" }, bypassCache };
    }

    const outcome = await waitForTabLoad(
      browser.tabs, tab.id, reload, (t) => t.status === "complete",
      { ...TAB_LOAD_OPTIONS, requireLoading: true },
    );
    const updated = await browser.tabs.get(tab.id).catch(() => undefined);
    if (outcome !== "complete") {
      return { success: false, error: tabLoadError(outcome, TAB_LOAD_OPTIONS.timeoutMs, updated?.url) };
    }
    return {
      success: true,
      refreshed: true,
      tab: { id: tab.id, url: updated?.url ?? tab.url ?? "", title: updated?.title ?? tab.title ?? "" },
      bypassCache,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Reload every tab `selects`, except tabs outside the container scope, tabs
 * on a blocked / not allowlisted site and tabs on a protected domain (only
 * their counts are reported, as for screenshot all_tabs).
 */
async function reloadMatchingTabs(
  selects: (tab: browser.tabs.Tab) => boolean,
  bypassCache: boolean,
  scope: ScopeFilter | null,
  protectedRules: CompiledUrlRule[],
  lists: UrlLists,
): Promise<CommandResult> {
  const tabs = await browser.tabs.query({});
  const results: { id: number; url: string; reloaded: boolean }[] = [];
  let excludedProtected = 0;
  let excludedBlocked = 0;

  for (const tab of tabs) {
    if (!isTabInScope(tab, scope) || !selects(tab)) continue;
    if (violatesUrlLists(tab.url, lists) !== null) {
      excludedBlocked++;
      continue;
    }
    if (findUrlRule(tab.url, protectedRules) !== undefined) {
      excludedProtected++;
      continue;
    }
    await browser.tabs.reload(tab.id, { bypassCache });
    results.push({ id: tab.id, url: tab.url ?? "", reloaded: true });
  }

  return {
    success: true,
    reloadedCount: results.length,
    tabs: results,
    bypassCache,
    excludedProtected,
    ...(excludedBlocked > 0 ? { excludedBlocked } : {}),
    ...(excludedProtected > 0
      ? {
        excludedReason:
          "Tabs matching protected_url_patterns in safety.json were not reloaded " +
          "(set confirm_protected_actions to false to include them).",
      }
      : {}),
  };
}

async function reloadAllTabs(
  options: ReloadAllOptions = {},
  scope: ScopeFilter | null = null,
  protectedRules: CompiledUrlRule[] = [],
  lists: UrlLists = NO_URL_LISTS,
): Promise<CommandResult> {
  try {
    const patternArg = urlPatternArg(options.urlPattern);
    if (!patternArg.ok) return patternArg.result;
    const urlPattern = patternArg.pattern;
    return await reloadMatchingTabs(
      (tab) => !shouldSkipTab(tab.url) && (!urlPattern || urlMatches(tab.url, urlPattern)),
      options.bypassCache || false,
      scope,
      protectedRules,
      lists,
    );
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function reloadTabsByUrl(
  options: ReloadByUrlOptions,
  scope: ScopeFilter | null = null,
  protectedRules: CompiledUrlRule[] = [],
  lists: UrlLists = NO_URL_LISTS,
): Promise<CommandResult> {
  try {
    if (!options.url && !options.urlPattern) {
      return { success: false, error: "Must provide url or urlPattern" };
    }
    const patternArg = urlPatternArg(options.url ? null : options.urlPattern);
    if (!patternArg.ok) return patternArg.result;
    const urlPattern = patternArg.pattern;
    const prefix = options.url;
    return await reloadMatchingTabs(
      (tab) =>
        prefix
          ? !!tab.url && tab.url.startsWith(prefix)
          : !!urlPattern && urlMatches(tab.url, urlPattern),
      options.bypassCache !== false,
      scope,
      protectedRules,
      lists,
    );
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Console / network log buffers (per tab, kept across navigations)
// ---------------------------------------------------------------------------
//
// The top frame's content script records entries while logging is on and
// forwards them here in small batches (LOG_RECORD_MESSAGE), plus whatever it
// still holds when asked (flushLogs / stopLogging). The buffers live in the
// background, so a reload or navigation -- which replaces the content script
// -- does not lose them. Each tab keeps at most LOG_BUFFER_LIMIT console and
// LOG_BUFFER_LIMIT network entries (oldest dropped). A buffer exists from
// start_logging until the tab closes; stop_logging keeps it (the logs stay
// readable), clear_logs empties it. Entries recorded in the last moment
// before a navigation can be lost (the batch in flight when the old page
// unloads).

interface LogBuffer {
  console: Record<string, unknown>[];
  network: Record<string, unknown>[];
}
const logBuffers = new Map<number, LogBuffer>();
const LOG_BUFFER_LIMIT = 500;
/** content → background: `{ type, console?: entry[], network?: entry[] }`. */
const LOG_RECORD_MESSAGE = "kitsune:logRecords";

/**
 * Copy one log entry from a content script into plain data: strings (cut
 * at 5000 characters), finite numbers, booleans, null, and one level of
 * string records (headers). Anything else is dropped; null if not an object.
 */
function sanitizeLogRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 20)) {
    if (typeof value === "string") {
      out[key] = value.length > 5000 ? value.slice(0, 5000) : value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const record: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
        if (typeof v === "string") record[k.slice(0, 200)] = v.slice(0, 1000);
      }
      out[key] = record;
    }
  }
  return out;
}

/**
 * Append the valid entries of `incoming` (an array, else nothing) to
 * `target`, keeping only the newest `limit`. Returns how many were added.
 */
function appendLogRecords(target: Record<string, unknown>[], incoming: unknown, limit: number): number {
  if (!Array.isArray(incoming)) return 0;
  let added = 0;
  for (const raw of incoming) {
    const entry = sanitizeLogRecord(raw);
    if (entry === null) continue;
    target.push(entry);
    added++;
  }
  if (target.length > limit) target.splice(0, target.length - limit);
  return added;
}

/** Positive integer `limit`, else 100 (the tool default). */
function logLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 100;
}

/** fox_get_console_logs filters over a buffer (newest `limit` entries). */
function queryConsoleLogs(
  entries: Record<string, unknown>[],
  options: Record<string, unknown> = {},
): CommandResult {
  let logs = entries;
  if (typeof options.level === "string" && options.level !== "") {
    logs = logs.filter((l) => l.level === options.level);
  }
  if (typeof options.search === "string" && options.search !== "") {
    const needle = options.search.toLowerCase();
    logs = logs.filter((l) => typeof l.message === "string" && l.message.toLowerCase().includes(needle));
  }
  const limit = logLimit(options.limit);
  if (logs.length > limit) logs = logs.slice(-limit);
  return { success: true, logs, totalCount: entries.length, returnedCount: logs.length };
}

/** fox_get_network_logs filters over a buffer (urlPattern: case-sensitive regex, as every urlPattern). */
function queryNetworkLogs(
  entries: Record<string, unknown>[],
  options: Record<string, unknown> = {},
): CommandResult {
  let logs = entries;
  if (typeof options.urlPattern === "string" && options.urlPattern !== "") {
    let pattern: RegExp;
    try {
      pattern = new RegExp(options.urlPattern);
    } catch (error) {
      return { success: false, error: `Invalid urlPattern: ${(error as Error).message}` };
    }
    logs = logs.filter((l) => typeof l.url === "string" && pattern.test(l.url));
  }
  if (typeof options.method === "string" && options.method !== "") {
    const method = options.method.toUpperCase();
    logs = logs.filter((l) => typeof l.method === "string" && l.method.toUpperCase() === method);
  }
  if (typeof options.status === "number") {
    logs = logs.filter((l) => l.status === options.status);
  }
  if (options.errorsOnly === true) {
    logs = logs.filter((l) => !!l.error || (typeof l.status === "number" && l.status >= 400));
  }
  const limit = logLimit(options.limit);
  if (logs.length > limit) logs = logs.slice(-limit);
  return { success: true, logs, totalCount: entries.length, returnedCount: logs.length };
}

/**
 * Store entries a tab's top-frame content script sent (batch, flush or stop
 * reply). Dropped when the tab has no buffer (logging never started, or the
 * buffer was released) or the page they came from is protected.
 */
function acceptLogRecords(
  tabId: number,
  pageUrls: (string | undefined)[],
  payload: { console?: unknown; network?: unknown },
): void {
  const buffer = logBuffers.get(tabId);
  if (!buffer) return;
  const patterns = loggingTabs.get(tabId)?.patterns ?? [];
  if (pageUrls.some((u) => findProtectedMatch(u, patterns) !== undefined)) return;
  appendLogRecords(buffer.console, payload.console, LOG_BUFFER_LIMIT);
  appendLogRecords(buffer.network, payload.network, LOG_BUFFER_LIMIT);
}

function logCounts(tabId: number): { consoleLogsCount: number; networkLogsCount: number } {
  const buffer = logBuffers.get(tabId);
  return {
    consoleLogsCount: buffer?.console.length ?? 0,
    networkLogsCount: buffer?.network.length ?? 0,
  };
}

async function startLoggingOnTab(
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> = {},
  protectedPatterns: CompiledUrlRule[],
  approvedHost: string | undefined,
): Promise<CommandResult> {
  // Same rule as a single-tab screenshot: refuse on a protected page, judged
  // by the tab's real URL (fails closed without a tab).
  if (!target) return { success: false, error: "No target tab" };
  const refusal = checkProtectedTarget(target, protectedPatterns, approvedHost);
  if (refusal) return refusal;
  const tab = target;
  const result = await sendToContentScript(tab.id, {
    action: "startLogging",
    ...data,
    protectedPatterns: protectedPatterns.map((p) => p.rule),
  });
  if (!result.success) return result;
  loggingTabs.set(tab.id, { patterns: protectedPatterns });
  let buffer = logBuffers.get(tab.id);
  if (!buffer) {
    buffer = { console: [], network: [] };
    logBuffers.set(tab.id, buffer);
  }
  if (data.clearExisting === true) {
    buffer.console.length = 0;
    buffer.network.length = 0;
  }
  return { ...result, ...logCounts(tab.id), bufferLimit: LOG_BUFFER_LIMIT };
}

async function stopLoggingOnTab(target: browser.tabs.Tab | undefined): Promise<CommandResult> {
  if (!target) return { success: false, error: "No target tab" };
  // Ask the page first, so the entries it has not sent yet are kept.
  const reply = await sendToContentScript(target.id, { action: "stopLogging" });
  if (reply.success) acceptLogRecords(target.id, [target.url], reply as { console?: unknown; network?: unknown });
  loggingTabs.delete(target.id);
  return {
    success: true,
    message: "Logging stopped",
    ...logCounts(target.id),
    ...(reply.success
      ? {}
      : { note: `The page did not answer (${reply.error ?? "unknown error"}); logging is off for this tab anyway.` }),
  };
}

async function getLogsOfTab(
  action: "getConsoleLogs" | "getNetworkLogs",
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> = {},
  protectedPatterns: CompiledUrlRule[],
): Promise<CommandResult> {
  if (!target) return { success: false, error: "No target tab" };
  // Collect what the current page recorded but has not sent yet. The logs
  // themselves come from the background buffer, so they are there even
  // when the current page has no content script.
  const flush = await sendToContentScript(target.id, { action: "flushLogs" });
  if (flush.success) acceptLogRecords(target.id, [target.url], flush as { console?: unknown; network?: unknown });
  const buffer = logBuffers.get(target.id) ?? { console: [], network: [] };
  const result = action === "getConsoleLogs"
    ? queryConsoleLogs(buffer.console, data)
    : queryNetworkLogs(buffer.network, data);
  if (!result.success) return result;

  const interception = (flush.success ? flush.interception : undefined) as
    { console?: boolean; fetch?: boolean; xhr?: boolean } | undefined;
  const diagnostics: Record<string, unknown> = !interception
    ? { currentPageReached: false }
    : action === "getConsoleLogs"
      ? { interceptionAvailable: interception.console === true, injection: flush.injection }
      : {
        interceptionAvailable: interception.fetch === true || interception.xhr === true,
        interception: { fetch: interception.fetch === true, xhr: interception.xhr === true },
      };
  return {
    ...result,
    loggingEnabled: loggingTabs.has(target.id),
    pausedForProtectedDomain: isLoggingPausedForTab(target, protectedPatterns),
    ...diagnostics,
  };
}

async function clearLogsOfTab(
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  if (!target) return { success: false, error: "No target tab" };
  const clearConsole = data.console !== false;
  const clearNetwork = data.network !== false;
  const buffer = logBuffers.get(target.id);
  if (buffer) {
    if (clearConsole) buffer.console.length = 0;
    if (clearNetwork) buffer.network.length = 0;
  }
  // Drop what the page holds but has not sent yet (best effort).
  await sendToContentScript(target.id, { action: "clearLogs", console: clearConsole, network: clearNetwork });
  return { success: true, message: "Logs cleared", ...logCounts(target.id) };
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

/** blocked / allowed rules of one command (url-rule.ts). */
interface UrlLists {
  blocked: CompiledUrlRule[];
  allowed: CompiledUrlRule[];
  /** The server sent an allowed list: URLs outside it are refused. */
  allowlistActive: boolean;
}

const NO_URL_LISTS: UrlLists = { blocked: [], allowed: [], allowlistActive: false };

/** parseUrlPolicy. */
interface UrlPolicy {
  protectedRules: CompiledUrlRule[];
  lists: UrlLists;
  invalid: number;
}

/**
 * The URL policy attached to a command: `protectedUrlRules` (else the
 * legacy regex strings of `protectedUrlPatterns`, older MCP Servers),
 * `blockedUrlRules`, `allowedUrlRules`. `invalid` counts entries that could
 * not be used: the command is then refused (an unusable entry must not
 * narrow the policy; the server validates them, so this means a mismatch).
 */
function parseUrlPolicy(message: NativeMessage): UrlPolicy {
  const protectedSource = Array.isArray(message.protectedUrlRules)
    ? message.protectedUrlRules
    : message.protectedUrlPatterns;
  const prot = compileUrlRules(protectedSource);
  const blocked = compileUrlRules(message.blockedUrlRules);
  const allowed = compileUrlRules(message.allowedUrlRules);
  return {
    protectedRules: prot.rules,
    lists: {
      blocked: blocked.rules,
      allowed: allowed.rules,
      allowlistActive: Array.isArray(message.allowedUrlRules) && message.allowedUrlRules.length > 0,
    },
    invalid: prot.invalid + blocked.invalid + allowed.invalid,
  };
}

/** Whether the lists apply at all (nothing to check otherwise). */
function hasUrlLists(lists: UrlLists): boolean {
  return lists.blocked.length > 0 || lists.allowlistActive;
}

/** urlListViolation (url-rule.ts) over a command's lists. */
function violatesUrlLists(
  url: string | undefined,
  lists: UrlLists,
): UrlListViolation | null {
  return urlListViolation(url, lists.blocked, lists.allowed, lists.allowlistActive);
}

/**
 * Refuse a command whose target tab (resolved once in handleCommand) is on
 * a URL the blocked / allowed lists refuse -- the guard's Layer 3 check on
 * the tab's real URL, which the server may not know. Fails closed if the
 * tab could not be resolved.
 */
function checkListedTarget(tab: browser.tabs.Tab | undefined, lists: UrlLists): CommandResult | null {
  if (!tab) {
    return {
      success: false,
      error: "Could not resolve the target tab for the blocked / allowed URL check",
    };
  }
  const violation = violatesUrlLists(tab.url, lists);
  if (violation === null) return null;
  return {
    success: false,
    safetyDecision: violation.decision,
    error:
      `Refused: the target tab is on '${tab.url}', which ${violation.reason}. ` +
      "Navigate it elsewhere (fox_navigate with a url) or close it.",
    url: tab.url,
  };
}

/** The first protected rule that matches the URL, if any. */
function findProtectedMatch(url: string | undefined, patterns: CompiledUrlRule[]): CompiledUrlRule | undefined {
  return findUrlRule(url, patterns);
}

/**
 * Whether logging on this tab is paused because the tab is on a protected
 * page: the tab's real URL against the patterns kept at start_logging and
 * those attached to the current command (either set matching pauses).
 */
function isLoggingPausedForTab(tab: browser.tabs.Tab, commandPatterns: CompiledUrlRule[]): boolean {
  const state = loggingTabs.get(tab.id);
  if (!state) return false;
  return (
    findProtectedMatch(tab.url, state.patterns) !== undefined ||
    findProtectedMatch(tab.url, commandPatterns) !== undefined
  );
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

/**
 * Actions that touch no tab and no container at all. Approval requests are
 * shown in the toolbar popup, and cancel_human_wait only withdraws a wait
 * the command it cancels already passed the scope check for.
 */
const SCOPE_NO_TAB_ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "requestApproval",
  "cancelHumanWait",
]);

/** Internal action that targets one tab (the strict branch of the scope check). */
function isSingleTabAction(action: string): boolean {
  return !SCOPE_SELF_ENFORCED_ACTIONS.has(action) && !SCOPE_NO_TAB_ACTIONS.has(action);
}

/**
 * Layer 0 enforcement. For single-tab actions, requires the target tab
 * (resolved once by handleCommand: explicit tabId, else the active tab) to
 * be in the agent container. A tab that could not be resolved is refused.
 */
async function enforceContainerScope(
  action: string | undefined,
  tab: browser.tabs.Tab | undefined,
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
        loggingTabs.has(senderTabId);
      if (accepted) acceptLogRecords(senderTabId, [sender.tab?.url, sender.url], msg as { console?: unknown; network?: unknown });
      sendResponse({ accepted });
      return;
    }
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
        protectedPatterns: state.patterns.map((p) => p.rule),
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
  // content.js uses url-rule.js (as in manifest.json), so that goes first.
  const inject = (file: string): Promise<unknown> =>
    browser.tabs.executeScript(details.tabId, { file, runAt: "document_start", frameId: TOP_FRAME_ID });
  inject("/dist/url-rule.js")
    .then(() => inject("/dist/content.js"))
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
  logBuffers.delete(tabId);
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
