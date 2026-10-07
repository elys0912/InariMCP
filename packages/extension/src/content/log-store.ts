// Console / network log recording of this document: the on/off state, the
// entries not yet sent to the background, and the logging commands. Owns
// the logging state; the page hooks (page-hooks.ts) reach it only through
// the sink handed over when they are installed (ensurePageHooks).

import { compileUrlRules, findUrlRule, type CompiledUrlRule } from "../url-rule";
import { LOG_ENTRY_LIMIT, LOG_RECORD_MESSAGE, LOGGING_STATE_QUERY } from "./constants";
import { maskHeaders } from "./mask";
import {
  installPageHooks,
  interceptionStatus,
  injectionStatus,
  type PageHookSink,
} from "./page-hooks";
import type { ConsoleLogEntry, NetworkLogEntry, LoggingOptions, ClearLogsOptions } from "./types";

// Recording happens only while `loggingEnabled` is true. The on/off switch
// itself is kept per tab by the background script, so the next document
// after a reload / navigation resumes it (resumeLoggingFromBackground).
let loggingEnabled = false;

// Protected URL patterns of this tab's logging session (sent by the
// background script; empty when confirm_protected_actions is off). Checked
// against the current URL on every record, so a same-document move onto a
// protected URL (history.pushState) pauses recording too. Full navigations
// onto protected pages are handled by the background (no resume there).
// URL rules (url-rule.ts), as the background
// script compiled them from the MCP Server's protectedUrlRules.
let protectedPatterns: CompiledUrlRule[] = [];

function compilePatterns(raw: unknown): CompiledUrlRule[] {
  // The background script refused the command if an entry was unusable.
  return compileUrlRules(raw).rules;
}

function onProtectedPage(): boolean {
  return findUrlRule(window.location.href, protectedPatterns) !== undefined;
}

/** Record now? Logging on, and the page is not a protected one. */
function shouldRecord(): boolean {
  return loggingEnabled && !onProtectedPage();
}
// Entries recorded here but not yet handed to the background script,
// which keeps each tab's logs so that they survive reloads / navigations
// (background/logging.ts, "Console / network log buffers"). A timer sends them in
// batches (scheduleLogFlush); flushLogs / stopLogging hand over the rest.
let consoleLogs: ConsoleLogEntry[] = [];
let networkLogs: NetworkLogEntry[] = [];
/** Longest a recorded entry waits before it is sent to the background. */
const LOG_FLUSH_DELAY_MS = 250;

let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Bumped by every startLogging / stopLogging, so a late reply to the
// resume query cannot override a newer explicit command.
let loggingControlVersion = 0;

function pushConsoleLog(entry: ConsoleLogEntry): void {
  consoleLogs.push(entry);
  if (consoleLogs.length > LOG_ENTRY_LIMIT) {
    consoleLogs.shift();
  }
  scheduleLogFlush();
}

/** Send the pending entries to the background soon (one timer at a time). */
function scheduleLogFlush(): void {
  if (logFlushTimer === null) logFlushTimer = setTimeout(sendLogBatch, LOG_FLUSH_DELAY_MS);
}

/** The pending entries, removed from this script (the caller passes them on). */
function takePendingLogs(): { console: ConsoleLogEntry[]; network: NetworkLogEntry[] } {
  const batch = { console: consoleLogs, network: networkLogs };
  consoleLogs = [];
  networkLogs = [];
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  return batch;
}

/**
 * Hand the pending entries to the background. It keeps them only while
 * logging is on for this tab and the page is not protected, so a batch
 * from a provisional early-injection recording is dropped there if the
 * tab turns out not to be logging. When it dropped the batch because the
 * page is protected, the entries recorded here since are dropped too
 * (they come from the same page).
 */
export function sendLogBatch(): void {
  logFlushTimer = null;
  if (consoleLogs.length === 0 && networkLogs.length === 0) return;
  const batch = takePendingLogs();
  browser.runtime
    .sendMessage({ type: LOG_RECORD_MESSAGE, ...batch })
    .then((reply: unknown) => {
      const r = typeof reply === "object" && reply !== null
        ? (reply as { accepted?: unknown; reason?: unknown })
        : {};
      if (r.accepted === false && r.reason === "protected_page") takePendingLogs();
    })
    .catch(() => {
      // Background unreachable (extension reloading): the batch is lost
    });
}

function pushNetworkLog(entry: NetworkLogEntry): void {
  // The single place entries are stored: masking here covers every path.
  const safe: NetworkLogEntry = { ...entry };
  if (safe.requestHeaders) safe.requestHeaders = maskHeaders(safe.requestHeaders);
  if (safe.responseHeaders) safe.responseHeaders = maskHeaders(safe.responseHeaders);
  networkLogs.push(safe);
  if (networkLogs.length > LOG_ENTRY_LIMIT) {
    networkLogs.shift();
  }
  scheduleLogFlush();
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
/** The hooks report to this module. */
const PAGE_HOOK_SINK: PageHookSink = { shouldRecord, pushConsoleLog, pushNetworkLog };

/** Install the page hooks (once per document), reporting here. */
export function ensurePageHooks(): void {
  installPageHooks(PAGE_HOOK_SINK);
}

export function resumeLoggingFromBackground(): void {
  if (window !== window.top) return;

  const early = document.readyState === "loading";
  const versionAtQuery = loggingControlVersion;
  if (early) {
    ensurePageHooks();
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
        ensurePageHooks();
        loggingEnabled = true;
      } else {
        discardProvisional();
      }
    })
    .catch(() => {
      discardProvisional();
    });
}

export function startLogging(options: LoggingOptions = {}): Record<string, unknown> {
  loggingControlVersion++;
  protectedPatterns = compilePatterns(options.protectedPatterns);
  ensurePageHooks();
  loggingEnabled = true;
  if (options.clearExisting) takePendingLogs();
  return {
    success: true,
    message: "Logging started",
    interception: interceptionStatus(),
  };
}

/** Stop recording; the reply carries the entries not sent yet. */
export function stopLogging(): Record<string, unknown> {
  loggingControlVersion++;
  loggingEnabled = false;
  return { success: true, message: "Logging stopped", ...takePendingLogs() };
}

/**
 * get_console_logs / get_network_logs: the background serves the logs from
 * its buffer and asks here first for the entries not sent yet, and for
 * this document's hook status.
 */
export function flushLogs(): Record<string, unknown> {
  return {
    success: true,
    ...takePendingLogs(),
    loggingEnabled,
    interception: interceptionStatus(),
    injection: injectionStatus(),
  };
}

/** clear_logs: the background empties its buffer; drop what is pending here. */
export function clearLogs(options: ClearLogsOptions = {}): Record<string, unknown> {
  if (options.console !== false) consoleLogs = [];
  if (options.network !== false) networkLogs = [];
  // Nothing left to send: no batch timer either.
  if (consoleLogs.length === 0 && networkLogs.length === 0 && logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  return { success: true, message: "Logs cleared" };
}
