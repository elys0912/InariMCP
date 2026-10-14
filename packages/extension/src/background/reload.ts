// refresh / hard_refresh (L3).

import { errorMessage } from "../error-message";
import { resolveTab, noTargetTab } from "./tab-target";
import { waitForTabLoad, TAB_LOAD_OPTIONS, tabLoadError } from "./tab-wait";
import type { RefreshOptions, CommandResult } from "./types";

/** Reload the tab and wait for the load: the result of refresh with waitForLoad (the default). */
async function reloadAndWait(tab: browser.tabs.Tab, reload: () => Promise<unknown>, bypassCache: boolean): Promise<CommandResult> {
  const outcome = await waitForTabLoad(browser.tabs, tab.id, {
    ...TAB_LOAD_OPTIONS, trigger: reload, isLoaded: (t) => t.status === "complete", requireLoading: true,
  });
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
}

export async function refreshTab(
  tabId: number | undefined,
  options: RefreshOptions = {},
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    const bypassCache = options.bypassCache || false;
    const reload = (): Promise<unknown> => browser.tabs.reload(tab.id, { bypassCache });
    if (options.waitForLoad !== false) return await reloadAndWait(tab, reload, bypassCache);

    await reload();
    return { success: true, refreshed: true, tab: { id: tab.id, url: tab.url ?? "" }, bypassCache };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
