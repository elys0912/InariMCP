// Waits on the human: the captcha banner and cancel_human_wait (L4).

import { t } from "../i18n";
import { cancelApprovalByRequestId } from "./approvals";
import { resolveTab, sendToContentScript } from "./tab-target";
import type { CommandResult } from "./types";

/**
 * Tabs showing a captcha banner for a server command (requestId → tabId),
 * so that cancel_human_wait can withdraw it after the server stopped waiting.
 */
const humanWaits = new Map<string, number>();

/**
 * Run a banner-showing handler on a pinned tab and remember that tab under
 * the command's requestId while the handler waits for the human.
 */
export async function trackHumanWait(
  requestId: number | string | undefined,
  tabId: number | undefined,
  run: (tabId: number | undefined) => Promise<CommandResult>,
): Promise<CommandResult> {
  let pinned = tabId;
  try {
    pinned = (await resolveTab(tabId))?.id ?? tabId;
  } catch {
    // run() reports the missing tab itself
  }
  const key = requestId === undefined ? undefined : String(requestId);
  if (key !== undefined && pinned !== undefined) humanWaits.set(key, pinned);
  try {
    return await run(pinned);
  } finally {
    if (key !== undefined) humanWaits.delete(key);
  }
}

/**
 * The server gave up waiting on a command: withdraw its approval request,
 * or the captcha banner it showed.
 */
export async function cancelHumanWait(data: Record<string, unknown> = {}): Promise<CommandResult> {
  const target = data.requestId;
  if (typeof target !== "string" && typeof target !== "number") {
    return { success: true, cancelled: false };
  }
  const key = String(target);
  if (cancelApprovalByRequestId(key)) return { success: true, cancelled: true };
  const tabId = humanWaits.get(key);
  if (tabId === undefined) return { success: true, cancelled: false };
  return sendToContentScript(tabId, { action: "cancelHumanWait" });
}

export async function solveCaptcha(
  tabId: number | undefined,
  data: { detectOnly?: boolean } & Record<string, unknown> = {},
): Promise<CommandResult> {
  if (!data.detectOnly) {
    try {
      if (browser.notifications) {
        await browser.notifications.create({
          type: "basic",
          title: t("notifyCaptchaTitle"),
          message: t("notifyCaptchaMessage"),
          iconUrl: browser.runtime.getURL("icons/icon.svg"),
        });
      }
    } catch {
      // Notifications unavailable
    }
  }
  return sendToContentScript(tabId, { action: "solveCaptcha", ...data });
}
