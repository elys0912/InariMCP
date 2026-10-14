// Screenshots: single tab (visible / full page) and all tabs (L3).

import { errorMessage } from "../error-message";
import type { ContentRequest } from "../content/types";
import type { CompiledUrlRule } from "../url-rule";
import { DEFAULTS, TIMEOUTS, TOP_FRAME_ID } from "./constants";
import { isTabInScope } from "./container-scope";
import { noTargetTab, resolveTab } from "./tab-target";
import { urlPatternArg, shouldSkipTab, urlMatches, positiveOr } from "./tab-wait";
import type { ScreenshotOptions, CommandResult, ScopeFilter, UrlLists } from "./types";
import { NO_URL_LISTS, isReadConfirmTab, violatesUrlLists } from "./url-policy";

const NO_IMAGE_NOTE =
  "saveToFile is false: no image was captured. InariMCP returns screenshots only " +
  "as saved files (resource_link), never inline.";

export async function takeScreenshot(
  tabId: number | undefined,
  options: ScreenshotOptions = {},
): Promise<CommandResult> {
  try {
    const targetTab = await resolveTab(tabId);
    if (!targetTab) return noTargetTab();

    // saveToFile false: images reach the MCP client only as files the
    // Native Host saves (never as base64), so nothing is captured.
    if (options.saveToFile === false) {
      return {
        success: true,
        type: options.fullPage ? "fullPage" : "visible",
        imageSaved: false,
        note: NO_IMAGE_NOTE,
        tab: { id: targetTab.id, url: targetTab.url, title: targetTab.title },
      };
    }

    // A discarded tab has no page to render until it is activated again;
    // say so instead of switching tabs behind the user's back.
    if (targetTab.discarded) {
      return {
        success: false,
        error:
          `Tab ${targetTab.id} is discarded (unloaded) and cannot be captured; ` +
          "switch to it first (fox_tab with action 'switch').",
      };
    }

    // captureTab(tabId), not captureVisibleTab(windowId): the latter takes
    // whatever tab is visible in that window. captureTab renders the given
    // tab even when it is in the background, so the active tab is never
    // changed (no focus is taken from the user).
    const dataUrl = await browser.tabs.captureTab(targetTab.id, {
      format: options.format || DEFAULTS.SCREENSHOT_FORMAT,
      quality: options.quality || DEFAULTS.SCREENSHOT_QUALITY,
    });

    if (options.fullPage) {
      return await captureFullPageImage(targetTab, dataUrl, options);
    }

    return {
      success: true,
      imageData: dataUrl,
      type: "visible",
      tab: {
        id: targetTab.id,
        url: targetTab.url,
        title: targetTab.title,
      },
    };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

/**
 * Full-page capture. The content script only reports the page dimensions
 * ("captureFullPage"), so the image itself is taken with captureTab's `rect`
 * option. If that fails (page too large for a single canvas, content script
 * unavailable), the visible-area capture is
 * returned instead and `fullPageCaptured` is false.
 */
async function captureFullPageImage(
  targetTab: browser.tabs.Tab,
  visibleDataUrl: string,
  options: ScreenshotOptions,
): Promise<CommandResult> {
  const tabInfo = {
    id: targetTab.id,
    url: targetTab.url,
    title: targetTab.title,
  };
  let dimensions: Record<string, unknown> | null = null;
  try {
    dimensions = (await browser.tabs.sendMessage(
      targetTab.id,
      { action: "captureFullPage", format: options.format || DEFAULTS.SCREENSHOT_FORMAT } satisfies ContentRequest,
      { frameId: TOP_FRAME_ID },
    )) as Record<string, unknown>;
    const width = dimensions.scrollWidth;
    const height = dimensions.scrollHeight;
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      const fullDataUrl = await browser.tabs.captureTab(targetTab.id, {
        format: options.format || DEFAULTS.SCREENSHOT_FORMAT,
        quality: options.quality || DEFAULTS.SCREENSHOT_QUALITY,
        rect: { x: 0, y: 0, width, height },
      });
      return {
        success: true,
        imageData: fullDataUrl,
        type: "fullPage",
        fullPageCaptured: true,
        pageDimensions: dimensions,
        tab: tabInfo,
      };
    }
  } catch (error) {
    console.warn("[InariMCP] Full-page capture failed, using visible area:", error);
  }
  return {
    success: true,
    imageData: visibleDataUrl,
    type: "fullPage",
    fullPageCaptured: false,
    pageDimensions: dimensions,
    tab: tabInfo,
  };
}

export async function screenshotAllTabs(
  options: ScreenshotOptions = {},
  scope: ScopeFilter | null = null,
  readRules: CompiledUrlRule[] = [],
  lists: UrlLists = NO_URL_LISTS,
): Promise<CommandResult> {
  try {
    const patternArg = urlPatternArg(options.urlPattern);
    if (!patternArg.ok) return patternArg.result;
    const urlPattern = patternArg.pattern;
    const tabs = await browser.tabs.query({});

    let targetTabs = tabs.filter((t) => !shouldSkipTab(t.url) && isTabInScope(t, scope));

    if (urlPattern) {
      targetTabs = targetTabs.filter((t) => urlMatches(t.url, urlPattern));
    }

    // Tabs on blocked / not allowlisted sites, then tabs on confirm_read_sites
    // sites are excluded. Only the counts are reported -- never the URL or
    // title of excluded tabs. Both counts are always reported (0 included);
    // the reasons only when a tab was excluded.
    const beforeLists = targetTabs.length;
    targetTabs = targetTabs.filter((t) => violatesUrlLists(t.url, lists) === null);
    const excludedBlocked = beforeLists - targetTabs.length;
    const beforeReadSites = targetTabs.length;
    targetTabs = targetTabs.filter((t) => !isReadConfirmTab(t, readRules));
    const excludedReadSites = beforeReadSites - targetTabs.length;
    const excluded = {
      excludedReadSites,
      excludedBlocked,
      ...(excludedBlocked > 0
        ? {
          excludedBlockedReason:
            "Tabs on sites refused by blocked_url_patterns / allowed_url_patterns in safety.json were not captured.",
        }
        : {}),
      ...(excludedReadSites > 0
        ? {
          excludedReason:
            "Tabs on sites of confirm_read_sites in safety.json were not captured " +
            "(capture each of them with a single-tab screenshot, which asks the human).",
        }
        : {}),
    };

    if (options.saveToFile === false) {
      return {
        success: true,
        screenshots: targetTabs.map((t) => ({
          tabId: t.id, url: t.url ?? "", title: t.title ?? "", imageSaved: false,
        })),
        count: 0,
        failed: 0,
        note: NO_IMAGE_NOTE,
        ...excluded,
      };
    }

    const budgetMs = positiveOr(options.timeout, TIMEOUTS.ALL_TABS_BUDGET);
    const results = await captureTabsWithin(
      targetTabs,
      (tab) => browser.tabs.captureTab(tab.id, {
        format: options.format || DEFAULTS.SCREENSHOT_FORMAT,
        quality: options.quality || DEFAULTS.SCREENSHOT_QUALITY,
      }),
      { perTabMs: TIMEOUTS.CAPTURE_TAB, budgetMs, keepData: options.includeData === true },
    );
    const count = results.filter((r) => r.success).length;
    const failed = results.length - count;

    return {
      // Nothing captured although there were tabs to capture: a failure.
      success: results.length === 0 || count > 0,
      ...(results.length > 0 && count === 0
        ? { error: `No tab could be captured (${failed} failed; see screenshots[].error)` }
        : {}),
      screenshots: results,
      count,
      failed,
      ...excluded,
    };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}

/**
 * Capture `tabs` one after another within `budgetMs` overall, giving each
 * capture at most `perTabMs` (or what is left of the budget). Tabs reached
 * after the budget is used up are reported as skipped, not captured. Each
 * entry has success / tabId / url, plus imageData (keepData) or error.
 */
export async function captureTabsWithin(
  tabs: browser.tabs.Tab[],
  capture: (tab: browser.tabs.Tab) => Promise<string>,
  options: { perTabMs: number; budgetMs: number; keepData: boolean },
): Promise<Record<string, unknown>[]> {
  const started = Date.now();
  const results: Record<string, unknown>[] = [];
  for (const tab of tabs) {
    const base = { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
    const left = options.budgetMs - (Date.now() - started);
    if (left <= 0) {
      results.push({
        ...base,
        success: false,
        skipped: true,
        error: `Skipped: the ${options.budgetMs}ms budget of this capture was used up`,
      });
      continue;
    }
    const limit = Math.min(options.perTabMs, left);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const dataUrl = await Promise.race([
        capture(tab),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`captureTab timed out after ${limit}ms`)), limit);
        }),
      ]);
      results.push({
        ...base,
        success: true,
        ...(options.keepData ? { imageData: dataUrl } : {}),
        timestamp: Date.now(),
      });
    } catch (e) {
      results.push({ ...base, success: false, error: errorMessage(e) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return results;
}
