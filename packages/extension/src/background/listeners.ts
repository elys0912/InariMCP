// Runtime / tab / navigation / notification listeners (L5). Registered once
// by background.ts (registerListeners). Also opens the consent page on the
// first install.

import { errorMessage } from "../error-message";
import { APPROVAL_MESSAGE } from "../approval";
import { CONSENT_PAGE_PATH, CONTROL_MESSAGE, type ControlView } from "../user-control";
import { listApprovals, decideApproval, APPROVAL_NOTIFICATION_PREFIX } from "./approvals";
import { LOG_RECORD_MESSAGE, TOP_FRAME_ID, LOGGING_STATE_QUERY } from "./constants";
import { controlView, setConsent, setPaused } from "./control-state";
import { handleCommand } from "./dispatch";
import {
  isLoggingTab,
  acceptLogRecords,
  loggingStateFor,
  wantsEarlyInjection,
  forgetTab,
  type LogRecordRefusal,
} from "./logging";
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

  // Logging tabs: inject the content script at document_start as soon as a new
  // document commits, so the page hooks catch the page's first scripts (the
  // manifest content script only runs at document_end). Best effort: the
  // injection is asynchronous and may still land after some early scripts.
  // The injected copy confirms the state with the background before keeping
  // anything (resumeLoggingFromBackground); the later manifest copy is a no-op
  // thanks to the __fox_injected guard (same sandbox).
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== TOP_FRAME_ID) return;
    if (!wantsEarlyInjection(details.tabId, details.url)) return;
    console.log(`[InariMCP] Early logging injection requested (tab ${details.tabId})`);
    // dist/content.js is self-contained (url-rule.ts is bundled into it).
    browser.tabs
      .executeScript(details.tabId, { file: "/dist/content.js", runAt: "document_start", frameId: TOP_FRAME_ID })
      .then(() => {
        console.log(`[InariMCP] Early logging injection done (tab ${details.tabId})`);
      })
      .catch((error: unknown) => {
        // Page where extensions cannot inject (e.g. addons.mozilla.org, or
        // a non-web URL). Nothing to resume there.
        console.warn(
          `[InariMCP] Early logging injection failed (tab ${details.tabId}):`,
          errorMessage(error),
        );
      });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    forgetTab(tabId);
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
  if (msg.type === LOG_RECORD_MESSAGE) {
    sendResponse(answerLogRecords(msg, sender));
    return;
  }
  if (msg.type === LOGGING_STATE_QUERY) {
    // Answered from the sender the browser reports (logging.ts).
    sendResponse(loggingStateFor(sender));
    return;
  }
  if (msg.target === "background") return runPageCommand(msg, sender, sendResponse);
}

/**
 * Approval LIST / DECIDE. Only the toolbar popup may see or answer approval
 * requests: never a content script (page JS, fox_execute_script), and for a
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
 * A batch of log entries from the top frame of a tab whose logging is on.
 * The page URL checked is the browser's (sender), never one from the
 * message. `accepted` says whether the entries were kept; when not, `reason`
 * says why (a protected page: the content script drops what it still holds,
 * see log-store.ts sendLogBatch).
 */
function answerLogRecords(
  msg: Record<string, unknown>,
  sender: MessageSender,
): { accepted: true } | { accepted: false; reason: LogRecordRefusal } {
  const senderTabId = sender.tab?.id;
  const refusal: LogRecordRefusal | null =
    sender.frameId !== TOP_FRAME_ID
      ? "not_top_frame"
      : senderTabId === undefined || !isLoggingTab(senderTabId)
        ? "not_logging"
        : acceptLogRecords(senderTabId, [sender.tab?.url, sender.url], msg);
  return refusal === null ? { accepted: true } : { accepted: false, reason: refusal };
}

/**
 * A command for the dispatcher (`target: "background"`). Only the
 * Extension's own pages (the popup) may drive it directly. Content scripts
 * -- including code run by fox_execute_script -- could otherwise call every
 * handler without the containerScope / protectedUrlPatterns the MCP Server
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
