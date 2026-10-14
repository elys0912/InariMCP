// Tab URL filters and waits for loads / navigations / URLs (L1).

import { urlPatternProblem } from "@inari-mcp/shared/url-pattern-limit";
import { errorMessage } from "../error-message";
import { TIMEOUTS, TOP_FRAME_ID } from "./constants";
import { resolveTab, noTargetTab } from "./tab-target";
import type { CommandResult } from "./types";

const EXCLUDED_URL_PREFIXES = ["about:", "moz-extension:"] as const;

export function shouldSkipTab(url: string | undefined): boolean {
  if (!url) return true;
  return EXCLUDED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

type UrlPatternArg = { ok: true; pattern: RegExp | null } | { ok: false; result: CommandResult };

/**
 * Compile a `urlPattern` argument: a regex without flags (case-sensitive),
 * as on every urlPattern tool of both backends. null pattern when absent;
 * a failure result when it does not compile, or is refused by the limits
 * the MCP Server applies as well (shared/src/url-pattern-limit.ts): this
 * background page is persistent, and a regex that backtracks for minutes
 * would stall every tool and approval.
 */
export function urlPatternArg(source: unknown): UrlPatternArg {
  if (typeof source !== "string" || source === "") return { ok: true, pattern: null };
  const problem = urlPatternProblem(source);
  if (problem !== null) return { ok: false, result: { success: false, error: `Invalid urlPattern: ${problem}` } };
  try {
    return { ok: true, pattern: new RegExp(source) };
  } catch (error) {
    return { ok: false, result: { success: false, error: `Invalid urlPattern: ${errorMessage(error)}` } };
  }
}

export function urlMatches(url: string | undefined, pattern: RegExp): boolean {
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
export function waitForTabLoad(
  tabs: TabLoadApi,
  tabId: number,
  trigger: () => Promise<unknown>,
  isLoaded: (tab: browser.tabs.Tab) => boolean,
  options: { timeoutMs: number; settleMs: number; requireLoading: boolean },
): Promise<TabLoadOutcome> {
  return new Promise<TabLoadOutcome>((resolve, reject) => {
    let done = false;
    let sawLoading = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      done = true;
      tabs.onUpdated.removeListener(onUpdated);
      tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
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
    const timer = setTimeout(() => finish("timeout"), options.timeoutMs);

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
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      },
    );
  });
}

/** Error text for a load wait that did not complete. */
export function tabLoadError(outcome: TabLoadOutcome, timeoutMs: number, currentUrl: string | undefined): string {
  return outcome === "removed"
    ? "The tab was closed before the page finished loading"
    : `The page did not finish loading within ${timeoutMs}ms` +
        ` (current URL: ${currentUrl ?? "unknown"}). The navigation may still complete;` +
        " check with fox_tabs or fox_wait (for 'url').";
}

/** A positive number from the command data, or the fallback. */
export function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * fox_wait_for_navigation: wait for the tab's next top-level navigation to
 * finish ("load" = webNavigation.onCompleted, "domcontentloaded" =
 * onDOMContentLoaded). With urlPattern, navigations to other URLs are
 * skipped. As on the headless backend (Playwright waitForNavigation), a
 * navigation that finished before the command arrived does not count.
 */
export async function waitForNavigation(
  tabId: number | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  const tab = await resolveTab(tabId);
  if (!tab) return noTargetTab();
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
      if (details.tabId !== targetId || details.frameId !== TOP_FRAME_ID) return;
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
  // The navigation finished; a tab closed right after it only loses the title.
  const now = await browser.tabs.get(targetId).catch(() => undefined);
  return { success: true, url, title: now?.title };
}

/**
 * fox_wait_for_url: wait until the tab's URL equals `url` (exact) or matches
 * `urlPattern` (regex) and the page has finished loading. Returns at once if
 * that is already the case. URL changes through the History API count too.
 */
export async function waitForUrl(
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
    !!u && (exact !== null ? u === exact : pattern?.test(u) === true);

  const tab = await resolveTab(tabId);
  if (!tab) return noTargetTab();
  const targetId = tab.id;
  const timeoutMs = positiveOr(data.timeout, TIMEOUTS.WAIT_FOR_URL);

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

export const TAB_LOAD_OPTIONS = {
  timeoutMs: TIMEOUTS.PAGE_LOAD,
  settleMs: TIMEOUTS.TAB_LOAD_SETTLE,
} as const;
