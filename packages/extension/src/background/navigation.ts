// navigate / new-tab navigate / back / forward (L3).

import { errorMessage } from "../error-message";
import { resolveTab, noTargetTab } from "./tab-target";
import { waitForTabLoad, TAB_LOAD_OPTIONS, tabLoadError } from "./tab-wait";
import { createNewTab } from "./tabs";
import type { CommandResult, ScopeFilter } from "./types";

export async function navigateTo(
  tabId: number | undefined,
  data: { url: string; waitForLoad?: boolean },
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    const navigate = (): Promise<unknown> => browser.tabs.update(tab.id, { url: data.url });
    if (data.waitForLoad === false) {
      await navigate();
      return { success: true, url: data.url, waited: false };
    }
    const outcome = await waitForTabLoad(browser.tabs, tab.id, {
      ...TAB_LOAD_OPTIONS, trigger: navigate, isLoaded: (t) => t.status === "complete", requireLoading: true,
    });
    // Report the URL actually loaded (after redirects), so the server's guard
    // tracks the real page; fall back to the requested URL.
    const updated = await browser.tabs.get(tab.id).catch(() => undefined);
    if (outcome !== "complete") {
      return { success: false, error: tabLoadError(outcome, TAB_LOAD_OPTIONS.timeoutMs, updated?.url) };
    }
    return { success: true, url: updated?.url || data.url };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

export async function navigateNewTab(
  data: { url: string; waitForLoad?: boolean },
  scope: ScopeFilter | null,
): Promise<CommandResult> {
  const created = await createNewTab({ url: data.url, active: true }, scope);
  const tabId = (created.tab as { id?: number } | undefined)?.id;
  if (!created.success || tabId === undefined) return created;
  try {
    if (data.waitForLoad !== false) {
      // A tab from tabs.create({ url }) can first report status "complete"
      // while still on the initial about:blank, before the requested URL
      // starts loading (seen on the first new tab after Firefox starts).
      // Treat about:blank as loaded only when it is what was asked for.
      const wantsBlank = data.url === "about:blank";
      const outcome = await waitForTabLoad(browser.tabs, tabId, {
        ...TAB_LOAD_OPTIONS,
        trigger: () => Promise.resolve(),
        isLoaded: (tab) => tab.status === "complete" && (wantsBlank || tab.url !== "about:blank"),
        requireLoading: false,
      });
      if (outcome !== "complete") {
        const now = await browser.tabs.get(tabId).catch(() => undefined);
        return { success: false, error: tabLoadError(outcome, TAB_LOAD_OPTIONS.timeoutMs, now?.url), tabId };
      }
    }
    // Same shape as navigateTo (url after redirects), plus the new tab's id.
    const updated = await browser.tabs.get(tabId);
    return { success: true, url: updated.url || data.url, tabId };
  } catch (error) {
    return { success: false, error: errorMessage(error), tabId };
  }
}

export async function navigateHistory(
  tabId: number | undefined,
  direction: "back" | "forward",
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    const go = (): Promise<unknown> =>
      direction === "back" ? browser.tabs.goBack(tab.id) : browser.tabs.goForward(tab.id);
    // Same load wait as navigate: a history entry of the same document
    // (pushState / hash) or a page restored without loading settles after
    // TAB_LOAD_SETTLE with the tab's current state.
    const outcome = await waitForTabLoad(browser.tabs, tab.id, {
      ...TAB_LOAD_OPTIONS, trigger: go, isLoaded: (t) => t.status === "complete", requireLoading: true,
    });
    const updated = await browser.tabs.get(tab.id).catch(() => undefined);
    if (outcome !== "complete") {
      return { success: false, error: tabLoadError(outcome, TAB_LOAD_OPTIONS.timeoutMs, updated?.url) };
    }
    return { success: true, url: updated?.url, title: updated?.title };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
