// Console & network logging: hooks in the page's own JS world.
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
//   - they never touch browser.* APIs (recorded entries are sent to the
//     background later, by a timer of this script) and never hand sandbox
//     objects to the page (return values are the page's own objects or
//     undefined);
//   - page values are read through Xrays (page getters / toJSON do not
//     run), inside try/catch, and stored only as strings / numbers.
// A page can therefore inject fake log entries or skew the in-flight
// request counter of its own tab, and nothing more.
//
// The hooks are installed lazily (startLogging, resumed logging, or
// waitForNetworkIdle), never on pages nobody asked about. Once installed
// they stay until the page unloads; with logging off they only count
// in-flight requests.
//
// This module records nothing itself: the hooks hand entries to the sink
// passed to installPageHooks (log-store.ts), and it imports nothing from
// log-store.ts.

import { LOG_TEXT_LIMIT } from "./constants";
import { truncateText } from "./dom";
import type { ConsoleLogEntry, NetworkLogEntry } from "./types";

/** Console message length kept per argument / per entry. */
const MAX_CONSOLE_ARG_CHARS = 2000;
const MAX_CONSOLE_MESSAGE_CHARS = LOG_TEXT_LIMIT;

// In-flight page requests (fetch + XHR) seen by the page hooks; used by
// waitForNetworkIdle. A count only -- no request content.
let __fox_activeRequests = 0;

const interception = { fetch: false, xhr: false, console: false };
let pageHooksInstalled = false;

// Diagnostics for the real-browser check: when this copy of the script
// started and when the hooks went in (document.readyState at that time).
// "loading" at init means the early document_start injection ran.
// readyStateAtInit is set by content.ts right after its guard
// (recordScriptStart), not at module load.
const injectionInfo = {
  readyStateAtInit: null as string | null,
  readyStateAtHookInstall: null as string | null,
};

/** Where the hooks hand what they see (log-store.ts). */
export interface PageHookSink {
  /** Record now? (logging on, page not protected) */
  shouldRecord(): boolean;
  pushConsoleLog(entry: ConsoleLogEntry): void;
  pushNetworkLog(entry: NetworkLogEntry): void;
}

/** content.ts, once per injection that passed the guard. */
export function recordScriptStart(): void {
  injectionInfo.readyStateAtInit = document.readyState;
}

/** In-flight page requests (fetch + XHR) seen by the hooks. */
export function activeRequestCount(): number {
  return __fox_activeRequests;
}

/** Which hooks are in (a copy). */
export function interceptionStatus(): { fetch: boolean; xhr: boolean; console: boolean } {
  return { ...interception };
}

/** injectionInfo (a copy). */
export function injectionStatus(): { readyStateAtInit: string | null; readyStateAtHookInstall: string | null } {
  return { ...injectionInfo };
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
      requestBody = truncateText(safeString(opts.body), 1000);
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
  sink: PageHookSink,
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
            entry.responseBody = truncateText(JSON.stringify(JSON.parse(text), null, 2), LOG_TEXT_LIMIT);
          } catch {
            entry.responseBody = truncateText(text, LOG_TEXT_LIMIT);
          }
        } else {
          entry.responseBody = truncateText(text, LOG_TEXT_LIMIT);
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
  if (sink.shouldRecord()) sink.pushNetworkLog(entry);
}

function installFetchHook(pageWin: Window & typeof globalThis, sink: PageHookSink): void {
  const originalFetch: unknown = pageWin.fetch;
  const pagePromiseThen: unknown = pageWin.Promise.prototype.then;
  if (typeof originalFetch !== "function" || typeof pagePromiseThen !== "function") {
    return;
  }

  const fetchHook = function (input: unknown, init: unknown): unknown {
    const settle = beginRequest();
    const startTime = Date.now();
    let entry: NetworkLogEntry | null = null;
    if (sink.shouldRecord()) {
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
      if (entry && sink.shouldRecord()) {
        void recordFetchResponse(entry, startTime, response, sink);
      }
    }, window);
    const onRejected = exportFunction(function (reason: unknown): void {
      settle();
      if (entry && sink.shouldRecord()) {
        entry.error = errorMessage(reason);
        entry.duration = Date.now() - startTime;
        sink.pushNetworkLog(entry);
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

function installXhrHooks(pageWin: Window & typeof globalThis, sink: PageHookSink): void {
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
        if (sink.shouldRecord()) {
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
      if (entry && sink.shouldRecord()) {
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
        if (entry && sink.shouldRecord()) {
          const startTime = Date.now();
          entry.startTime = new Date().toISOString();
          entry.requestBody =
            args[0] !== undefined && args[0] !== null
              ? truncateText(safeString(args[0]), 1000)
              : null;

          xhr.addEventListener("load", () => {
            if (!sink.shouldRecord()) return;
            entry.status = xhr.status;
            entry.statusText = xhr.statusText;
            entry.duration = Date.now() - startTime;
            try {
              entry.responseBody = truncateText(xhr.responseText, LOG_TEXT_LIMIT);
            } catch {
              // responseType other than "" / "text"
              entry.responseBody = "[Could not read response]";
            }
            sink.pushNetworkLog(entry);
          });

          // Exactly one of load / error / abort / timeout ends a send().
          const recordFailure = (error: string) => () => {
            if (!sink.shouldRecord()) return;
            entry.error = error;
            entry.duration = Date.now() - startTime;
            sink.pushNetworkLog(entry);
          };
          xhr.addEventListener("error", recordFailure("Network error"));
          xhr.addEventListener("abort", recordFailure("Aborted"));
          xhr.addEventListener("timeout", recordFailure("Timeout"));
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

function installConsoleHooks(pageWin: Window & typeof globalThis, sink: PageHookSink): void {
  const pageConsole = pageWin.console;
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    const original: unknown = pageConsole[method];
    if (typeof original !== "function") continue;
    const consoleHook = function (...args: unknown[]): void {
      if (sink.shouldRecord()) {
        try {
          sink.pushConsoleLog({
            level: method,
            timestamp: new Date().toISOString(),
            message: truncateText(
              args
                .map((arg) => truncateText(stringifyArg(arg), MAX_CONSOLE_ARG_CHARS))
                .join(" "),
              MAX_CONSOLE_MESSAGE_CHARS,
            ),
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

/**
 * Install the page-world hooks once per document (Firefox only). The first
 * call's sink is the one the hooks use.
 */
export function installPageHooks(sink: PageHookSink): void {
  if (pageHooksInstalled) return;
  pageHooksInstalled = true;
  injectionInfo.readyStateAtHookInstall = document.readyState;

  const pageWin = window.wrappedJSObject;
  if (!pageWin || typeof exportFunction !== "function") {
    // Not Firefox: no Xray waivers -- leave everything unavailable.
    return;
  }
  try {
    installFetchHook(pageWin, sink);
  } catch {
    interception.fetch = false;
  }
  try {
    installXhrHooks(pageWin, sink);
  } catch {
    interception.xhr = false;
  }
  try {
    installConsoleHooks(pageWin, sink);
  } catch {
    interception.console = false;
  }
}
