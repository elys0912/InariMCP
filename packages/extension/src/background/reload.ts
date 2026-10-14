// refresh / reload_all / reload_by_url (L3).

import { errorMessage } from "../error-message";
import { isTabInScope } from "./container-scope";
import { resolveTab, noTargetTab } from "./tab-target";
import {
  waitForTabLoad,
  TAB_LOAD_OPTIONS,
  tabLoadError,
  urlPatternArg,
  shouldSkipTab,
  urlMatches,
} from "./tab-wait";
import type {
  RefreshOptions,
  CommandResult,
  ScopeFilter,
  UrlLists,
  ReloadAllOptions,
  ReloadByUrlOptions,
} from "./types";
import { violatesUrlLists, isApprovedTab, NO_URL_LISTS } from "./url-policy";

export async function refreshTab(
  tabId: number | undefined,
  options: RefreshOptions = {},
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
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
    return { success: false, error: errorMessage(error) };
  }
}

/**
 * Reload every tab `selects`, except tabs outside the container scope, tabs
 * on a blocked / not allowlisted site and tabs on any site but the one a
 * human approved this call for (`approvedHost`; reloading is an acting
 * command, url-policy.ts). Only the counts of excluded tabs are reported,
 * both always, as for screenshot all_tabs.
 * The reloads are started together; a tab whose reload fails (e.g. closed
 * meanwhile) is reported with `reloaded: false` and its error, and does not
 * stop the others.
 */
export async function reloadMatchingTabs(
  selects: (tab: browser.tabs.Tab) => boolean,
  bypassCache: boolean,
  scope: ScopeFilter | null,
  approvedHost: string | undefined,
  lists: UrlLists,
): Promise<CommandResult> {
  const tabs = await browser.tabs.query({});
  const targets: browser.tabs.Tab[] = [];
  let excludedUnapproved = 0;
  let excludedBlocked = 0;

  for (const tab of tabs) {
    if (!isTabInScope(tab, scope) || !selects(tab)) continue;
    if (violatesUrlLists(tab.url, lists) !== null) {
      excludedBlocked++;
      continue;
    }
    if (!isApprovedTab(tab, approvedHost)) {
      excludedUnapproved++;
      continue;
    }
    targets.push(tab);
  }

  // Each tab's reload settles into its own result (none rejects), so one
  // failure does not stop the others; a reload that throws at once counts
  // as that tab's failure too.
  const results: { id: number; url: string; reloaded: boolean; error?: string }[] = await Promise.all(
    targets.map(async (tab) => {
      try {
        await browser.tabs.reload(tab.id, { bypassCache });
        return { id: tab.id, url: tab.url ?? "", reloaded: true };
      } catch (reason) {
        return {
          id: tab.id,
          url: tab.url ?? "",
          reloaded: false,
          error: errorMessage(reason),
        };
      }
    }),
  );
  const reloadedCount = results.filter((r) => r.reloaded).length;
  const failedCount = results.length - reloadedCount;

  return {
    // Fails only when every reload that was tried failed.
    success: failedCount === 0 || reloadedCount > 0,
    ...(failedCount > 0 && reloadedCount === 0 ? { error: `No tab could be reloaded (${failedCount} failed)` } : {}),
    reloadedCount,
    ...(failedCount > 0 ? { failedCount } : {}),
    tabs: results,
    bypassCache,
    // Both counts always (0 included); the reasons only when a tab was excluded.
    excludedUnapproved,
    excludedBlocked,
    ...(excludedBlocked > 0
      ? {
        excludedBlockedReason:
          "Tabs on sites refused by blocked_url_patterns / allowed_url_patterns in safety.json were not reloaded.",
      }
      : {}),
    ...(excludedUnapproved > 0
      ? {
        excludedReason: "Tabs on other sites than the one a human approved for this call were not reloaded.",
      }
      : {}),
  };
}

export async function reloadAllTabs(
  options: ReloadAllOptions = {},
  scope: ScopeFilter | null = null,
  approvedHost: string | undefined = undefined,
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
      approvedHost,
      lists,
    );
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export async function reloadTabsByUrl(
  options: ReloadByUrlOptions,
  scope: ScopeFilter | null = null,
  approvedHost: string | undefined = undefined,
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
      approvedHost,
      lists,
    );
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
