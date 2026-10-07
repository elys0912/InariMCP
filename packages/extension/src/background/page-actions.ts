// Element and page tools: forwarded to the tab's content script, or run on
// the tab (getPageInfo, executeScript) (L3).

import type { ContentRequest } from "../content/types";
import { TOP_FRAME_ID } from "./constants";
import { sendToContentScript, resolveTab, noTargetTab, contentScriptFailure } from "./tab-target";
import type { CommandResult } from "./types";

export async function performClick(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { ...data, action: "click" });
}

export async function performType(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { ...data, action: "type" });
}

export async function performScroll(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { ...data, action: "scroll" });
}

export async function getPageInfo(
  tabId: number | undefined,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    const result = (await browser.tabs.sendMessage(
      tab.id,
      { action: "getPageInfo" } satisfies ContentRequest,
      { frameId: TOP_FRAME_ID },
    )) as Record<string, unknown>;
    return {
      success: true,
      tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
      ...result,
    };
  } catch (error) {
    // E-21: the same failure text as the tools sent through sendToContentScript.
    return contentScriptFailure(error);
  }
}

export async function getElements(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { ...data, action: "getElements" });
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
  return sendToContentScript(tabId, { ...data, action: "highlight" });
}

export async function waitForElement(
  tabId: number | undefined,
  data: Record<string, unknown> | undefined,
): Promise<CommandResult> {
  return sendToContentScript(tabId, { ...data, action: "waitForElement" });
}
