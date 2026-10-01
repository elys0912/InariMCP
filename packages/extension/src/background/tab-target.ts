// Target tab resolution and messaging to the tab's content script (L1).

import { TOP_FRAME_ID } from "./constants";
import type { CommandResult } from "./types";

export async function resolveTab(
  tabId: number | undefined,
): Promise<browser.tabs.Tab> {
  if (tabId) return browser.tabs.get(tabId);
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0];
}

/**
 * Send a command to the tab's content script in one frame -- the top frame
 * (0) unless a caller names another. The content script runs in every frame
 * (all_frames), and tabs.sendMessage without a frameId goes to all of them
 * and takes the first answer, so any iframe (including a hostile one) could
 * answer or be the one that acts.
 */
export async function sendToContentScript(
  tabId: number | undefined,
  message: Record<string, unknown>,
  frameId: number = TOP_FRAME_ID,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return { success: false, error: "No target tab" };
    const result = (await browser.tabs.sendMessage(tab.id, message, { frameId })) as Record<string, unknown>;
    return { success: true, ...result };
  } catch (error) {
    const msg = (error as Error).message;
    return {
      success: false,
      error: NO_CONTENT_SCRIPT.test(msg) ? NO_CONTENT_SCRIPT_MESSAGE : msg,
    };
  }
}

/** tabs.sendMessage error when the tab has no content script to answer. */
const NO_CONTENT_SCRIPT = /Receiving end does not exist/i;

const NO_CONTENT_SCRIPT_MESSAGE =
  "KitsuneMCP cannot reach this page: Firefox does not let extensions into it " +
  "(JSON viewer, about: pages, addons.mozilla.org, other extensions' pages), " +
  "or it was opened before KitsuneMCP was installed or updated (reload the tab). " +
  "Tab-level tools such as fox_screenshot and fox_get_tabs still work.";
