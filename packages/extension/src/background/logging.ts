// Console / network logging per tab: which tabs log (loggingTabs) and their
// log buffers (logBuffers), owned here (L3).

import type { CompiledUrlRule } from "../url-rule";
import { LOG_ENTRY_LIMIT, TOP_FRAME_ID } from "./constants";
import { appendLogRecords, queryConsoleLogs, queryNetworkLogs } from "./log-records";
import { sendToContentScript, noTargetTab } from "./tab-target";
import { shouldSkipTab } from "./tab-wait";
import type { CommandResult } from "./types";
import { findProtectedMatch, checkProtectedTarget } from "./url-policy";

// Console / network logging: tabs where it is switched on, with the
// protected URL patterns attached to start_logging (empty when the server
// sent none, i.e. confirm_protected_actions is off). The records are kept
// per tab in logBuffers (see below); this map tells the next document after
// a reload / navigation to resume recording (content script query + early
// injection, see listeners.ts) -- except while the tab is on a protected
// page, where recording is paused. Cleared by stop_logging or when the tab
// closes.
interface LoggingTabState {
  patterns: CompiledUrlRule[];
}
const loggingTabs = new Map<number, LoggingTabState>();

// Console / network log buffers (per tab, kept across navigations).
//
// The top frame's content script records entries while logging is on and
// forwards them here in small batches (LOG_RECORD_MESSAGE), plus whatever it
// still holds when asked (flushLogs / stopLogging). The buffers live in the
// background, so a reload or navigation -- which replaces the content script
// -- does not lose them. Each tab keeps at most LOG_ENTRY_LIMIT console and
// LOG_ENTRY_LIMIT network entries (oldest dropped). A buffer exists from
// start_logging until the tab closes; stop_logging keeps it (the logs stay
// readable), clear_logs empties it. Entries recorded in the last moment
// before a navigation can be lost (the batch in flight when the old page
// unloads).

interface LogBuffer {
  console: Record<string, unknown>[];
  network: Record<string, unknown>[];
}
const logBuffers = new Map<number, LogBuffer>();

/** Why a batch of log entries was dropped (LOG_RECORD_MESSAGE reply `reason`). */
export type LogRecordRefusal = "not_top_frame" | "not_logging" | "protected_page";

/**
 * Store entries a tab's top-frame content script sent (batch, flush or stop
 * reply). Dropped when the tab has no buffer (logging never started, or the
 * buffer was released) or the page they came from is protected; the reason
 * is returned (null: stored).
 */
export function acceptLogRecords(
  tabId: number,
  pageUrls: (string | undefined)[],
  payload: Readonly<Record<string, unknown>>,
): LogRecordRefusal | null {
  const buffer = logBuffers.get(tabId);
  if (!buffer) return "not_logging";
  const patterns = loggingTabs.get(tabId)?.patterns ?? [];
  if (pageUrls.some((u) => findProtectedMatch(u, patterns) !== undefined)) return "protected_page";
  appendLogRecords(buffer.console, payload.console, LOG_ENTRY_LIMIT);
  appendLogRecords(buffer.network, payload.network, LOG_ENTRY_LIMIT);
  return null;
}

function logCounts(tabId: number): { consoleLogsCount: number; networkLogsCount: number } {
  const buffer = logBuffers.get(tabId);
  return {
    consoleLogsCount: buffer?.console.length ?? 0,
    networkLogsCount: buffer?.network.length ?? 0,
  };
}

export async function startLoggingOnTab(
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> = {},
  protectedPatterns: CompiledUrlRule[],
  approvedHost: string | undefined,
): Promise<CommandResult> {
  // Same rule as a single-tab screenshot: refuse on a protected page, judged
  // by the tab's real URL (fails closed without a tab).
  if (!target) return noTargetTab();
  const refusal = checkProtectedTarget(target, protectedPatterns, approvedHost);
  if (refusal) return refusal;
  const tab = target;
  const result = await sendToContentScript(tab.id, {
    ...data,
    action: "startLogging",
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
  return { ...result, ...logCounts(tab.id), bufferLimit: LOG_ENTRY_LIMIT };
}

export async function stopLoggingOnTab(target: browser.tabs.Tab | undefined): Promise<CommandResult> {
  if (!target) return noTargetTab();
  // Ask the page first, so the entries it has not sent yet are kept.
  const reply = await sendToContentScript(target.id, { action: "stopLogging" });
  if (reply.success) acceptLogRecords(target.id, [target.url], reply);
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

export async function getLogsOfTab(
  action: "getConsoleLogs" | "getNetworkLogs",
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> = {},
  protectedPatterns: CompiledUrlRule[],
): Promise<CommandResult> {
  if (!target) return noTargetTab();
  // Collect what the current page recorded but has not sent yet. The logs
  // themselves come from the background buffer, so they are there even
  // when the current page has no content script.
  const flush = await sendToContentScript(target.id, { action: "flushLogs" });
  if (flush.success) acceptLogRecords(target.id, [target.url], flush);
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

export async function clearLogsOfTab(
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  if (!target) return noTargetTab();
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

/** Whether logging is on for the tab (LOG_RECORD_MESSAGE batches are kept). */
export function isLoggingTab(tabId: number): boolean {
  return loggingTabs.has(tabId);
}

/**
 * Reply to a content script's LOGGING_STATE_QUERY. Only the top frame
 * records (commands go to frame 0). The URL is the one the browser reports
 * for the sender (tab and document), never a value supplied in the message.
 */
export function loggingStateFor(
  sender: browser.runtime.MessageSender,
): { enabled: boolean; pausedForProtectedDomain?: boolean; protectedPatterns?: unknown[] } {
  const senderTabId = sender.tab?.id;
  const state = senderTabId !== undefined ? loggingTabs.get(senderTabId) : undefined;
  if (sender.frameId !== TOP_FRAME_ID || !state) {
    return { enabled: false };
  }
  if (
    findProtectedMatch(sender.tab?.url, state.patterns) ||
    findProtectedMatch(sender.url, state.patterns)
  ) {
    // Paused while on a protected page; resumes on the next
    // non-protected document (logging stays on for the tab).
    return { enabled: false, pausedForProtectedDomain: true };
  }
  return {
    enabled: true,
    protectedPatterns: state.patterns.map((p) => p.rule),
  };
}

/**
 * Whether a new top-level document of the tab gets the early (document_start)
 * content script injection: logging is on for the tab and the page is not
 * protected.
 */
export function wantsEarlyInjection(tabId: number, url: string): boolean {
  const state = loggingTabs.get(tabId);
  if (!state || shouldSkipTab(url)) return false;
  // Protected page: recording is paused there, so no early hooks either.
  if (findProtectedMatch(url, state.patterns)) return false;
  return true;
}

/** The tab closed: logging off and its buffer released. */
export function forgetTab(tabId: number): void {
  loggingTabs.delete(tabId);
  logBuffers.delete(tabId);
}
