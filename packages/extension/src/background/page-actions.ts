// Page tools that do more than forward the command to the content script
// (L3): getPageInfo adds the tab, executeScript runs on the tab. The plain
// forwards are toContentScript() rows of the action table.

import { errorMessage } from "../error-message";
import type { ContentRequest } from "../content/types";
import { TOP_FRAME_ID } from "./constants";
import { resolveTab, noTargetTab, contentScriptFailure } from "./tab-target";
import type { CommandResult } from "./types";

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
    return { success: false, error: errorMessage(error) };
  }
}
