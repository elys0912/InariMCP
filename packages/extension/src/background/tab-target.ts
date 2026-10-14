// Target tab resolution and messaging to the tab's content script (L1).

import { errorMessage } from "../error-message";
import { ABORT_REQUEST_TYPE } from "../content/constants";
import type { ContentRequest } from "../content/types";
import { TOP_FRAME_ID } from "./constants";
import { isPaused, pauseCount } from "./control-state";
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
 * Send a command to the tab's content script, in the top frame. The manifest
 * loads the content script there only (all_frames: false); the frameId is
 * given anyway, so that no other frame can answer or be the one that acts.
 *
 * Build `message` as `{ ...data, action }`: the action last, so that a
 * command's data cannot replace the action the background checked. A
 * command from the Native Host with `pauseCount` (dispatch.ts) is not sent
 * when agent actions were paused after it was let through.
 */
export async function sendToContentScript(
  tabId: number | undefined,
  message: ContentRequest,
): Promise<CommandResult> {
  try {
    const tab = await resolveTab(tabId);
    if (!tab) return noTargetTab();
    // The tab lookup waits on the browser: a pause may have come meanwhile.
    if (isSentBeforePause(message.pauseCount)) return { ...PAUSED_BEFORE_SENDING };
    const result = (await browser.tabs.sendMessage(tab.id, message, { frameId: TOP_FRAME_ID })) as Record<string, unknown>;
    return { success: true, ...result };
  } catch (error) {
    return contentScriptFailure(error);
  }
}

/** The answer of a command a pause outdated before it was sent (dispatch.ts has answered PAUSED already). */
const PAUSED_BEFORE_SENDING: CommandResult = {
  success: false,
  safetyDecision: "paused",
  error: "paused: the user paused agent actions before the command reached the page",
};

/** Whether a command let through at `count` pauses (a number: from the Native Host) is outdated by a pause. */
function isSentBeforePause(count: unknown): boolean {
  return typeof count === "number" && (isPaused() || count !== pauseCount());
}

/**
 * The pause switch: tell the content script of `tabId` (its top frame, where
 * every command goes) to stop the commands it runs; each ends at its next
 * step. The abort carries the pause count, so a command of an earlier count
 * that arrives after it is refused too (content/abort.ts). Best effort: a
 * tab without a content script runs none.
 */
export async function abortContentCommands(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(
      tabId,
      { type: ABORT_REQUEST_TYPE, pauseCount: pauseCount() },
      { frameId: TOP_FRAME_ID },
    );
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
