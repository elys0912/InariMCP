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
  // State
  // ---------------------------------------------------------------------------

  let highlightOverlay: HTMLDivElement | null = null;

  let loggingEnabled = false;
  let consoleLogs: ConsoleLogEntry[] = [];
  let networkLogs: NetworkLogEntry[] = [];
  const MAX_LOG_ENTRIES = 500;

  // Active network request counter (used by waitForNetworkIdle)
  let __fox_activeRequests = 0;

  // Original console methods (saved for restoration)
  const originalConsole: Record<string, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  // ---------------------------------------------------------------------------
  // Console & Network Logging
  // ---------------------------------------------------------------------------

  const interception = { fetch: false, xhr: false, console: false };

  function interceptConsole(): void {
    (["log", "warn", "error", "info", "debug"] as const).forEach((method) => {
      (console as unknown as Record<string, (...a: unknown[]) => void>)[method] =
        function (...args: unknown[]) {
          if (loggingEnabled) {
            const entry: ConsoleLogEntry = {
              level: method,
              timestamp: new Date().toISOString(),
              message: args
                .map((arg) => {
                  try {
                    if (typeof arg === "object") {
                      return JSON.stringify(arg, null, 2);
                    }
                    return String(arg);
                  } catch {
                    return String(arg);
                  }
                })
                .join(" "),
              url: window.location.href,
            };
            consoleLogs.push(entry);
            if (consoleLogs.length > MAX_LOG_ENTRIES) {
              consoleLogs.shift();
            }
          }
          originalConsole[method].apply(console, args);
        };
    });
  }

  // Network interceptor — fetch
  const originalFetch = window.fetch;
  const fetchInterceptor: typeof window.fetch = async function (
    ...args: Parameters<typeof window.fetch>
  ): Promise<Response> {
    const startTime = Date.now();
    const [resource, init] = args;
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.href
          : (resource as Request).url;
    const method = init?.method || "GET";

    const logEntry: NetworkLogEntry = {
      type: "fetch",
      method,
      url,
      startTime: new Date().toISOString(),
      pageUrl: window.location.href,
    };

    if (init?.headers) {
      logEntry.requestHeaders = maskHeaders(
        init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : (init.headers as Record<string, string>),
      );
    }
    if (init?.body) {
      logEntry.requestBody = String(init.body).substring(0, 1000);
    }

    __fox_activeRequests++;
    try {
      const response = await originalFetch.apply(
        window,
        args as [RequestInfo | URL, RequestInit?],
      );
      const endTime = Date.now();

      if (loggingEnabled) {
        logEntry.status = response.status;
        logEntry.statusText = response.statusText;
        logEntry.duration = endTime - startTime;
        logEntry.responseHeaders = maskHeaders(
          Object.fromEntries(response.headers.entries()),
        );

        const clone = response.clone();
        try {
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const body: unknown = await clone.json();
            logEntry.responseBody = JSON.stringify(body, null, 2).substring(
              0,
              5000,
            );
          } else if (contentType.includes("text/")) {
            logEntry.responseBody = (await clone.text()).substring(0, 5000);
          } else {
            logEntry.responseBody = "[Binary data]";
          }
        } catch {
          logEntry.responseBody = "[Could not read response]";
        }

        networkLogs.push(logEntry);
        if (networkLogs.length > MAX_LOG_ENTRIES) {
          networkLogs.shift();
        }
      }

      __fox_activeRequests--;
      return response;
    } catch (error) {
      __fox_activeRequests--;
      if (loggingEnabled) {
        logEntry.error = (error as Error).message;
        logEntry.duration = Date.now() - startTime;
        networkLogs.push(logEntry);
        if (networkLogs.length > MAX_LOG_ENTRIES) {
          networkLogs.shift();
        }
      }
      throw error;
    }
  };

  try {
    window.fetch = fetchInterceptor;
    interception.fetch = true;
  } catch {
    // fetch is read-only in Firefox's content-script sandbox
  }

  // XHR interceptor
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  interface TrackedXHR extends XMLHttpRequest {
    _logData?: NetworkLogEntry;
  }

  const xhrOpenInterceptor = function (
    this: TrackedXHR,
    method: string,
    url: string | URL,
    async_?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    this._logData = {
      type: "xhr",
      method,
      url: String(url),
      startTime: "",
      pageUrl: window.location.href,
    };
    return originalXHROpen.call(
      this,
      method,
      url,
      async_ ?? true,
      username,
      password,
    );
  };

  const xhrSendInterceptor = function (
    this: TrackedXHR,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    __fox_activeRequests++;
    this.addEventListener("loadend", () => {
      __fox_activeRequests--;
    });

    if (loggingEnabled && this._logData) {
      const startTime = Date.now();
      this._logData.startTime = new Date().toISOString();
      this._logData.requestBody = body
        ? String(body).substring(0, 1000)
        : null;

      this.addEventListener("load", () => {
        if (!this._logData) return;
        this._logData.status = this.status;
        this._logData.statusText = this.statusText;
        this._logData.duration = Date.now() - startTime;
        this._logData.responseBody = this.responseText?.substring(0, 5000);
        networkLogs.push({ ...this._logData });
        if (networkLogs.length > MAX_LOG_ENTRIES) {
          networkLogs.shift();
        }
      });

      this.addEventListener("error", () => {
        if (!this._logData) return;
        this._logData.error = "Network error";
        this._logData.duration = Date.now() - startTime;
        networkLogs.push({ ...this._logData });
        if (networkLogs.length > MAX_LOG_ENTRIES) {
          networkLogs.shift();
        }
      });
    }
    return originalXHRSend.apply(this, [body]);
  };

  try {
    XMLHttpRequest.prototype.open = xhrOpenInterceptor as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = xhrSendInterceptor as typeof XMLHttpRequest.prototype.send;
    interception.xhr = true;
  } catch {
    // XHR prototype not writable in this sandbox
  }

  try {
    interceptConsole();
    interception.console = true;
  } catch {
    // console not writable in this sandbox
  }

  // ---------------------------------------------------------------------------
  // Logging control
  // ---------------------------------------------------------------------------

  function startLogging(options: LoggingOptions = {}): Record<string, unknown> {
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
    };
  }

  function stopLogging(): Record<string, unknown> {
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
  // Approval banner
  // ---------------------------------------------------------------------------

  function requestApproval(options: ApprovalOptions): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const existing = document.getElementById("__fox_approval_banner");
      if (existing) existing.remove();

      const banner = document.createElement("div");
      banner.id = "__fox_approval_banner";
      banner.style.cssText = [
        "position:fixed",
        "top:0",
        "left:0",
        "right:0",
        "z-index:2147483647",
        "background:#1a1a2e",
        "color:#fff",
        "padding:14px 20px",
        "font:14px/1.5 system-ui,sans-serif",
        "display:flex",
        "align-items:center",
        "gap:16px",
        "box-shadow:0 2px 12px rgba(0,0,0,.4)",
        "border-bottom:3px solid #e94560",
      ].join(";");

      const textWrap = document.createElement("div");
      textWrap.style.cssText = "flex:1;min-width:0";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600";
      title.textContent =
        "⚠️ KitsuneMCP requests approval: " +
        (options.message || "Perform an action");
      textWrap.appendChild(title);
      if (options.detail) {
        const detail = document.createElement("div");
        detail.style.cssText =
          "font-size:12px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        detail.textContent = options.detail;
        textWrap.appendChild(detail);
      }

      function makeButton(label: string, bg: string): HTMLButtonElement {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText =
          "padding:8px 18px;border:none;border-radius:6px;cursor:pointer;" +
          "font:600 13px system-ui,sans-serif;color:#fff;background:" +
          bg;
        return b;
      }
      const approveBtn = makeButton("Approve", "#16a34a");
      const denyBtn = makeButton("Deny", "#dc2626");

      banner.appendChild(textWrap);
      banner.appendChild(approveBtn);
      banner.appendChild(denyBtn);
      (document.body || document.documentElement).appendChild(banner);

      const timeoutMs = options.timeout || 60000;
      let settled = false;
      function finish(approved: boolean, timedOut: boolean): void {
        if (settled) return;
        settled = true;
        banner.remove();
        resolve({
          success: true,
          approved,
          timedOut,
          decidedAt: new Date().toISOString(),
        });
      }

      approveBtn.addEventListener("click", () => finish(true, false));
      denyBtn.addEventListener("click", () => finish(false, false));
      setTimeout(() => finish(false, true), timeoutMs);
    });
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

  function solveCaptcha(
    options: CaptchaOptions = {},
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
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

    return new Promise((resolve) => {
      const existing = document.getElementById("__fox_captcha_banner");
      if (existing) existing.remove();

      const types = detection.widgets.map((w) => w.type).join(", ");
      const banner = document.createElement("div");
      banner.id = "__fox_captcha_banner";
      banner.style.cssText = [
        "position:fixed",
        "top:0",
        "left:0",
        "right:0",
        "z-index:2147483647",
        "background:#0f3460",
        "color:#fff",
        "padding:14px 20px",
        "font:14px/1.5 system-ui,sans-serif",
        "display:flex",
        "align-items:center",
        "gap:16px",
        "box-shadow:0 2px 12px rgba(0,0,0,.4)",
        "border-bottom:3px solid #ffd166",
      ].join(";");

      const textWrap = document.createElement("div");
      textWrap.style.cssText = "flex:1;min-width:0";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600";
      title.textContent =
        "🧩 Please solve the captcha (" +
        types +
        "), then it continues automatically.";
      const detail = document.createElement("div");
      detail.style.cssText = "font-size:12px;opacity:.8";
      detail.textContent =
        "KitsuneMCP paused and is waiting for you. Click Done if it does not continue on its own.";
      textWrap.appendChild(title);
      textWrap.appendChild(detail);

      const doneBtn = document.createElement("button");
      doneBtn.textContent = "Done";
      doneBtn.style.cssText =
        "padding:8px 18px;border:none;border-radius:6px;cursor:pointer;" +
        "font:600 13px system-ui,sans-serif;color:#0f3460;background:#ffd166";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText =
        "padding:8px 14px;border:1px solid #ffffff55;border-radius:6px;" +
        "cursor:pointer;font:600 13px system-ui,sans-serif;color:#fff;background:transparent";

      banner.appendChild(textWrap);
      banner.appendChild(doneBtn);
      banner.appendChild(cancelBtn);
      (document.body || document.documentElement).appendChild(banner);

      const timeoutMs = options.timeout || 180000;
      const start = Date.now();
      let settled = false;

      function finish(payload: Record<string, unknown>): void {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        banner.remove();
        resolve({
          success: true,
          present: true,
          elapsedMs: Date.now() - start,
          ...payload,
        });
      }

      const poll = setInterval(() => {
        const now = detectCaptcha();
        const tokened = now.widgets.filter((w) => w.solved !== null);
        if (tokened.length && tokened.every((w) => w.solved === true)) {
          finish({ solved: true, resolvedBy: "token", widgets: now.widgets });
        } else if (Date.now() - start > timeoutMs) {
          finish({ solved: false, timedOut: true, widgets: now.widgets });
        }
      }, 1000);

      doneBtn.addEventListener("click", () =>
        finish({
          solved: true,
          resolvedBy: "human",
          widgets: detectCaptcha().widgets,
        }),
      );
      cancelBtn.addEventListener("click", () =>
        finish({ solved: false, cancelled: true }),
      );
    });
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
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }),
      );

      if ((element as HTMLElement).click) {
        (element as HTMLElement).click();
      }
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
      if (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA"
      ) {
        htmlEl.value = "";
      } else if ((element as HTMLElement).isContentEditable) {
        element.textContent = "";
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (options.instant) {
      if (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA"
      ) {
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

        if (
          element.tagName === "INPUT" ||
          element.tagName === "TEXTAREA"
        ) {
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

    const selectors = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[onclick]",
      '[role="button"]',
      '[role="link"]',
      '[tabindex]:not([tabindex="-1"])',
    ];

    document.querySelectorAll(selectors.join(", ")).forEach((el, index) => {
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
    const timeout = options.timeout || 10000;
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
    const timeout = options.timeout || 10000;
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
    const timeout = options.timeout || 10000;
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
        };
      }
      await sleep(100);
    }

    return {
      idle: false,
      timedOut: true,
      waitedMs: timeout,
      pendingRequests: __fox_activeRequests,
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
    const selectorList = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[onclick]",
      '[role="button"]',
      '[role="link"]',
      '[tabindex]:not([tabindex="-1"])',
    ];

    document.querySelectorAll(selectorList.join(", ")).forEach((el) => {
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
    const delay = options.delay || 500;
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
    } else if (
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA"
    ) {
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

    if (
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA"
    ) {
      (element as HTMLInputElement).value = options.value;
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

  console.log("[KitsuneMCP] Content script loaded");
})();
