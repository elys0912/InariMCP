// refresh / reload_all / reload_by_url (L3).

import { findUrlRule, type CompiledUrlRule } from "../url-rule";
import { isTabInScope } from "./container-scope";
import { resolveTab } from "./tab-target";
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
import { violatesUrlLists, NO_URL_LISTS } from "./url-policy";

export async function refreshTab(
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
export async function reloadMatchingTabs(
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

export async function reloadAllTabs(
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

export async function reloadTabsByUrl(
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
