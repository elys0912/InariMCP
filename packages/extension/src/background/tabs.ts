// Tab management tools and find_text (L3).

import { errorMessage } from "../error-message";
import { DEFAULTS, TOP_FRAME_ID } from "./constants";
import { isTabInScope, ensureScopeContainer } from "./container-scope";
import { contentScriptFailure, noTargetTab } from "./tab-target";
import { urlPatternArg, urlMatches } from "./tab-wait";
import type { GetAllTabsOptions, ScopeFilter, CommandResult } from "./types";

/**
 * A positive integer limit, else the default (0 or a negative value would
 * cut the list from the end).
 */
function tabsLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : DEFAULTS.TABS_LIMIT;
}

/**
 * The number of windows to report. Under container scope, only windows
 * holding an in-scope tab count, so the result says nothing about windows
 * outside the scope.
 */
async function windowCountOf(scope: ScopeFilter | null, windows: browser.windows.Window[]): Promise<number> {
  if (!scope) return windows.length;
  const inScope = (await browser.tabs.query({})).filter((t) => isTabInScope(t, scope));
  return new Set(inScope.map((t) => t.windowId)).size;
}

/** What getAllTabs reports of one tab. */
function tabEntry(
  t: browser.tabs.Tab,
  options: { includeFavicon: boolean; currentWindowOnly: boolean },
  windowMap: Map<number, browser.windows.Window>,
): Record<string, unknown> {
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
  if (options.includeFavicon) {
    base.favIconUrl = t.favIconUrl;
  }
  if (!options.currentWindowOnly) {
    base.windowFocused = windowMap.get(t.windowId)?.focused || false;
  }
  return base;
}

export async function getAllTabs(
  options: GetAllTabsOptions = {},
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const currentWindowOnly = options.currentWindowOnly !== false;
    const includeFavicon = options.includeFavicon === true;
    const patternArg = urlPatternArg(options.urlPattern);
    if (!patternArg.ok) return patternArg.result;
    const urlPattern = patternArg.pattern;
    const limit = tabsLimit(options.limit);

    const queryOpts: browser.tabs.QueryInfo = currentWindowOnly
      ? { currentWindow: true }
      : {};
    let tabs = (await browser.tabs.query(queryOpts)).filter((t) => isTabInScope(t, scope));
    const windows = await browser.windows.getAll();
    const windowMap = new Map(windows.map((w) => [w.id, w]));
    const windowCount = await windowCountOf(scope, windows);

    if (urlPattern) {
      tabs = tabs.filter((t) => urlMatches(t.url, urlPattern));
    }
    const totalMatched = tabs.length;

    const truncated = tabs.length > limit;
    const pageTabs = tabs.slice(0, limit);

    return {
      success: true,
      tabs: pageTabs.map((t) => tabEntry(t, { includeFavicon, currentWindowOnly }, windowMap)),
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
    return { success: false, error: errorMessage(error) };
  }
}

export async function createNewTab(
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
    return { success: false, error: errorMessage(error) };
  }
}

export async function closeTab(tabId: number): Promise<CommandResult> {
  try {
    await browser.tabs.remove(tabId);
    // `closed`: the MCP Server's guard forgets this tab's last URL.
    return { success: true, closed: tabId };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export async function focusTab(tabId: number): Promise<CommandResult> {
  try {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

// 0.2.0: fox_tab action "window".
const WINDOW_STATES = ["maximized", "normal", "fullscreen"] as const;
type WindowState = (typeof WINDOW_STATES)[number];

function isWindowState(value: unknown): value is WindowState {
  return typeof value === "string" && (WINDOW_STATES as readonly string[]).includes(value);
}

/**
 * set_window_state (0.2.0): change the state of the target tab's window
 * (resolved once by handleCommand), e.g. maximize it before a screenshot.
 * Reports the window as Firefox returns it after the change.
 */
export async function setWindowState(
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  const state = data?.state ?? "maximized";
  if (!isWindowState(state)) {
    return { success: false, error: `state must be one of: ${WINDOW_STATES.join(", ")}` };
  }
  if (!target) return noTargetTab();
  try {
    const win = await browser.windows.update(target.windowId, { state });
    return { success: true, windowId: win.id, state: win.state, width: win.width, height: win.height };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

/**
 * find_text refuses a tab whose page shows a masked field
 * (content/inspect.ts hasMaskedFields): Firefox's find may match the text
 * in a form field, and the count would tell the field's value one guess at
 * a time. Refused as well when the content script cannot be asked (the
 * check is not made, so the search is not either). Null: no such field.
 */
async function maskedFieldsRefusal(tabId: number): Promise<CommandResult | null> {
  try {
    const answer = (await browser.tabs.sendMessage(tabId, { action: "hasMaskedFields" }, { frameId: TOP_FRAME_ID })) as
      | { hasMaskedFields?: unknown }
      | undefined;
    if (answer?.hasMaskedFields === false) return null;
    return {
      success: false,
      error:
        "find_text refused: the page has a password, one-time-code or payment card field, whose value " +
        "a search could guess one character at a time; read the page with fox_read instead",
    };
  } catch (error) {
    const failure = contentScriptFailure(error);
    return { ...failure, error: `find_text refused: the page could not be checked for masked fields. ${String(failure.error)}` };
  }
}

/** find_text: browser.find on the target tab (resolved once by handleCommand). */
export async function findText(
  target: browser.tabs.Tab | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  const d = data ?? {};
  const findQuery = d.query;
  if (typeof findQuery !== "string" || findQuery === "") {
    return { success: false, error: "query is required (a non-empty string)" };
  }
  const caseSensitive = d.caseSensitive === true;
  const entireWord = d.entireWord === true;
  const includeRectData = d.includeRectData === true;

  if (!target) return noTargetTab();
  const refusal = await maskedFieldsRefusal(target.id);
  if (refusal) return refusal;
  const findResult = await browser.find.find(findQuery, {
    tabId: target.id,
    caseSensitive,
    entireWord,
    includeRangeData: true,
    includeRectData,
  });

  return {
    success: true,
    count: findResult.count,
    rangeData: findResult.rangeData,
    rectData: includeRectData ? findResult.rectData : undefined,
  };
}
