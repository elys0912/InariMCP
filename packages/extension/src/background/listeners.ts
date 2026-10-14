// Runtime / notification listeners (L5). Registered once by background.ts
// (registerListeners). Also opens the consent page on the first install.

import { errorMessage } from "../error-message";
import { APPROVAL_MESSAGE } from "../approval";
import { CONSENT_PAGE_PATH, CONTROL_MESSAGE, type ControlView } from "../user-control";
import { listApprovals, decideApproval, APPROVAL_NOTIFICATION_PREFIX } from "./approvals";
import { controlView, setConsent, setPaused } from "./control-state";
import { handleCommand } from "./dispatch";
import { parseNativeMessage } from "./native-connection";

type MessageSender = browser.runtime.MessageSender;
type SendResponse = (response: unknown) => void;

export function registerListeners(): void {
  browser.runtime.onMessage.addListener(onRuntimeMessage);

  // First install only (not updates): ask for consent before anything
  // connects (user-control.ts).
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") return;
    openConsentPage().catch((error: unknown) => {
      console.error("[InariMCP] Could not open the consent page:", errorMessage(error));
    });
  });

  // Clicking an approval notification opens the toolbar popup where it is
  // answered (best effort: Firefox may refuse openPopup outside a user action).
  browser.notifications?.onClicked?.addListener((notificationId) => {
    if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return;
    browser.browserAction.openPopup?.()?.catch(() => {});
  });

  // Block external messages: no other extension may send commands (prevents
  // command injection through runtime.sendMessage from another extension)
  browser.runtime.onMessageExternal.addListener(
    (_message: unknown, sender: MessageSender, sendResponse: SendResponse): boolean => {
      console.error("[InariMCP] Refused external message from", sender?.id);
      sendResponse({ success: false, error: "External messages are not accepted" });
      return false;
    },
  );
}

/**
 * runtime.onMessage: messages of the popup and the content scripts, by type.
 * True when the answer is sent later (sendResponse after an await).
 */
function onRuntimeMessage(message: unknown, sender: MessageSender, sendResponse: SendResponse): boolean | void {
  // Only objects are messages of ours (null, an array or a primitive is ignored).
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const msg: Record<string, unknown> = { ...message };
  if (msg.type === APPROVAL_MESSAGE.LIST || msg.type === APPROVAL_MESSAGE.DECIDE) {
    answerApprovalMessage(msg, sender, sendResponse);
    return;
  }
  if (msg.type === CONTROL_MESSAGE.GET || msg.type === CONTROL_MESSAGE.SET_CONSENT || msg.type === CONTROL_MESSAGE.SET_PAUSED) {
    return answerControlMessage(msg, sender, sendResponse);
  }
  if (msg.target === "background") return runPageCommand(msg, sender, sendResponse);
}

/**
 * Approval LIST / DECIDE. Only the toolbar popup may see or answer approval
 * requests: never a content script (or page JS), and for a
 * decision not even an extension page loaded in a tab.
 */
function answerApprovalMessage(msg: Record<string, unknown>, sender: MessageSender, sendResponse: SendResponse): void {
  if (!isExtensionPage(sender) || (msg.type === APPROVAL_MESSAGE.DECIDE && sender.tab)) {
    console.error("[InariMCP] Refused approval message from", sender.url);
    sendResponse({ success: false, error: "Approval requests are answered in the InariMCP toolbar popup" });
    return;
  }
  sendResponse(
    msg.type === APPROVAL_MESSAGE.LIST
      ? { success: true, approvals: listApprovals() }
      : decideApproval(msg.id, msg.approved),
  );
}

/**
 * The consent and the pause switch (user-control.ts). Content scripts get
 * nothing. The consent is answered only from the consent page, the pause
 * switch only from the toolbar popup (not the popup page opened in a tab),
 * like an approval decision. True when the answer is sent later.
 */
function answerControlMessage(msg: Record<string, unknown>, sender: MessageSender, sendResponse: SendResponse): boolean {
  const fromConsentPage = isExtensionPage(sender) && sender.url === browser.runtime.getURL(CONSENT_PAGE_PATH);
  const fromToolbarPopup = isExtensionPage(sender) && sender.tab === undefined;
  let change: Promise<ControlView> | null;
  if (msg.type === CONTROL_MESSAGE.GET) {
    change = isExtensionPage(sender) ? Promise.resolve(controlView()) : null;
  } else if (msg.type === CONTROL_MESSAGE.SET_CONSENT) {
    change = fromConsentPage && typeof msg.granted === "boolean" ? setConsent(msg.granted) : null;
  } else {
    change = fromToolbarPopup && typeof msg.paused === "boolean" ? setPaused(msg.paused) : null;
  }
  if (change === null) {
    console.error("[InariMCP] Refused control message from", sender.url);
    sendResponse({ success: false, error: "Refused: not allowed from this page, or a malformed message" });
    return false;
  }

  change.then(sendResponse, (error: unknown) => {
    sendResponse({ success: false, error: errorMessage(error) });
  });
  return true;
}

/** A tab with the consent page. */
function openConsentPage(): Promise<browser.tabs.Tab> {
  return browser.tabs.create({ url: browser.runtime.getURL(CONSENT_PAGE_PATH) });
}

/**
 * A command for the dispatcher (`target: "background"`). Only the
 * Extension's own pages (the popup) may drive it directly. Content scripts
 * could otherwise call every handler without the containerScope / protectedUrlPatterns the MCP Server
 * attaches (Layer 0 bypass).
 */
function runPageCommand(msg: Record<string, unknown>, sender: MessageSender, sendResponse: SendResponse): boolean {
  if (!isExtensionPage(sender)) {
    console.error("[InariMCP] Refused background command from", sender.url);
    sendResponse({ success: false, error: "Background commands are only accepted from extension pages" });
    return false;
  }
  const command = parseNativeMessage({ ...msg, tabId: sender.tab?.id });
  if (command === null) {
    sendResponse({ success: false, error: "Malformed background command" });
    return false;
  }
  handleCommand(command, "page").then(sendResponse, (error: unknown) => {
    // handleCommand answers its own failures; this keeps the popup from
    // waiting forever should it ever throw.
    sendResponse({ success: false, error: errorMessage(error) });
  });
  return true;
}

/**
 * True for a message from one of this Extension's own pages (popup, or the
 * popup page opened in a tab). Content scripts report the web page's URL.
 */
function isExtensionPage(sender: MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(browser.runtime.getURL("/"))
  );
}
