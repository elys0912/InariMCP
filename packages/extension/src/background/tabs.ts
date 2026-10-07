// Tab management tools and find_text (L3).

import { errorMessage } from "../error-message";
import type { ContentRequest } from "../content/types";
import { DEFAULTS, TOP_FRAME_ID } from "./constants";
import { isTabInScope, ensureScopeContainer } from "./container-scope";
import { noTargetTab } from "./tab-target";
import { urlPatternArg, urlMatches } from "./tab-wait";
import type { GetAllTabsOptions, ScopeFilter, CommandResult, FindTabsOptions } from "./types";

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
    // A positive integer, else the default (0 or a negative value would cut
    // the list from the end).
    const limit =
      typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit > 0
        ? options.limit
        : DEFAULTS.TABS_LIMIT;

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
    return { success: false, error: errorMessage(error) };
  }
}

export async function getTabInfo(tabId: number): Promise<CommandResult> {
  try {
    const tab = await browser.tabs.get(tabId);
    const win = await browser.windows.get(tab.windowId);

    let pageInfo: unknown = null;
    try {
      pageInfo = await browser.tabs.sendMessage(
        tabId,
        { action: "getPageInfo" } satisfies ContentRequest,
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
    return { success: false, error: errorMessage(error) };
  }
}

export async function findTabs(
  options: FindTabsOptions,
  scope: ScopeFilter | null = null,
): Promise<CommandResult> {
  try {
    const tabs = await browser.tabs.query({});
    let filtered = tabs.filter((t) => isTabInScope(t, scope));

    const prefix = options.url;
    if (prefix) {
      filtered = filtered.filter((t) => t.url?.startsWith(prefix));
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
