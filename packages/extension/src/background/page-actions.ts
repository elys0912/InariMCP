// Element and page tools: forwarded to the tab's content script, or run on
// the tab (getPageInfo, executeScript) (L3).

import { TOP_FRAME_ID } from "./constants";
import { sendToContentScript, resolveTab, noTargetTab } from "./tab-target";
import type { CommandResult } from "./types";

export async function performClick(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "click", ...data });
}

export async function performType(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "type", ...data });
}

export async function performScroll(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "scroll", ...data });
}

export async function getPageInfo(
  tabId: number | undefined,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    const result = (await browser.tabs.sendMessage(
      tab.id,
      { action: "getPageInfo" },
      { frameId: TOP_FRAME_ID },
    )) as Record<string, unknown>;
    return {
      success: true,
      tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
      ...result,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

export async function getElements(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "getElements", ...data });
}

export async function executeScript(
  tabId: number | undefined,
  data: { script: string },
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    const result = await browser.tabs.executeScript(tab.id, {
      code: data.script,
    });
    return { success: true, result: result[0] };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

export async function highlightElement(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "highlight", ...data });
}

export async function waitForElement(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { action: "waitForElement", ...data });
}
