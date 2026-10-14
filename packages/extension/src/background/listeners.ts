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
  // connects (user-control.ts; control-state.ts holds the answer, and
  // native-connection.ts setConnectionAllowed opens no port without it).
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

const CONTROL_MESSAGE_TYPES: readonly unknown[] = Object.values(CONTROL_MESSAGE);

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
  if (CONTROL_MESSAGE_TYPES.includes(msg.type)) return answerControlMessage(msg, sender, sendResponse);
  if (msg.target === "background") return runPageCommand(msg, sender, sendResponse);
}

/**
 * Approval LIST / DECIDE. Only the toolbar popup may see or answer approval
 * requests: never a content script (or page JS), and for a decision not even
 * an extension page loaded in a tab.
 */
function answerApprovalMessage(msg: Record<string, unknown>, sender: MessageSender, sendResponse: SendResponse): void {
  if (!isExtensionPage(sender) || (msg.type === APPROVAL_MESSAGE.DECIDE && !isToolbarPopup(sender))) {
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
 * The answer to a control message (user-control.ts), or null when this
 * sender may not send it or it is malformed. Content scripts get nothing.
 * The consent is changed only from the consent page, the pause switch only
 * from the toolbar popup (not the popup page opened in a tab), like an
 * approval decision.
 */
function controlReply(msg: Record<string, unknown>, sender: MessageSender): Promise<ControlView> | null {
  switch (msg.type) {
    case CONTROL_MESSAGE.GET:
      return isExtensionPage(sender) ? Promise.resolve(controlView()) : null;
    case CONTROL_MESSAGE.SET_CONSENT:
      return isConsentPage(sender) && typeof msg.granted === "boolean" ? setConsent(msg.granted) : null;
    case CONTROL_MESSAGE.SET_PAUSED:
      return isToolbarPopup(sender) && typeof msg.paused === "boolean" ? setPaused(msg.paused) : null;
    default:
      return null;
  }
}

/** The consent and the pause switch. True when the answer is sent later. */
function answerControlMessage(msg: Record<string, unknown>, sender: MessageSender, sendResponse: SendResponse): boolean {
  const reply = controlReply(msg, sender);
  if (reply === null) {
    console.error("[InariMCP] Refused control message from", sender.url);
    sendResponse({ success: false, error: "Refused: not allowed from this page, or a malformed message" });
    return false;
  }

  reply.then(sendResponse, (error: unknown) => {
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
 * could otherwise call every handler without the containerScope and URL
 * rules the MCP Server attaches (Layer 0 bypass).
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

/** The toolbar popup itself, not the popup page opened in a tab. */
function isToolbarPopup(sender: MessageSender): boolean {
  return isExtensionPage(sender) && sender.tab === undefined;
}

/** The consent page (an extension page, never the web page of a tab). */
function isConsentPage(sender: MessageSender): boolean {
  return isExtensionPage(sender) && sender.url === browser.runtime.getURL(CONSENT_PAGE_PATH);
}
