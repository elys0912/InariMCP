// KitsuneMCP Content Script
// Runs in web pages to handle DOM interactions, clicks, typing, and element inspection
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025

(function () {
  "use strict";

  // Prevent multiple injections
  if ((window as unknown as Record<string, unknown>).__fox_injected) return;
  (window as unknown as Record<string, unknown>).__fox_injected = true;

  /**
   * Localized banner text (same as t() in i18n.ts, which is not loaded when
   * this script is injected on its own).
   */
  function msg(key: string, substitutions?: string | string[]): string {
    return browser.i18n.getMessage(key, substitutions) || key;
  }

  // ---------------------------------------------------------------------------
  // Types (self-contained — no imports allowed in extension content scripts)
  // ---------------------------------------------------------------------------

  interface FindElementOptions {
    selector?: string;
    xpath?: string;
    text?: string;
    x?: number;
    y?: number;
    id?: string;
    name?: string;
    ariaLabel?: string;
    placeholder?: string;
    role?: string;
  }

  interface ElementInfo {
    tag: string;
    id: string | null;
    classes: string[];
    name: string | null;
    type: string | null;
    text: string | null;
    value: string | null;
    href: string | null;
    src: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    role: string | null;
    disabled: boolean;
    checked: boolean;
    visible: boolean;
    position: {
      x: number;
      y: number;
      width: number;
      height: number;
      centerX: number;
      centerY: number;
    };
    selector: string;
  }

  interface ClickOptions extends FindElementOptions {
    rightClick?: boolean;
    doubleClick?: boolean;
  }

  interface TypeOptions extends FindElementOptions {
    text?: string;
    clear?: boolean;
    instant?: boolean;
    delay?: number;
    pressEnter?: boolean;
    submitForm?: boolean;
    focusFirst?: boolean;
    allowPassword?: boolean;
  }

  interface ScrollOptions extends FindElementOptions {
    toElement?: string;
    direction?: string;
    amount?: number;
    smooth?: boolean;
    block?: ScrollLogicalPosition;
  }

  interface HighlightOptions extends FindElementOptions {
    label?: string;
    duration?: number;
  }

  interface WaitOptions extends FindElementOptions {
    timeout?: number;
    interval?: number;
    visible?: boolean;
  }

  interface WaitForChangeOptions {
    selector?: string;
    timeout?: number;
    changeType?: string;
    waitForAll?: boolean;
    subtree?: boolean;
    attributes?: boolean;
    characterData?: boolean;
    attributeOldValue?: boolean;
  }

  interface NetworkIdleOptions {
    timeout?: number;
    idleTime?: number;
  }

  interface ObserveOptions {
    selector: string;
    observerId?: string;
  }

  interface ScrollCaptureOptions {
    scrollStep?: number;
    delay?: number;
    maxScrolls?: number;
    restore?: boolean;
  }

  interface ClickAndWaitOptions extends ClickOptions {
    waitTimeout?: number;
    waitForSelector?: string;
    waitForChange?: boolean;
  }

  interface SetValueOptions extends FindElementOptions {
    value: string;
    allowPassword?: boolean;
  }

  interface SelectOptionOptions extends FindElementOptions {
    value?: string;
    index?: number;
    text?: string;
  }

  interface ComputedStylesOptions extends FindElementOptions {
    properties?: string[];
  }

  interface PressKeyOptions extends FindElementOptions {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
  }

  interface TextOptions extends FindElementOptions {
    maxLength?: number;
  }

  interface ApprovalOptions {
    message?: string;
    detail?: string;
    timeout?: number;
  }

  interface CaptchaOptions {
    detectOnly?: boolean;
    timeout?: number;
  }

  interface LoggingOptions {
    clearExisting?: boolean;
    protectedPatterns?: unknown;
  }

  interface ConsoleLogOptions {
    level?: string;
    search?: string;
    limit?: number;
  }

  interface NetworkLogOptions {
    urlPattern?: string;
    method?: string;
    status?: number;
    errorsOnly?: boolean;
    limit?: number;
  }

  interface ClearLogsOptions {
    console?: boolean;
    network?: boolean;
  }

  interface ContentMessage {
    action: string;
    [key: string]: unknown;
  }

  interface ConsoleLogEntry {
    level: string;
    timestamp: string;
    message: string;
    url: string;
  }

  interface NetworkLogEntry {
    type: string;
    method: string;
    url: string;
    requestHeaders?: Record<string, string>;
    requestBody?: string | null;
    startTime: string;
    pageUrl: string;
    status?: number;
    statusText?: string;
    duration?: number;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    error?: string;
  }

  interface CaptchaWidget {
    type: string;
    solved: boolean | null;
  }

  interface ObserverRecord {
    observer: MutationObserver;
    changes: MutationChange[];
    target: string;
  }

  interface MutationChange {
    type: string;
    timestamp: number;
    target: string;
    addedNodes: string[];
    removedNodes: string[];
    attributeName: string | null;
    oldValue: string | null;
  }

  // Headers that must never appear in logged network traffic
  const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
  ]);

  function maskHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      safe[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
        ? "[MASKED]"
        : value;
    }
    return safe;
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const TIMEOUTS = {
    DEFAULT: 10_000,
    WAIT_ELEMENT: 10_000,
    NETWORK_IDLE: 10_000,
    APPROVAL: 60_000,
    CAPTCHA: 180_000,
    SCROLL_STEP: 500,
  } as const;

  const DEFAULTS = {
    SCREENSHOT_FORMAT: "png" as const,
    SCREENSHOT_QUALITY: 90,
  } as const;

  const INTERACTIVE_SELECTORS = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[onclick]",
    '[role="button"]',
    '[role="link"]',
    '[tabindex]:not([tabindex="-1"])',
  ] as const;

  function isTextInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let highlightOverlay: HTMLDivElement | null = null;

  // Recording happens only while `loggingEnabled` is true. The on/off switch
  // itself is kept per tab by the background script, so the next document
  // after a reload / navigation resumes it (resumeLoggingFromBackground).
  let loggingEnabled = false;

  // Protected URL patterns of this tab's logging session (sent by the
  // background script; empty when confirm_protected_actions is off). Checked
  // against the current URL on every record, so a same-document move onto a
  // protected URL (history.pushState) pauses recording too. Full navigations
  // onto protected pages are handled by the background (no resume there).
  let protectedPatterns: RegExp[] = [];

  function compilePatterns(raw: unknown): RegExp[] {
    if (!Array.isArray(raw)) return [];
    const compiled: RegExp[] = [];
    for (const pattern of raw) {
      if (typeof pattern !== "string") continue;
      try {
        compiled.push(new RegExp(pattern, "i"));
      } catch {
        // invalid pattern -- the background script ignores it as well
      }
    }
    return compiled;
  }

  function onProtectedPage(): boolean {
    const url = window.location.href;
    return protectedPatterns.some((p) => p.test(url));
  }

  /** Record now? Logging on, and the page is not a protected one. */
  function shouldRecord(): boolean {
    return loggingEnabled && !onProtectedPage();
  }
  let consoleLogs: ConsoleLogEntry[] = [];
  let networkLogs: NetworkLogEntry[] = [];
  const MAX_LOG_ENTRIES = 500;

  // Bumped by every startLogging / stopLogging, so a late reply to the
  // resume query cannot override a newer explicit command.
  let loggingControlVersion = 0;

  // Message type used to ask the background script whether logging is on
  // for this tab (same string as LOGGING_STATE_QUERY in background.ts).
  const LOGGING_STATE_QUERY = "kitsune:loggingState";

  // In-flight page requests (fetch + XHR) seen by the page hooks; used by
  // waitForNetworkIdle. A count only -- no request content.
  let __fox_activeRequests = 0;

  // ---------------------------------------------------------------------------
  // Console & Network Logging -- hooks in the page's own JS world
  // ---------------------------------------------------------------------------
  //
  // Firefox runs content scripts in a sandbox that sees the page through Xray
  // wrappers: `console`, `XMLHttpRequest` and `fetch` in this script are the
  // sandbox's own, and replacing them never affects the page's scripts. The
  // hooks are therefore defined on the page's objects (window.wrappedJSObject)
  // with exportFunction(). No <script> element is inserted, so the page's CSP
  // does not apply and no code string is ever evaluated in the page.
  //
  // Everything exported here can be called by the page directly, with any
  // arguments. Rules for those functions:
  //   - they only record strings into this script's buffers and forward the
  //     call to the page's ORIGINAL function (never this sandbox's fetch /
  //     XHR, which carry extension privileges);
  //   - they never touch browser.* APIs and never hand sandbox objects to
  //     the page (return values are the page's own objects or undefined);
  //   - page values are read through Xrays (page getters / toJSON do not
  //     run), inside try/catch, and stored only as strings / numbers.
  // A page can therefore inject fake log entries or skew the in-flight
  // request counter of its own tab, and nothing more.
  //
  // The hooks are installed lazily (startLogging, resumed logging, or
  // waitForNetworkIdle), never on pages nobody asked about. Once installed
  // they stay until the page unloads; with logging off they only count
  // in-flight requests.

  const interception = { fetch: false, xhr: false, console: false };
  let pageHooksInstalled = false;

  // Diagnostics for the real-browser check: when this copy of the script
  // started and when the hooks went in (document.readyState at that time).
  // "loading" at init means the early document_start injection ran.
  const injectionInfo = {
    readyStateAtInit: document.readyState as string,
    readyStateAtHookInstall: null as string | null,
  };

  function pushConsoleLog(entry: ConsoleLogEntry): void {
    consoleLogs.push(entry);
    if (consoleLogs.length > MAX_LOG_ENTRIES) {
      consoleLogs.shift();
    }
  }

  function pushNetworkLog(entry: NetworkLogEntry): void {
    // The single place entries are stored: masking here covers every path.
    const safe: NetworkLogEntry = { ...entry };
    if (safe.requestHeaders) safe.requestHeaders = maskHeaders(safe.requestHeaders);
    if (safe.responseHeaders) safe.responseHeaders = maskHeaders(safe.responseHeaders);
    networkLogs.push(safe);
    if (networkLogs.length > MAX_LOG_ENTRIES) {
      networkLogs.shift();
    }
  }

  /** Count one in-flight request; the returned function settles it (once). */
  function beginRequest(): () => void {
    __fox_activeRequests++;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      __fox_activeRequests = Math.max(0, __fox_activeRequests - 1);
    };
  }

  function safeString(value: unknown): string {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  }

  function stringifyArg(arg: unknown): string {
    if (typeof arg === "object" && arg !== null) {
      try {
        const json = JSON.stringify(arg, null, 2);
        if (typeof json === "string") return json;
      } catch {
        // cyclic or not serializable -- fall through
      }
    }
    return safeString(arg);
  }

  function errorMessage(reason: unknown): string {
    if (typeof reason === "object" && reason !== null) {
      const message = (reason as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return safeString(reason);
  }

  /** Read a Headers object, [name, value] pairs or a plain record (via Xray). */
  function readHeaders(headers: unknown): Record<string, string> | undefined {
    if (typeof headers !== "object" || headers === null) return undefined;
    const out: Record<string, string> = {};
    try {
      const h = headers as Headers;
      if (typeof h.forEach === "function" && typeof h.get === "function") {
        h.forEach((value, key) => {
          out[String(key)] = String(value);
        });
      } else if (Array.isArray(headers)) {
        for (const pair of headers as unknown[]) {
          if (Array.isArray(pair) && pair.length >= 2) {
            out[safeString(pair[0])] = safeString(pair[1]);
          }
        }
      } else {
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
          out[key] = safeString(value);
        }
      }
    } catch {
      return Object.keys(out).length > 0 ? out : undefined;
    }
    return out;
  }

  function describeFetch(input: unknown, init: unknown): NetworkLogEntry {
    let url = "";
    let method = "GET";
    let requestHeaders: Record<string, string> | undefined;
    let requestBody: string | null | undefined;

    if (typeof input === "string") {
      url = input;
    } else if (typeof input === "object" && input !== null) {
      const req = input as { url?: unknown; method?: unknown; headers?: unknown; href?: unknown };
      if (typeof req.url === "string") {
        // Request
        url = req.url;
        if (typeof req.method === "string") method = req.method;
        requestHeaders = readHeaders(req.headers);
      } else if (typeof req.href === "string") {
        // URL
        url = req.href;
      } else {
        url = safeString(input);
      }
    } else {
      url = safeString(input);
    }

    if (typeof init === "object" && init !== null) {
      const opts = init as { method?: unknown; headers?: unknown; body?: unknown };
      if (typeof opts.method === "string") method = opts.method;
      const fromInit = readHeaders(opts.headers);
      if (fromInit) requestHeaders = fromInit;
      if (opts.body !== undefined && opts.body !== null) {
        requestBody = safeString(opts.body).substring(0, 1000);
      }
    }

    const entry: NetworkLogEntry = {
      type: "fetch",
      method,
      url,
      startTime: new Date().toISOString(),
      pageUrl: window.location.href,
    };
    if (requestHeaders) entry.requestHeaders = requestHeaders;
    if (requestBody !== undefined) entry.requestBody = requestBody;
    return entry;
  }

  async function recordFetchResponse(
    entry: NetworkLogEntry,
    startTime: number,
    response: unknown,
  ): Promise<void> {
    try {
      const res = response as Response;
      entry.status = typeof res.status === "number" ? res.status : undefined;
      entry.statusText = typeof res.statusText === "string" ? res.statusText : undefined;
      entry.duration = Date.now() - startTime;
      entry.responseHeaders = readHeaders(res.headers);

      const contentType = entry.responseHeaders?.["content-type"] ?? "";
      if (contentType.includes("application/json") || contentType.includes("text/")) {
        // clone() runs before the first await, i.e. before the page's own
        // handlers (registered after ours) can consume the body.
        const clone = res.clone();
        try {
          const text = await clone.text();
          if (contentType.includes("application/json")) {
            try {
              entry.responseBody = JSON.stringify(JSON.parse(text), null, 2).substring(0, 5000);
            } catch {
              entry.responseBody = text.substring(0, 5000);
            }
          } else {
            entry.responseBody = text.substring(0, 5000);
          }
        } catch {
          entry.responseBody = "[Could not read response]";
        }
      } else {
        entry.responseBody = "[Binary data]";
      }
    } catch {
      entry.responseBody = "[Could not read response]";
    }
    if (shouldRecord()) pushNetworkLog(entry);
  }

  function installFetchHook(pageWin: Window & typeof globalThis): void {
    const originalFetch: unknown = pageWin.fetch;
    const pagePromiseThen: unknown = pageWin.Promise.prototype.then;
    if (typeof originalFetch !== "function" || typeof pagePromiseThen !== "function") {
      return;
    }

    const fetchHook = function (input: unknown, init: unknown): unknown {
      const settle = beginRequest();
      const startTime = Date.now();
      let entry: NetworkLogEntry | null = null;
      if (shouldRecord()) {
        try {
          entry = describeFetch(input, init);
        } catch {
          entry = null;
        }
      }

      let pagePromise: unknown;
      try {
        // The page's own fetch, run with the page's principal.
        pagePromise = Reflect.apply(originalFetch, pageWin, [input, init]);
      } catch (error) {
        settle();
        throw error;
      }

      // Observe completion with the page's Promise#then. The callbacks must
      // be exported (the page cannot call sandbox functions otherwise), must
      // not throw and must return undefined, so the derived promise always
      // resolves (no unhandled rejection shows up in the page).
      const onFulfilled = exportFunction(function (response: unknown): void {
        settle();
        if (entry && shouldRecord()) {
          void recordFetchResponse(entry, startTime, response);
        }
      }, window);
      const onRejected = exportFunction(function (reason: unknown): void {
        settle();
        if (entry && shouldRecord()) {
          entry.error = errorMessage(reason);
          entry.duration = Date.now() - startTime;
          pushNetworkLog(entry);
        }
      }, window);
      try {
        Reflect.apply(pagePromiseThen, pagePromise, [onFulfilled, onRejected]);
      } catch {
        settle();
      }
      return pagePromise;
    };

    exportFunction(fetchHook, pageWin, { defineAs: "fetch" });
    interception.fetch = true;
  }

  function installXhrHooks(pageWin: Window & typeof globalThis): void {
    const proto = pageWin.XMLHttpRequest.prototype;
    const originalOpen: unknown = proto.open;
    const originalSend: unknown = proto.send;
    const originalSetRequestHeader: unknown = proto.setRequestHeader;
    if (
      typeof originalOpen !== "function" ||
      typeof originalSend !== "function" ||
      typeof originalSetRequestHeader !== "function"
    ) {
      return;
    }

    // open() -> setRequestHeader() -> send() bookkeeping, keyed by the
    // (Xray-wrapped) XHR.
    const pending = new WeakMap<object, NetworkLogEntry>();

    const openHook = function (this: unknown, ...args: unknown[]): unknown {
      try {
        if (typeof this === "object" && this !== null) {
          if (shouldRecord()) {
            pending.set(this, {
              type: "xhr",
              method: safeString(args[0]),
              url: safeString(args[1]),
              startTime: "",
              pageUrl: window.location.href,
            });
          } else {
            pending.delete(this);
          }
        }
      } catch {
        // bookkeeping only -- never break the page's call
      }
      return Reflect.apply(originalOpen, this, args);
    };

    const setRequestHeaderHook = function (this: unknown, ...args: unknown[]): unknown {
      try {
        const entry =
          typeof this === "object" && this !== null ? pending.get(this) : undefined;
        if (entry && shouldRecord()) {
          // Stored raw here, masked by pushNetworkLog before it is kept.
          // Repeated names are combined the way XHR itself does.
          const name = safeString(args[0]);
          const value = safeString(args[1]);
          const headers = entry.requestHeaders ?? {};
          const existing = Object.keys(headers).find(
            (key) => key.toLowerCase() === name.toLowerCase(),
          );
          if (existing !== undefined) {
            headers[existing] = `${headers[existing]}, ${value}`;
          } else {
            headers[name] = value;
          }
          entry.requestHeaders = headers;
        }
      } catch {
        // bookkeeping only
      }
      return Reflect.apply(originalSetRequestHeader, this, args);
    };

    const sendHook = function (this: unknown, ...args: unknown[]): unknown {
      let settle: (() => void) | null = null;
      if (typeof this === "object" && this !== null) {
        const xhr = this as XMLHttpRequest;
        try {
          settle = beginRequest();
          xhr.addEventListener("loadend", settle);
        } catch {
          if (settle) settle();
          settle = null;
        }

        try {
          const entry = pending.get(this);
          pending.delete(this);
          if (entry && shouldRecord()) {
            const startTime = Date.now();
            entry.startTime = new Date().toISOString();
            entry.requestBody =
              args[0] !== undefined && args[0] !== null
                ? safeString(args[0]).substring(0, 1000)
                : null;

            xhr.addEventListener("load", () => {
              if (!shouldRecord()) return;
              entry.status = xhr.status;
              entry.statusText = xhr.statusText;
              entry.duration = Date.now() - startTime;
              try {
                entry.responseBody = xhr.responseText.substring(0, 5000);
              } catch {
                // responseType other than "" / "text"
                entry.responseBody = "[Could not read response]";
              }
              pushNetworkLog(entry);
            });

            xhr.addEventListener("error", () => {
              if (!shouldRecord()) return;
              entry.error = "Network error";
              entry.duration = Date.now() - startTime;
              pushNetworkLog(entry);
            });
          }
        } catch {
          // bookkeeping only
        }
      }

      try {
        return Reflect.apply(originalSend, this, args);
      } catch (error) {
        // send() threw synchronously (e.g. not opened) -- no loadend follows
        if (settle) settle();
        throw error;
      }
    };

    exportFunction(openHook, proto, { defineAs: "open" });
    exportFunction(sendHook, proto, { defineAs: "send" });
    exportFunction(setRequestHeaderHook, proto, { defineAs: "setRequestHeader" });
    interception.xhr = true;
  }

  function installConsoleHooks(pageWin: Window & typeof globalThis): void {
    const pageConsole = pageWin.console;
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      const original: unknown = pageConsole[method];
      if (typeof original !== "function") continue;
      const consoleHook = function (...args: unknown[]): void {
        if (shouldRecord()) {
          try {
            pushConsoleLog({
              level: method,
              timestamp: new Date().toISOString(),
              message: args.map(stringifyArg).join(" "),
              url: window.location.href,
            });
          } catch {
            // never break the page's console call
          }
        }
        Reflect.apply(original, pageConsole, args);
      };
      exportFunction(consoleHook, pageConsole, { defineAs: method });
    }
    interception.console = true;
  }

  /** Install the page-world hooks once per document (Firefox only). */
  function installPageHooks(): void {
    if (pageHooksInstalled) return;
    pageHooksInstalled = true;
    injectionInfo.readyStateAtHookInstall = document.readyState;

    const pageWin = window.wrappedJSObject;
    if (!pageWin || typeof exportFunction !== "function") {
      // Not Firefox: no Xray waivers -- leave everything unavailable.
      return;
    }
    try {
      installFetchHook(pageWin);
    } catch {
      interception.fetch = false;
    }
    try {
      installXhrHooks(pageWin);
    } catch {
      interception.xhr = false;
    }
    try {
      installConsoleHooks(pageWin);
    } catch {
      interception.console = false;
    }
  }

  /**
   * Resume logging after a reload / navigation (top frame only -- the
   * background script sends the logging commands to frame 0).
   *
   * When this copy was injected early (document_start, by the background
   * script, only for a tab whose logging is on) the hooks go in right away
   * so the page's first scripts are captured; should the background then
   * answer that logging is off, everything recorded so far is dropped.
   */
  function resumeLoggingFromBackground(): void {
    if (window !== window.top) return;

    const early = document.readyState === "loading";
    const versionAtQuery = loggingControlVersion;
    if (early) {
      installPageHooks();
      loggingEnabled = true;
    }

    const discardProvisional = (): void => {
      if (!early || loggingControlVersion !== versionAtQuery) return;
      loggingEnabled = false;
      consoleLogs = [];
      networkLogs = [];
    };

    browser.runtime
      .sendMessage({ type: LOGGING_STATE_QUERY })
      .then((reply: unknown) => {
        if (loggingControlVersion !== versionAtQuery) return;
        const state =
          typeof reply === "object" && reply !== null
            ? (reply as { enabled?: unknown; protectedPatterns?: unknown })
            : {};
        if (state.enabled === true) {
          protectedPatterns = compilePatterns(state.protectedPatterns);
          installPageHooks();
          loggingEnabled = true;
        } else {
          discardProvisional();
        }
      })
      .catch(() => {
        discardProvisional();
      });
  }

  // ---------------------------------------------------------------------------
  // Logging control
  // ---------------------------------------------------------------------------

  function startLogging(options: LoggingOptions = {}): Record<string, unknown> {
    loggingControlVersion++;
    protectedPatterns = compilePatterns(options.protectedPatterns);
    installPageHooks();
    loggingEnabled = true;
    if (options.clearExisting) {
      consoleLogs = [];
      networkLogs = [];
    }
    return {
      success: true,
      message: "Logging started",
      consoleLogsCount: consoleLogs.length,
      networkLogsCount: networkLogs.length,
      interception: { ...interception },
    };
  }

  function stopLogging(): Record<string, unknown> {
    loggingControlVersion++;
    loggingEnabled = false;
    return {
      success: true,
      message: "Logging stopped",
      consoleLogsCount: consoleLogs.length,
      networkLogsCount: networkLogs.length,
    };
  }

  function getConsoleLogs(options: ConsoleLogOptions = {}): Record<string, unknown> {
    let logs = [...consoleLogs];

    if (options.level) {
      logs = logs.filter((log) => log.level === options.level);
    }
    if (options.search) {
      const searchLower = options.search.toLowerCase();
      logs = logs.filter((log) =>
        log.message.toLowerCase().includes(searchLower),
      );
    }

    const limit = options.limit || 100;
    if (logs.length > limit) {
      logs = logs.slice(-limit);
    }

    return {
      success: true,
      logs,
      totalCount: consoleLogs.length,
      returnedCount: logs.length,
      loggingEnabled,
      interceptionAvailable: interception.console,
      injection: { ...injectionInfo },
    };
  }

  function getNetworkLogs(options: NetworkLogOptions = {}): Record<string, unknown> {
    let logs = [...networkLogs];

    if (options.urlPattern) {
      const pattern = new RegExp(options.urlPattern, "i");
      logs = logs.filter((log) => pattern.test(log.url));
    }
    if (options.method) {
      logs = logs.filter(
        (log) => log.method.toUpperCase() === options.method!.toUpperCase(),
      );
    }
    if (options.status) {
      logs = logs.filter((log) => log.status === options.status);
    }
    if (options.errorsOnly) {
      logs = logs.filter(
        (log) => log.error || (log.status !== undefined && log.status >= 400),
      );
    }

    const limit = options.limit || 100;
    if (logs.length > limit) {
      logs = logs.slice(-limit);
    }

    return {
      success: true,
      logs,
      totalCount: networkLogs.length,
      returnedCount: logs.length,
      loggingEnabled,
      interceptionAvailable: interception.fetch || interception.xhr,
      interception: { fetch: interception.fetch, xhr: interception.xhr },
    };
  }

  function clearLogs(options: ClearLogsOptions = {}): Record<string, unknown> {
    if (options.console !== false) {
      consoleLogs = [];
    }
    if (options.network !== false) {
      networkLogs = [];
    }
    return { success: true, message: "Logs cleared" };
  }

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: browser.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      handleMessage(message as ContentMessage)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            success: false,
            error: (error as Error).message,
          }),
        );
      return true;
    },
  );

  async function handleMessage(
    message: ContentMessage,
  ): Promise<Record<string, unknown>> {
    switch (message.action) {
      case "click":
        return performClick(message as unknown as ClickOptions);
      case "type":
        return performType(message as unknown as TypeOptions);
      case "scroll":
        return performScroll(message as unknown as ScrollOptions);
      case "getPageInfo":
        return getPageInfo();
      case "getElements":
        return getElements(message as unknown as { selector?: string; limit?: number });
      case "highlight":
        return highlightElement(message as unknown as HighlightOptions);
      case "waitForElement":
        return waitForElement(message as unknown as WaitOptions);
      case "waitForChange":
        return waitForChange(message as unknown as WaitForChangeOptions);
      case "waitForNetworkIdle":
        return waitForNetworkIdle(message as unknown as NetworkIdleOptions);
      case "observeElement":
        return observeElement(message as unknown as ObserveOptions);
      case "stopObserving":
        return stopObserving(message as unknown as { observerId: string });
      case "scrollAndCapture":
        return scrollAndCapture(message as unknown as ScrollCaptureOptions);
      case "clickAndWait":
        return clickAndWait(message as unknown as ClickAndWaitOptions);
      case "captureFullPage":
        return captureFullPage();
      case "inspectElement":
        return inspectElement(message as unknown as { x: number; y: number });
      case "getValue":
        return getValue(message as unknown as FindElementOptions);
      case "setValue":
        return setValue(message as unknown as SetValueOptions);
      case "getAttribute":
        return getAttribute(
          message as unknown as FindElementOptions & { attribute: string },
        );
      case "focus":
        return focusElement(message as unknown as FindElementOptions);
      case "hover":
        return hoverElement(message as unknown as FindElementOptions);
      case "selectOption":
        return selectOption(message as unknown as SelectOptionOptions);
      case "getComputedStyles":
        return getComputedStyles(message as unknown as ComputedStylesOptions);
      case "pressKey":
        return pressKey(message as unknown as PressKeyOptions);
      case "getText":
        return getText(message as unknown as TextOptions);
      case "requestApproval":
        return requestApproval(message as unknown as ApprovalOptions);
      case "solveCaptcha":
        return solveCaptcha(message as unknown as CaptchaOptions);
      case "cancelHumanWait":
        return cancelHumanWait();
      case "getBoundingRect":
        return getBoundingRect(message as unknown as FindElementOptions);
      case "startLogging":
        return startLogging(message as unknown as LoggingOptions);
      case "stopLogging":
        return stopLogging();
      case "getConsoleLogs":
        return getConsoleLogs(message as unknown as ConsoleLogOptions);
      case "getNetworkLogs":
        return getNetworkLogs(message as unknown as NetworkLogOptions);
      case "clearLogs":
        return clearLogs(message as unknown as ClearLogsOptions);
      default:
        throw new Error(`Unknown action: ${message.action}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Credential guard
  // ---------------------------------------------------------------------------

  function isPasswordField(element: Element): boolean {
    if (element.tagName !== "INPUT") return false;
    const input = element as HTMLInputElement;
    return (
      input.type === "password" ||
      input.getAttribute("autocomplete") === "current-password" ||
      input.getAttribute("autocomplete") === "new-password"
    );
  }

  function assertNotPasswordField(
    element: Element,
    options: { allowPassword?: boolean },
  ): void {
    if (isPasswordField(element) && options.allowPassword !== true) {
      throw new Error(
        "Refused: target is a password field. Use the browser’s own " +
          "password manager (autofill) for credentials, or set " +
          '"allow_password_typing": true in the safety config ' +
          "if you really want automated password entry.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  /**
   * Safely quote a string for use in an XPath expression.
   * Handles strings containing single quotes, double quotes, or both
   * by choosing the appropriate quoting or using concat().
   */
  function escapeXPathString(str: string): string {
    if (!str.includes("'")) {
      return `'${str}'`;
    }
    if (!str.includes('"')) {
      return `"${str}"`;
    }
    // Contains both ' and " — build a concat() expression
    const parts: string[] = [];
    let current = "";
    for (const ch of str) {
      if (ch === "'") {
        if (current) parts.push(`'${current}'`);
        parts.push(`"'"`)
        current = "";
      } else {
        current += ch;
      }
    }
    if (current) parts.push(`'${current}'`);
    return `concat(${parts.join(", ")})`;
  }

  function findElement(options: FindElementOptions): Element | null {
    if (options.selector) {
      return document.querySelector(options.selector);
    }
    if (options.xpath) {
      const result = document.evaluate(
        options.xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      return result.singleNodeValue as Element | null;
    }
    if (options.text) {
      const xpath = `//*[contains(text(), ${escapeXPathString(options.text)})]`;
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      return result.singleNodeValue as Element | null;
    }
    if (options.x !== undefined && options.y !== undefined) {
      return document.elementFromPoint(options.x, options.y);
    }
    if (options.id) {
      return document.getElementById(options.id);
    }
    if (options.name) {
      return document.querySelector(`[name=${CSS.escape(options.name)}]`);
    }
    if (options.ariaLabel) {
      return document.querySelector(
        `[aria-label=${CSS.escape(options.ariaLabel)}]`,
      );
    }
    if (options.placeholder) {
      return document.querySelector(
        `[placeholder=${CSS.escape(options.placeholder)}]`,
      );
    }
    if (options.role) {
      return document.querySelector(`[role=${CSS.escape(options.role)}]`);
    }
    return null;
  }

  function generateSelector(element: Element): string {
    if (element.id) return `#${CSS.escape(element.id)}`;

    const path: string[] = [];
    let current: Element | null = element;

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
        selector = `#${CSS.escape(current.id)}`;
        path.unshift(selector);
        break;
      }

      if (current.className && typeof current.className === "string") {
        const classes = current.className
          .trim()
          .split(/\s+/)
          .filter((c) => c && !/^[0-9]/.test(c));
        if (classes.length > 0) {
          selector +=
            "." + classes.slice(0, 2).map((c) => CSS.escape(c)).join(".");
        }
      }

      const siblings = current.parentElement?.children;
      if (siblings) {
        const sameTagSiblings = Array.from(siblings).filter(
          (s) => s.tagName === current!.tagName,
        );
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(" > ");
  }

  function generateXPath(element: Element): string {
    if (element.id) return `//*[@id="${CSS.escape(element.id)}"]`;

    const parts: string[] = [];
    let current: Node | null = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling: Node | null = current.previousSibling;

      while (sibling) {
        if (
          sibling.nodeType === Node.ELEMENT_NODE &&
          (sibling as Element).tagName === (current as Element).tagName
        ) {
          index++;
        }
        sibling = sibling.previousSibling;
      }

      const tagName = (current as Element).tagName.toLowerCase();
      parts.unshift(`${tagName}[${index}]`);
      current = current.parentNode;
    }

    return "/" + parts.join("/");
  }

  function getElementInfo(element: Element): ElementInfo {
    const rect = element.getBoundingClientRect();
    const htmlEl = element as HTMLInputElement;
    const isPassword = isPasswordField(element);

    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: Array.from(element.classList),
      name: htmlEl.name || null,
      type: htmlEl.type || null,
      text: element.textContent?.trim().substring(0, 200) || null,
      value: isPassword
        ? "[MASKED]"
        : (htmlEl.value?.substring(0, 200) ?? null),
      href: (element as HTMLAnchorElement).href || null,
      src: (element as HTMLImageElement).src || null,
      placeholder: htmlEl.placeholder || null,
      ariaLabel: element.getAttribute("aria-label"),
      role: element.getAttribute("role"),
      disabled: "disabled" in htmlEl ? htmlEl.disabled : false,
      checked: htmlEl.checked ?? false,
      visible: isVisible(element),
      position: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
      },
      selector: generateSelector(element),
    };
  }

  // ---------------------------------------------------------------------------
  // Overlay banner helper
  // ---------------------------------------------------------------------------

  /** finish() of each banner on screen, by banner id. */
  const activeBanners = new Map<string, (value: string) => void>();

  /**
   * The server stopped waiting (cancel_human_wait): close the banners as if
   * they had timed out, so a late click cannot look like an answer.
   */
  function cancelHumanWait(): Record<string, unknown> {
    let cancelled = 0;
    for (const id of ["__fox_approval_banner", "__fox_captcha_banner"]) {
      const finish = activeBanners.get(id);
      if (finish) {
        finish("timeout");
        cancelled++;
      }
    }
    return { success: true, cancelled: cancelled > 0 };
  }

  function createOverlayBanner(config: {
    id: string;
    title: string;
    detail?: string;
    buttons: Array<{ label: string; value: string; color: string; textColor?: string }>;
    timeoutMs: number;
    borderColor: string;
    background: string;
  }): Promise<string> {
    return new Promise((resolve) => {
      const existing = document.getElementById(config.id);
      if (existing) existing.remove();

      const banner = document.createElement("div");
      banner.id = config.id;
      banner.style.cssText = [
        "position:fixed",
        "top:0",
        "left:0",
        "right:0",
        "z-index:2147483647",
        `background:${config.background}`,
        "color:#fff",
        "padding:14px 20px",
        "font:14px/1.5 system-ui,sans-serif",
        "display:flex",
        "align-items:center",
        "gap:16px",
        "box-shadow:0 2px 12px rgba(0,0,0,.4)",
        `border-bottom:3px solid ${config.borderColor}`,
      ].join(";");

      const textWrap = document.createElement("div");
      textWrap.style.cssText = "flex:1;min-width:0";
      const titleEl = document.createElement("div");
      titleEl.style.cssText = "font-weight:600";
      titleEl.textContent = config.title;
      textWrap.appendChild(titleEl);
      if (config.detail) {
        const detailEl = document.createElement("div");
        detailEl.style.cssText =
          "font-size:12px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        detailEl.textContent = config.detail;
        textWrap.appendChild(detailEl);
      }

      banner.appendChild(textWrap);

      let settled = false;
      function finish(value: string): void {
        if (settled) return;
        settled = true;
        if (activeBanners.get(config.id) === finish) activeBanners.delete(config.id);
        banner.remove();
        resolve(value);
      }
      activeBanners.set(config.id, finish);

      for (const btn of config.buttons) {
        const b = document.createElement("button");
        b.textContent = btn.label;
        const tc = btn.textColor || "#fff";
        b.style.cssText =
          "padding:8px 18px;border:none;border-radius:6px;cursor:pointer;" +
          `font:600 13px system-ui,sans-serif;color:${tc};background:${btn.color}`;
        b.addEventListener("click", () => finish(btn.value));
        banner.appendChild(b);
      }

      (document.body || document.documentElement).appendChild(banner);
      setTimeout(() => finish("timeout"), config.timeoutMs);
    });
  }

  // ---------------------------------------------------------------------------
  // Approval banner
  // ---------------------------------------------------------------------------

  async function requestApproval(options: ApprovalOptions): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeout || TIMEOUTS.APPROVAL;
    const result = await createOverlayBanner({
      id: "__fox_approval_banner",
      title: msg("bannerApprovalTitle", options.message || msg("bannerApprovalDefault")),
      detail: options.detail,
      buttons: [
        { label: msg("bannerApprove"), value: "approve", color: "#16a34a" },
        { label: msg("bannerDeny"), value: "deny", color: "#dc2626" },
      ],
      timeoutMs,
      borderColor: "#e94560",
      background: "#1a1a2e",
    });

    return {
      success: true,
      approved: result === "approve",
      timedOut: result === "timeout",
      decidedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Captcha detection
  // ---------------------------------------------------------------------------

  function detectCaptcha(): { present: boolean; widgets: CaptchaWidget[] } {
    const widgets: CaptchaWidget[] = [];

    function hasResponseToken(name: string): boolean {
      const el = document.querySelector(
        `textarea[name="${CSS.escape(name)}"], input[name="${CSS.escape(name)}"]`,
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      return !!(el && el.value && el.value.length > 0);
    }

    if (
      document.querySelector(
        '.g-recaptcha, iframe[src*="recaptcha"], #g-recaptcha-response',
      )
    ) {
      widgets.push({
        type: "recaptcha",
        solved:
          hasResponseToken("g-recaptcha-response") ||
          !!document.querySelector(".recaptcha-checkbox-checked"),
      });
    }
    if (
      document.querySelector(
        '.h-captcha, iframe[src*="hcaptcha"], textarea[name="h-captcha-response"]',
      )
    ) {
      widgets.push({
        type: "hcaptcha",
        solved: hasResponseToken("h-captcha-response"),
      });
    }
    if (
      document.querySelector(
        '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]',
      )
    ) {
      widgets.push({
        type: "turnstile",
        solved: hasResponseToken("cf-turnstile-response"),
      });
    }
    if (
      widgets.length === 0 &&
      document.querySelector(
        'img[src*="captcha" i], input[name*="captcha" i], [id*="captcha" i], [class*="captcha" i]',
      )
    ) {
      widgets.push({ type: "generic", solved: null });
    }

    return { present: widgets.length > 0, widgets };
  }

  async function solveCaptcha(
    options: CaptchaOptions = {},
  ): Promise<Record<string, unknown>> {
    const detection = detectCaptcha();
    if (options.detectOnly) {
      return { success: true, ...detection };
    }
    if (!detection.present) {
      return {
        success: true,
        present: false,
        message: "No captcha detected on the page.",
      };
    }
    if (detection.widgets.every((w) => w.solved === true)) {
      return {
        success: true,
        present: true,
        solved: true,
        message: "Captcha already solved.",
        widgets: detection.widgets,
      };
    }

    const timeoutMs = options.timeout || TIMEOUTS.CAPTCHA;
    const start = Date.now();
    const types = detection.widgets.map((w) => w.type).join(", ");

    // Start the banner (resolves on button click or timeout)
    const bannerPromise = createOverlayBanner({
      id: "__fox_captcha_banner",
      title: msg("bannerCaptchaTitle", types),
      detail: msg("bannerCaptchaDetail"),
      buttons: [
        { label: msg("bannerDone"), value: "done", color: "#ffd166", textColor: "#0f3460" },
        { label: msg("bannerCancel"), value: "cancel", color: "transparent", textColor: "#fff" },
      ],
      timeoutMs,
      borderColor: "#ffd166",
      background: "#0f3460",
    });

    // Poll for token resolution concurrently
    const pollPromise = new Promise<string>((resolve) => {
      const poll = setInterval(() => {
        const now = detectCaptcha();
        const tokened = now.widgets.filter((w) => w.solved !== null);
        if (tokened.length && tokened.every((w) => w.solved === true)) {
          clearInterval(poll);
          resolve("token");
        }
      }, 1000);
      // Clean up poll when banner resolves first
      bannerPromise.then(() => clearInterval(poll));
    });

    const result = await Promise.race([bannerPromise, pollPromise]);
    // Remove banner if poll won the race
    const leftover = document.getElementById("__fox_captcha_banner");
    if (leftover) leftover.remove();

    const base = { success: true, present: true, elapsedMs: Date.now() - start };

    if (result === "token") {
      return { ...base, solved: true, resolvedBy: "token", widgets: detectCaptcha().widgets };
    } else if (result === "done") {
      return { ...base, solved: true, resolvedBy: "human", widgets: detectCaptcha().widgets };
    } else if (result === "cancel") {
      return { ...base, solved: false, cancelled: true };
    } else {
      // timeout
      return { ...base, solved: false, timedOut: true, widgets: detectCaptcha().widgets };
    }
  }

  // ---------------------------------------------------------------------------
  // Click
  // ---------------------------------------------------------------------------

  async function performClick(
    options: ClickOptions,
  ): Promise<Record<string, unknown>> {
    const element = findElement(options);
    if (!element) {
      throw new Error(
        `Element not found with options: ${JSON.stringify(options)}`,
      );
    }

    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(100);

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    if (options.rightClick) {
      element.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );
    } else if (options.doubleClick) {
      element.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );
    } else {
      element.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );
      await sleep(50);
      element.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );
      // One click event only. A dispatched click also runs the element's
      // activation behavior (links, checkboxes, submit buttons), so calling
      // element.click() as well would fire every click handler twice.
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );
    }

    return {
      clicked: true,
      element: getElementInfo(element),
      position: { x, y },
    };
  }

  // ---------------------------------------------------------------------------
  // Type
  // ---------------------------------------------------------------------------

  async function performType(
    options: TypeOptions,
  ): Promise<Record<string, unknown>> {
    let element: Element | null = findElement(options);

    if (!element && options.focusFirst === false) {
      element = document.activeElement;
    }

    if (!element) {
      throw new Error(
        `Element not found with options: ${JSON.stringify(options)}`,
      );
    }

    assertNotPasswordField(element, options);

    (element as HTMLElement).focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(100);

    const text = options.text || "";
    const htmlEl = element as HTMLInputElement;

    if (options.clear) {
      if (isTextInput(element)) {
        htmlEl.value = "";
      } else if ((element as HTMLElement).isContentEditable) {
        element.textContent = "";
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (options.instant) {
      if (isTextInput(element)) {
        htmlEl.value = options.clear ? text : htmlEl.value + text;
      } else if ((element as HTMLElement).isContentEditable) {
        element.textContent = options.clear
          ? text
          : (element.textContent || "") + text;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      for (const char of text) {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: char,
            code: `Key${char.toUpperCase()}`,
            bubbles: true,
          }),
        );
        element.dispatchEvent(
          new KeyboardEvent("keypress", {
            key: char,
            code: `Key${char.toUpperCase()}`,
            bubbles: true,
          }),
        );

        if (isTextInput(element)) {
          htmlEl.value += char;
        } else if ((element as HTMLElement).isContentEditable) {
          document.execCommand("insertText", false, char);
        }

        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: char,
            code: `Key${char.toUpperCase()}`,
            bubbles: true,
          }),
        );

        await sleep(options.delay || 50);
      }
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    if (options.pressEnter) {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
        }),
      );
      element.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
        }),
      );

      const form = (element as HTMLElement).closest("form");
      if (form && options.submitForm !== false) {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      }
    }

    return {
      typed: true,
      element: getElementInfo(element),
      text,
    };
  }

  // ---------------------------------------------------------------------------
  // Scroll
  // ---------------------------------------------------------------------------

  async function performScroll(
    options: ScrollOptions,
  ): Promise<Record<string, unknown>> {
    let target: Element | Window = window;
    let element: Element | null = null;

    if (options.selector || options.xpath || options.id) {
      element = findElement(options);
      if (element) {
        target = element;
      }
    }

    if (options.toElement) {
      const targetElement = findElement({ selector: options.toElement });
      if (targetElement) {
        targetElement.scrollIntoView({
          behavior: options.smooth !== false ? "smooth" : "auto",
          block: options.block || "center",
        });
        await sleep(500);
        return { scrolled: true, element: getElementInfo(targetElement) };
      }
    }

    if (options.direction) {
      const amount = options.amount || 300;
      let scrollX = 0;
      let scrollY = 0;

      switch (options.direction) {
        case "up":
          scrollY = -amount;
          break;
        case "down":
          scrollY = amount;
          break;
        case "left":
          scrollX = -amount;
          break;
        case "right":
          scrollX = amount;
          break;
        case "top":
          if (element) (element as HTMLElement).scrollTop = 0;
          else window.scrollTo({ top: 0, behavior: "smooth" });
          return { scrolled: true, position: { x: 0, y: 0 } };
        case "bottom":
          if (element)
            (element as HTMLElement).scrollTop = (
              element as HTMLElement
            ).scrollHeight;
          else
            window.scrollTo({
              top: document.body.scrollHeight,
              behavior: "smooth",
            });
          return { scrolled: true, position: "bottom" };
      }

      if (element) {
        element.scrollBy({ left: scrollX, top: scrollY, behavior: "smooth" });
      } else {
        window.scrollBy({ left: scrollX, top: scrollY, behavior: "smooth" });
      }
    } else if (options.x !== undefined || options.y !== undefined) {
      const scrollOpts: ScrollToOptions = {
        left: options.x || 0,
        top: options.y || 0,
        behavior: options.smooth !== false ? "smooth" : "auto",
      };

      if (element) {
        element.scrollTo(scrollOpts);
      } else {
        window.scrollTo(scrollOpts);
      }
    }

    await sleep(300);

    return {
      scrolled: true,
      position: {
        x: element ? (element as HTMLElement).scrollLeft : window.scrollX,
        y: element ? (element as HTMLElement).scrollTop : window.scrollY,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Page info
  // ---------------------------------------------------------------------------

  function getPageInfo(): Record<string, unknown> {
    const interactiveElements: Record<string, unknown>[] = [];

    document.querySelectorAll(INTERACTIVE_SELECTORS.join(", ")).forEach((el, index) => {
      if (index < 100) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const htmlEl = el as HTMLInputElement;
          interactiveElements.push({
            tag: el.tagName.toLowerCase(),
            type: htmlEl.type || null,
            id: el.id || null,
            name: htmlEl.name || null,
            text: el.textContent?.trim().substring(0, 100) || null,
            href: (el as HTMLAnchorElement).href || null,
            value: isPasswordField(el)
              ? "[MASKED]"
              : (htmlEl.value?.substring(0, 100) ?? null),
            placeholder: htmlEl.placeholder || null,
            ariaLabel: el.getAttribute("aria-label"),
            position: {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              width: rect.width,
              height: rect.height,
            },
            visible: isVisible(el),
            selector: generateSelector(el),
          });
        }
      }
    });

    return {
      url: window.location.href,
      title: document.title,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      interactiveElements,
      forms: Array.from(document.forms).map((form) => ({
        id: form.id,
        name: form.name,
        action: form.action,
        method: form.method,
        fields: Array.from(form.elements)
          .slice(0, 20)
          .map((el) => {
            const inp = el as HTMLInputElement;
            return {
              tag: el.tagName.toLowerCase(),
              type: inp.type,
              name: inp.name,
              id: el.id,
              placeholder: inp.placeholder,
              required: inp.required,
              value:
                inp.type === "password"
                  ? "[MASKED]"
                  : (inp.value?.substring(0, 50) ?? null),
            };
          }),
      })),
      headings: Array.from(document.querySelectorAll("h1, h2, h3"))
        .slice(0, 20)
        .map((h) => ({
          level: parseInt(h.tagName[1]),
          text: h.textContent?.trim().substring(0, 100),
        })),
    };
  }

  // ---------------------------------------------------------------------------
  // getElements
  // ---------------------------------------------------------------------------

  function getElements(options: {
    selector?: string;
    limit?: number;
  }): Record<string, unknown> {
    const elements: ElementInfo[] = [];
    const selector = options.selector || "*";
    const limit = options.limit || 50;

    document.querySelectorAll(selector).forEach((el, index) => {
      if (index < limit) {
        elements.push(getElementInfo(el));
      }
    });

    return {
      elements,
      count: document.querySelectorAll(selector).length,
    };
  }

  // ---------------------------------------------------------------------------
  // Highlight
  // ---------------------------------------------------------------------------

  function removeHighlight(): void {
    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }
  }

  function highlightElement(
    options: HighlightOptions,
  ): Record<string, unknown> {
    removeHighlight();

    const element = findElement(options);
    if (!element) {
      throw new Error("Element not found");
    }

    const rect = element.getBoundingClientRect();

    highlightOverlay = document.createElement("div");
    highlightOverlay.className = "kitsune-highlight-overlay";
    highlightOverlay.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid #7c3aed;
      background: rgba(124, 58, 237, 0.1);
      pointer-events: none;
      z-index: 999999;
      box-shadow: 0 0 10px rgba(124, 58, 237, 0.5);
      transition: all 0.3s ease;
    `;

    const label = document.createElement("div");
    label.style.cssText = `
      position: absolute;
      top: -25px;
      left: 0;
      background: #7c3aed;
      color: white;
      padding: 2px 8px;
      font-size: 12px;
      font-family: monospace;
      border-radius: 3px;
      white-space: nowrap;
    `;
    label.textContent = options.label || generateSelector(element);
    highlightOverlay.appendChild(label);

    document.body.appendChild(highlightOverlay);

    if (options.duration !== 0) {
      setTimeout(removeHighlight, options.duration || 3000);
    }

    return { highlighted: true, element: getElementInfo(element) };
  }

  // ---------------------------------------------------------------------------
  // Wait helpers
  // ---------------------------------------------------------------------------

  async function waitForElement(
    options: WaitOptions,
  ): Promise<Record<string, unknown>> {
    const timeout = options.timeout || TIMEOUTS.WAIT_ELEMENT;
    const interval = options.interval || 100;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const element = findElement(options);
      if (element) {
        if (!options.visible || isVisible(element)) {
          return { found: true, element: getElementInfo(element) };
        }
      }
      await sleep(interval);
    }

    throw new Error(`Element not found within ${timeout}ms`);
  }

  const activeObservers = new Map<string, ObserverRecord>();

  async function waitForChange(
    options: WaitForChangeOptions,
  ): Promise<Record<string, unknown>> {
    const timeout = options.timeout || TIMEOUTS.DEFAULT;
    const targetSelector = options.selector || "body";
    const target =
      document.querySelector(targetSelector) || document.body;

    return new Promise((resolve) => {
      let resolved = false;
      const changes: Record<string, unknown>[] = [];
      const startTime = Date.now();

      const observer = new MutationObserver((mutations) => {
        if (resolved) return;

        for (const mutation of mutations) {
          const change: Record<string, unknown> = {
            type: mutation.type,
            target: (mutation.target as Element).tagName?.toLowerCase(),
            addedNodes: mutation.addedNodes.length,
            removedNodes: mutation.removedNodes.length,
          };

          if (options.changeType) {
            if (
              options.changeType === "childList" &&
              mutation.type !== "childList"
            )
              continue;
            if (
              options.changeType === "attributes" &&
              mutation.type !== "attributes"
            )
              continue;
            if (
              options.changeType === "text" &&
              mutation.type !== "characterData"
            )
              continue;
          }

          changes.push(change);

          if (options.waitForAll !== true) {
            resolved = true;
            observer.disconnect();
            resolve({
              changed: true,
              changes,
              waitedMs: Date.now() - startTime,
            });
            return;
          }
        }
      });

      observer.observe(target, {
        childList: true,
        subtree: options.subtree !== false,
        attributes: options.attributes !== false,
        characterData: options.characterData === true,
        attributeOldValue: options.attributeOldValue === true,
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          observer.disconnect();
          if (changes.length > 0) {
            resolve({ changed: true, changes, waitedMs: timeout });
          } else {
            resolve({
              changed: false,
              changes: [],
              waitedMs: timeout,
              timedOut: true,
            });
          }
        }
      }, timeout);
    });
  }

  async function waitForNetworkIdle(
    options: NetworkIdleOptions,
  ): Promise<Record<string, unknown>> {
    // Counting needs the page hooks. Requests already in flight before they
    // were installed are not seen.
    installPageHooks();
    const timeout = options.timeout || TIMEOUTS.NETWORK_IDLE;
    const idleTime = options.idleTime || 500;
    const startTime = Date.now();
    let lastActivitySnapshot = __fox_activeRequests;
    let lastChangeTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (__fox_activeRequests !== lastActivitySnapshot) {
        lastActivitySnapshot = __fox_activeRequests;
        lastChangeTime = Date.now();
      }
      const idleDuration = Date.now() - lastChangeTime;
      if (__fox_activeRequests === 0 && idleDuration >= idleTime) {
        return {
          idle: true,
          waitedMs: Date.now() - startTime,
          pendingRequests: 0,
          interception: { fetch: interception.fetch, xhr: interception.xhr },
        };
      }
      await sleep(100);
    }

    return {
      idle: false,
      timedOut: true,
      waitedMs: timeout,
      pendingRequests: __fox_activeRequests,
      interception: { fetch: interception.fetch, xhr: interception.xhr },
    };
  }

  // ---------------------------------------------------------------------------
  // Observe / Stop observing
  // ---------------------------------------------------------------------------

  function observeElement(
    options: ObserveOptions,
  ): Record<string, unknown> {
    const target = document.querySelector(options.selector);
    if (!target) {
      throw new Error(`Element not found: ${options.selector}`);
    }

    const observerId = options.observerId || `obs_${Date.now()}`;

    if (activeObservers.has(observerId)) {
      activeObservers.get(observerId)!.observer.disconnect();
    }

    const changes: MutationChange[] = [];

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        changes.push({
          type: mutation.type,
          timestamp: Date.now(),
          target: generateSelector(mutation.target as Element),
          addedNodes: Array.from(mutation.addedNodes)
            .map((n) => (n as Element).tagName?.toLowerCase() || "text")
            .filter(Boolean),
          removedNodes: Array.from(mutation.removedNodes)
            .map((n) => (n as Element).tagName?.toLowerCase() || "text")
            .filter(Boolean),
          attributeName: mutation.attributeName,
          oldValue: mutation.oldValue,
        });

        if (changes.length > 100) changes.shift();
      }
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeOldValue: true,
    });

    activeObservers.set(observerId, {
      observer,
      changes,
      target: options.selector,
    });

    return { observing: true, observerId, target: options.selector };
  }

  function stopObserving(options: {
    observerId: string;
  }): Record<string, unknown> {
    const observerId = options.observerId;

    if (!activeObservers.has(observerId)) {
      return { found: false, observerId };
    }

    const record = activeObservers.get(observerId)!;
    record.observer.disconnect();
    activeObservers.delete(observerId);

    return {
      stopped: true,
      observerId,
      target: record.target,
      changes: record.changes,
      totalChanges: record.changes.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Scroll and capture
  // ---------------------------------------------------------------------------

  function getVisibleInteractiveElements(): Record<string, unknown>[] {
    const elements: Record<string, unknown>[] = [];
    document.querySelectorAll(INTERACTIVE_SELECTORS.join(", ")).forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        isVisible(el)
      ) {
        elements.push({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 50) || null,
          selector: generateSelector(el),
          position: {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          },
        });
      }
    });

    return elements.slice(0, 50);
  }

  async function scrollAndCapture(
    options: ScrollCaptureOptions,
  ): Promise<Record<string, unknown>> {
    const scrollStep =
      options.scrollStep || window.innerHeight * 0.8;
    const delay = options.delay || TIMEOUTS.SCROLL_STEP;
    const maxScrolls = options.maxScrolls || 20;

    const snapshots: Record<string, unknown>[] = [];
    const originalScroll = window.scrollY;
    let scrollCount = 0;

    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    await sleep(delay);

    while (scrollCount < maxScrolls) {
      snapshots.push({
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        visibleElements: getVisibleInteractiveElements(),
        timestamp: Date.now(),
      });

      if (
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 10
      ) {
        break;
      }

      window.scrollBy({ top: scrollStep, behavior: "smooth" });
      await sleep(delay);
      scrollCount++;
    }

    if (options.restore !== false) {
      window.scrollTo({
        top: originalScroll,
        behavior: "instant" as ScrollBehavior,
      });
    }

    return {
      completed: true,
      snapshots,
      totalScrolls: scrollCount,
      documentHeight: document.documentElement.scrollHeight,
      message: "Use browser_screenshot after each scroll position for images",
    };
  }

  // ---------------------------------------------------------------------------
  // Click and wait
  // ---------------------------------------------------------------------------

  async function clickAndWait(
    options: ClickAndWaitOptions,
  ): Promise<Record<string, unknown>> {
    const waitTimeout = options.waitTimeout || 5000;
    const waitForSel = options.waitForSelector;
    const shouldWaitForChange = options.waitForChange !== false;

    let changes: Record<string, unknown>[] = [];
    let observer: MutationObserver | null = null;

    if (shouldWaitForChange) {
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          changes.push({
            type: mutation.type,
            target: (mutation.target as Element).tagName?.toLowerCase(),
            addedNodes: mutation.addedNodes.length,
            removedNodes: mutation.removedNodes.length,
          });
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    }

    const clickResult = await performClick(options);
    const startTime = Date.now();

    if (waitForSel) {
      while (Date.now() - startTime < waitTimeout) {
        const el = document.querySelector(waitForSel);
        if (el && isVisible(el)) {
          if (observer) observer.disconnect();
          return {
            ...clickResult,
            waited: true,
            waitedMs: Date.now() - startTime,
            foundElement: getElementInfo(el),
            changes: changes.slice(0, 20),
          };
        }
        await sleep(100);
      }
    } else if (shouldWaitForChange) {
      let lastChangeCount = 0;
      let stableTime = 0;

      while (Date.now() - startTime < waitTimeout) {
        if (changes.length > lastChangeCount) {
          lastChangeCount = changes.length;
          stableTime = 0;
        } else {
          stableTime += 100;
          if (stableTime >= 500) break;
        }
        await sleep(100);
      }
    }

    if (observer) observer.disconnect();

    return {
      ...clickResult,
      waited: true,
      waitedMs: Date.now() - startTime,
      changes: changes.slice(0, 20),
      totalChanges: changes.length,
    };
  }

  // ---------------------------------------------------------------------------
  // captureFullPage, inspectElement, getValue, setValue, etc.
  // ---------------------------------------------------------------------------

  function captureFullPage(): Record<string, unknown> {
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  }

  function inspectElement(options: {
    x: number;
    y: number;
  }): Record<string, unknown> {
    const element = document.elementFromPoint(options.x, options.y);
    if (!element) {
      return { found: false };
    }

    highlightElement({
      selector: generateSelector(element),
      duration: 5000,
    });

    return {
      found: true,
      element: getElementInfo(element),
      selector: generateSelector(element),
      xpath: generateXPath(element),
    };
  }

  function getValue(
    options: FindElementOptions,
  ): Record<string, unknown> {
    const element = findElement(options);
    if (!element) throw new Error("Element not found");

    let value: string | null;

    if (isPasswordField(element)) {
      value = "[MASKED]";
    } else if (isTextInput(element)) {
      value = (element as HTMLInputElement).value;
    } else if (element.tagName === "SELECT") {
      const sel = element as HTMLSelectElement;
      value = sel.options[sel.selectedIndex]?.value ?? null;
    } else {
      value = element.textContent;
    }

    return { value, element: getElementInfo(element) };
  }

  function setValue(
    options: SetValueOptions,
  ): Record<string, unknown> {
    const element = findElement(options);
    if (!element) throw new Error("Element not found");

    assertNotPasswordField(element, options);

    if (isTextInput(element)) {
      element.value = options.value;
    } else if (element.tagName === "SELECT") {
      (element as HTMLSelectElement).value = options.value;
    } else if ((element as HTMLElement).isContentEditable) {
      element.textContent = options.value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    return { set: true, element: getElementInfo(element) };
  }

  function getAttribute(
    options: FindElementOptions & { attribute: string },
  ): Record<string, unknown> {
    const element = findElement(options);
    if (!element) throw new Error("Element not found");

    const value = element.getAttribute(options.attribute);
    return { value, element: getElementInfo(element) };
  }

  function focusElement(
    options: FindElementOptions,
  ): Record<string, unknown> {
    const element = findElement(options);
    if (!element) throw new Error("Element not found");

    (element as HTMLElement).focus();
    element.scrollIntoView({ behavior: "smooth", block: "center" });

    return { focused: true, element: getElementInfo(element) };
  }

  async function hoverElement(
    options: FindElementOptions,
  ): Promise<Record<string, unknown>> {
    const element = findElement(options);
    if (!element) throw new Error("Element not found");

    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(100);

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    element.dispatchEvent(
      new MouseEvent("mouseenter", {
        bubbles: true,
        clientX: x,
        clientY: y,
      }),
    );
    element.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        clientX: x,
        clientY: y,
      }),
    );

    return { hovered: true, element: getElementInfo(element) };
  }

  async function pressKey(
    options: PressKeyOptions,
  ): Promise<Record<string, unknown>> {
    let target: Element =
      document.activeElement || document.body;
    if (options.selector) {
      const element = findElement(options);
      if (!element) throw new Error("Element not found");
      (element as HTMLElement).focus();
      target = element;
    }

    const eventInit: KeyboardEventInit = {
      key: options.key,
      bubbles: true,
      cancelable: true,
      ctrlKey: !!options.ctrl,
      shiftKey: !!options.shift,
      altKey: !!options.alt,
      metaKey: !!options.meta,
    };

    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));

    // Synthetic key events don't trigger default actions; emulate Enter→submit
    if (
      options.key === "Enter" &&
      !options.ctrl &&
      !options.shift &&
      (target as HTMLInputElement).form
    ) {
      const form = (target as HTMLInputElement).form!;
      if (form.requestSubmit) {
        form.requestSubmit();
      } else {
        form.submit();
      }
    }

    return { pressed: options.key, element: getElementInfo(target) };
  }

  function getText(
    options: TextOptions,
  ): Record<string, unknown> {
    let element: Element = document.body;
    if (options.selector) {
      const found = findElement(options);
      if (!found) throw new Error("Element not found");
      element = found;
    }

    const maxLength = options.maxLength || 20000;
    const text =
      (element as HTMLElement).innerText || element.textContent || "";

    return {
      text: text.slice(0, maxLength),
      truncated: text.length > maxLength,
      totalLength: text.length,
      url: window.location.href,
      title: document.title,
    };
  }

  function selectOption(
    options: SelectOptionOptions,
  ): Record<string, unknown> {
    const element = findElement(options);
    if (!element || element.tagName !== "SELECT") {
      throw new Error("Select element not found");
    }

    const sel = element as HTMLSelectElement;

    if (options.value !== undefined) {
      sel.value = options.value;
    } else if (options.index !== undefined) {
      sel.selectedIndex = options.index;
    } else if (options.text) {
      const option = Array.from(sel.options).find(
        (o) => o.text === options.text,
      );
      if (option) sel.value = option.value;
    }

    sel.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      selected: true,
      value: sel.value,
      text: sel.options[sel.selectedIndex]?.text,
    };
  }

  function getComputedStyles(
    options: ComputedStylesOptions,
  ): Record<string, unknown> {
    const element = findElement(options);
    if (!element) throw new Error("Element not found");

    const styles = window.getComputedStyle(element);
    const properties = options.properties || [
      "display",
      "visibility",
      "opacity",
      "position",
      "width",
      "height",
      "color",
      "backgroundColor",
      "fontSize",
      "fontFamily",
      "margin",
      "padding",
    ];

    const result: Record<string, string> = {};
    properties.forEach((prop) => {
      result[prop] = styles.getPropertyValue(prop);
    });

    return { styles: result, element: getElementInfo(element) };
  }

  function getBoundingRect(
    options: FindElementOptions,
  ): Record<string, unknown> {
    const element = findElement(options);
    if (!element) throw new Error("Element not found");

    const rect = element.getBoundingClientRect();
    return {
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
      element: getElementInfo(element),
    };
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  resumeLoggingFromBackground();
  console.log("[KitsuneMCP] Content script loaded");
})();
