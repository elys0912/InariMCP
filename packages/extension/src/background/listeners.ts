// Runtime / tab / navigation / notification listeners (L5). Registered once
// by background.ts (registerListeners).

import { APPROVAL_MESSAGE } from "../approval";
import { listApprovals, decideApproval, APPROVAL_NOTIFICATION_PREFIX } from "./approvals";
import { LOG_RECORD_MESSAGE, TOP_FRAME_ID, LOGGING_STATE_QUERY } from "./constants";
import { handleCommand } from "./dispatch";
import {
  isLoggingTab,
  acceptLogRecords,
  loggingStateFor,
  wantsEarlyInjection,
  forgetTab,
} from "./logging";
import type { NativeMessage } from "./types";

export function registerListeners(): void {
  // Content script messages
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: browser.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean | void => {
      const msg = message as { target?: string; type?: string; [key: string]: unknown };
      if (msg.type === APPROVAL_MESSAGE.LIST || msg.type === APPROVAL_MESSAGE.DECIDE) {
        // Only the toolbar popup may see or answer approval requests: never a
        // content script (page JS, fox_execute_script), and for a decision not
        // even an extension page loaded in a tab.
        if (!isExtensionPage(sender) || (msg.type === APPROVAL_MESSAGE.DECIDE && sender.tab)) {
          console.error("[KitsuneMCP] Refused approval message from", sender.url);
          sendResponse({ success: false, error: "Approval requests are answered in the KitsuneMCP toolbar popup" });
          return;
        }
        sendResponse(
          msg.type === APPROVAL_MESSAGE.LIST
            ? { success: true, approvals: listApprovals() }
            : decideApproval(msg.id, msg.approved),
        );
        return;
      }
      if (msg.type === LOG_RECORD_MESSAGE) {
        // A batch from the top frame of a tab whose logging is on. The page
        // URL checked is the browser's (sender), never one from the message.
        const senderTabId = sender.tab?.id;
        const accepted =
          sender.frameId === TOP_FRAME_ID &&
          senderTabId !== undefined &&
          isLoggingTab(senderTabId);
        if (accepted) acceptLogRecords(senderTabId, [sender.tab?.url, sender.url], msg as { console?: unknown; network?: unknown });
        sendResponse({ accepted });
        return;
      }
      if (msg.type === LOGGING_STATE_QUERY) {
        // Answered from the sender the browser reports (logging.ts).
        sendResponse(loggingStateFor(sender));
        return;
      }
      if (msg.target === "background") {
        // Only the Extension's own pages (the popup) may drive the dispatcher
        // directly. Content scripts -- including code run by fox_execute_script
        // -- could otherwise call every handler without the containerScope /
        // protectedUrlPatterns the MCP Server attaches (Layer 0 bypass).
        if (!isExtensionPage(sender)) {
          console.error("[KitsuneMCP] Refused background command from", sender.url);
          sendResponse({ success: false, error: "Background commands are only accepted from extension pages" });
          return;
        }
        handleCommand({
          ...msg,
          tabId: sender.tab?.id,
        } as NativeMessage).then(sendResponse);
        return true;
      }
    },
  );

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
    console.log(`[KitsuneMCP] Early logging injection requested (tab ${details.tabId})`);
    // dist/content.js is self-contained (url-rule.ts is bundled into it).
    browser.tabs
      .executeScript(details.tabId, { file: "/dist/content.js", runAt: "document_start", frameId: TOP_FRAME_ID })
      .then(() => {
        console.log(`[KitsuneMCP] Early logging injection done (tab ${details.tabId})`);
      })
      .catch((error: unknown) => {
        // Page where extensions cannot inject (e.g. addons.mozilla.org, or
        // a non-web URL). Nothing to resume there.
        console.warn(
          `[KitsuneMCP] Early logging injection failed (tab ${details.tabId}):`,
          (error as Error).message,
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
    (
      _message: unknown,
      sender: browser.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      console.error("[KitsuneMCP] Refused external message from", sender?.id);
      sendResponse({ success: false, error: "External messages are not accepted" });
      return false;
    },
  );
}

/**
 * True for a message from one of this Extension's own pages (popup, or the
 * popup page opened in a tab). Content scripts report the web page's URL.
 */
function isExtensionPage(sender: browser.runtime.MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(browser.runtime.getURL("/"))
  );
}
