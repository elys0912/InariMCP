// Target tab resolution and messaging to the tab's content script (L1).

import { errorMessage } from "../error-message";
import { ABORT_REQUEST_TYPE } from "../content/constants";
import type { ContentRequest } from "../content/types";
import { TOP_FRAME_ID } from "./constants";
import type { CommandResult } from "./types";

/**
 * The tab a command acts on: the given tab, else the active tab of the
 * current window. Undefined when there is none (no window has focus, e.g.
 * all windows minimized); callers answer with noTargetTab().
 */
export async function resolveTab(
  tabId: number | undefined,
): Promise<browser.tabs.Tab | undefined> {
  if (tabId) return browser.tabs.get(tabId);
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tabs[0];
}

/** Failure result of a command that has no tab to act on. */
export function noTargetTab(): CommandResult {
  return { success: false, error: "No target tab" };
}

/**
 * Send a command to the tab's content script in one frame -- the top frame
 * (0) unless a caller names another. The content script runs in every frame
 * (all_frames), and tabs.sendMessage without a frameId goes to all of them
 * and takes the first answer, so any iframe (including a hostile one) could
 * answer or be the one that acts.
 *
 * Build `message` as `{ ...data, action }`: the action last, so that a
 * command's data cannot replace the action the background checked.
 */
export async function sendToContentScript(
  tabId: number | undefined,
  message: ContentRequest,
  frameId: number = TOP_FRAME_ID,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    const result = (await browser.tabs.sendMessage(tab.id, message, { frameId })) as Record<string, unknown>;
    return { success: true, ...result };
  } catch (error) {
    return contentScriptFailure(error);
  }
}

/**
 * The pause switch: tell the content script of `tabId` (its top frame, where
 * every command goes) to stop the commands it runs; each ends at its next
 * step (content/abort.ts). Best effort: a tab without a content script runs
 * none.
 */
export async function abortContentCommands(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: ABORT_REQUEST_TYPE }, { frameId: TOP_FRAME_ID });
  } catch {
    // No content script in the tab, or the tab is gone: nothing runs there
  }
}

/**
 * Failure result of a message to a content script: when no content script
 * answered, an explanation of why instead of Firefox's own error text.
 */
export function contentScriptFailure(error: unknown): CommandResult {
  const msg = errorMessage(error);
  return {
    success: false,
    error: NO_CONTENT_SCRIPT.test(msg) ? NO_CONTENT_SCRIPT_MESSAGE : msg,
  };
}

/** tabs.sendMessage error when the tab has no content script to answer. */
const NO_CONTENT_SCRIPT = /Receiving end does not exist/i;

const NO_CONTENT_SCRIPT_MESSAGE =
  "InariMCP cannot reach this page: Firefox does not let extensions into it " +
  "(JSON viewer, about: pages, addons.mozilla.org, other extensions' pages), " +
  "or it was opened before InariMCP was installed or updated (reload the tab). " +
  "Tab-level tools such as fox_screenshot and fox_tabs still work.";
