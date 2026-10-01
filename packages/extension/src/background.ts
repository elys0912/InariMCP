// KitsuneMCP Background Script
// Handles native messaging, tab management, and coordination with content scripts
//
// Based on ClaudeCodeBrowser by Andre Watson (nanogenomic), Ligandal Inc.
// MIT License — Copyright (c) 2025
//
// Bundled with its imports into dist/background.js (scripts/build-extension.mjs).

import { t } from "./i18n";
import { APPROVAL_MESSAGE } from "./approval";
import { isSingleTabAction, SELF_PROTECTED_ACTIONS } from "./background/action-policy";
import {
  requestApproval,
  listApprovals,
  decideApproval,
  APPROVAL_NOTIFICATION_PREFIX,
  cancelAllApprovals,
} from "./background/approvals";
import { LOG_RECORD_MESSAGE, TOP_FRAME_ID, LOGGING_STATE_QUERY } from "./background/constants";
import {
  parseContainerScope,
  enforceContainerScope,
  outOfScope,
  listContainers,
  openInContainer,
} from "./background/container-scope";
import { trackHumanWait, solveCaptcha, cancelHumanWait } from "./background/human-wait";
import {
  startLoggingOnTab,
  stopLoggingOnTab,
  getLogsOfTab,
  clearLogsOfTab,
  isLoggingTab,
  acceptLogRecords,
  loggingStateFor,
  wantsEarlyInjection,
  forgetTab,
} from "./background/logging";
import {
  hostStatus,
  recheckHost,
  postToHost,
  setConnectionHooks,
  connectNativeHost,
} from "./background/native-connection";
import { navigateTo, navigateNewTab, navigateHistory } from "./background/navigation";
import {
  performClick,
  performType,
  performScroll,
  getPageInfo,
  getElements,
  executeScript,
  highlightElement,
  waitForElement,
} from "./background/page-actions";
import { refreshTab, reloadAllTabs, reloadTabsByUrl } from "./background/reload";
import { takeScreenshot, screenshotAllTabs } from "./background/screenshot";
import { refreshSetupState, BADGE_COLOR, SETUP_REFRESH_MS } from "./background/setup-badge";
import { resolveTab, sendToContentScript } from "./background/tab-target";
import { waitForNavigation, waitForUrl } from "./background/tab-wait";
import {
  getAllTabs,
  createNewTab,
  closeTab,
  focusTab,
  getTabInfo,
  findTabs,
  findText,
} from "./background/tabs";
import type {
  NativeMessage,
  CommandResult,
  ScopeFilter,
  ScreenshotOptions,
  GetAllTabsOptions,
  FindTabsOptions,
  RefreshOptions,
  ReloadAllOptions,
  ReloadByUrlOptions,
} from "./background/types";
import {
  parseUrlPolicy,
  hasUrlLists,
  checkListedTarget,
  checkProtectedTarget,
} from "./background/url-policy";
import { resolveWireAction, toWireResponse } from "./background/wire";

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function handleCommand(message: NativeMessage): Promise<CommandResult> {
  const { data } = message;
  let tabId = message.tabId;
  let result: CommandResult = { success: false };

  // Normalize the wire action name (snake_case) to the internal name once,
  // before any check, so the scope sets and the switch below all see the
  // same name.
  const resolved = resolveWireAction(message.action);
  if (resolved.kind === "notImplemented") {
    result = { success: false, error: `Not implemented in extension: ${resolved.wireName}` };
    postWireResponse(message, result);
    return result;
  }
  // fox_navigate with newTab opens the URL in a fresh tab. Route it as
  // createTab so the scope check treats it like fox_create_tab: the new tab
  // is born inside the agent container instead of requiring the current
  // active tab to be in scope.
  const navigateInNewTab = resolved.action === "navigate" && data?.newTab === true;
  const action = navigateInNewTab ? "createTab" : resolved.action;

  // Resolve the target tab of a single-tab action ONCE (explicit tabId, else
  // the active tab of the current window) and pin its id: the container
  // scope check, the protected-domain check, the handler and the URL report
  // below then all see the same tab, even if the active tab changes
  // meanwhile. Undefined when it cannot be resolved -- the checks then fail
  // closed and the handler reports the missing tab.
  let target: browser.tabs.Tab | undefined;
  if (action !== undefined && isSingleTabAction(action)) {
    try {
      target = await resolveTab(tabId);
    } catch {
      target = undefined;
    }
    if (target) tabId = target.id;
  }

  // Container scope check (Layer 0). The MCP Server attaches
  // `containerScope` to every command when container_scope.enabled is true.
  const containerScope = parseContainerScope(message.containerScope);
  let scope: ScopeFilter | null = null;
  if (containerScope) {
    const decision = await enforceContainerScope(action, target, containerScope);
    if (!decision.allowed) {
      result = outOfScope(decision.error);
      postWireResponse(message, result);
      return result;
    }
    scope = decision.scope;
  }
  const policy = parseUrlPolicy(message);
  if (policy.invalid > 0) {
    result = {
      success: false,
      safetyDecision: "config_error",
      error:
        `Refused: ${policy.invalid} URL pattern(s) attached by the MCP Server could not be used ` +
        "(Extension and MCP Server versions may not match).",
    };
    postWireResponse(message, result);
    return result;
  }
  const protectedPatterns = policy.protectedRules;
  const urlLists = policy.lists;
  // Hostname a human approved for this one call (MCP Server approval token).
  const approvedHost = typeof message.approvedHost === "string" ? message.approvedHost : undefined;

  // blocked / allowed lists against the real URL of the target tab (the
  // guard only knows the last URL it saw for the tab, if any). The server
  // attaches them to the commands its own tab check covers; the multi-tab
  // actions skip such tabs themselves. A human approval does not lift this.
  if (hasUrlLists(urlLists) && action !== undefined && isSingleTabAction(action)) {
    const refusal = checkListedTarget(target, urlLists);
    if (refusal) {
      result = refusal;
      postWireResponse(message, result);
      return result;
    }
  }

  // Protected-domain check against the real URL of the target tab (not the
  // server's last-seen URL, which is shared by every session). The server
  // attaches the patterns, when confirm_protected_actions is true, to
  // single-tab captures and to every acting tool without a `url` argument;
  // the logging actions and the multi-tab actions (screenshot_all_tabs,
  // reload_all, reload_by_url) apply them themselves below. Actions that
  // act on no existing tab (new tab, tab list, approval, status) have no
  // target to check.
  if (
    protectedPatterns.length > 0 &&
    action !== undefined &&
    isSingleTabAction(action) &&
    !SELF_PROTECTED_ACTIONS.has(action)
  ) {
    const refusal = checkProtectedTarget(target, protectedPatterns, approvedHost);
    if (refusal) {
      result = refusal;
      postWireResponse(message, result);
      return result;
    }
  }

  try {
    switch (action) {
      case "screenshot":
        result = await takeScreenshot(tabId, data as ScreenshotOptions);
        break;
      case "click":
        result = await performClick(tabId, data);
        break;
      case "type":
        result = await performType(tabId, data);
        break;
      case "scroll":
        result = await performScroll(tabId, data);
        break;
      case "navigate":
        result = await navigateTo(tabId, data as { url: string });
        break;
      case "getPageInfo":
        result = await getPageInfo(tabId);
        break;
      case "getElements":
        result = await getElements(tabId, data);
        break;
      case "executeScript":
        result = await executeScript(tabId, data as { script: string });
        break;
      case "highlight":
        result = await highlightElement(tabId, data);
        break;
      case "waitForElement":
        result = await waitForElement(tabId, data);
        break;
      case "getTabs":
        result = await getAllTabs(data as GetAllTabsOptions, scope);
        break;
      case "createTab":
        result = navigateInNewTab
          ? await navigateNewTab(data as { url: string; waitForLoad?: boolean }, scope)
          : await createNewTab(data as { url?: string; active?: boolean }, scope);
        break;
      case "closeTab":
        if (tabId === undefined || message.tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await closeTab(tabId);
        break;
      case "focusTab":
        if (tabId === undefined || message.tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await focusTab(tabId);
        break;
      case "getTabInfo":
        if (tabId === undefined || message.tabId === undefined) { result = { success: false, error: "tabId is required" }; break; }
        result = await getTabInfo(tabId);
        break;
      case "findTabs":
        result = await findTabs(data as FindTabsOptions, scope);
        break;
      case "screenshotAllTabs":
        result = await screenshotAllTabs(data as ScreenshotOptions, scope, protectedPatterns, urlLists);
        break;
      case "refresh":
        result = await refreshTab(tabId, data as RefreshOptions);
        break;
      case "hardRefresh":
        result = await refreshTab(tabId, { ...(data as RefreshOptions), bypassCache: true });
        break;
      case "reloadAll":
        result = await reloadAllTabs(data as ReloadAllOptions, scope, protectedPatterns, urlLists);
        break;
      case "reloadByUrl":
        result = await reloadTabsByUrl(data as ReloadByUrlOptions, scope, protectedPatterns, urlLists);
        break;
      case "status": {
        // The popup asks for a recheck (e.g. right after running the
        // installer) so it need not wait for the reconnect backoff.
        if (data?.recheck === true && !hostStatus().confirmed) {
          recheckHost();
        }
        const setup = await refreshSetupState();
        result = {
          success: true,
          connected: hostStatus().confirmed,
          version: browser.runtime.getManifest().version,
          setup,
        };
        break;
      }
      case "goBack":
        result = await navigateHistory(tabId, "back");
        break;
      case "goForward":
        result = await navigateHistory(tabId, "forward");
        break;
      case "requestApproval":
        result = await requestApproval(message.requestId, data);
        break;
      case "solveCaptcha":
        result = await trackHumanWait(message.requestId, tabId, (id) =>
          solveCaptcha(id, data as { detectOnly?: boolean }),
        );
        break;
      case "cancelHumanWait":
        result = await cancelHumanWait(data);
        break;
      // Content-script-forwarded actions. Every command goes to the top
      // frame (sendToContentScript's default), never to whichever frame
      // answers first.
      case "getValue":
      case "setValue":
      case "selectOption":
      case "hover":
      case "waitForChange":
      case "observeElement":
      case "stopObserving":
      case "scrollAndCapture":
      case "clickAndWait":
      case "pressKey":
      case "getText":
      case "waitForNetworkIdle":
        result = await sendToContentScript(tabId, { action, ...data });
        break;
      case "waitForNavigation":
        result = await waitForNavigation(tabId, data);
        break;
      case "waitForUrl":
        result = await waitForUrl(tabId, data);
        break;
      case "startLogging":
        result = await startLoggingOnTab(target, data, protectedPatterns, approvedHost);
        break;
      case "stopLogging":
        result = await stopLoggingOnTab(target);
        break;
      case "getConsoleLogs":
      case "getNetworkLogs":
        result = await getLogsOfTab(action, target, data, protectedPatterns);
        break;
      case "clearLogs":
        result = await clearLogsOfTab(target, data);
        break;
      case "list_containers":
        result = await listContainers(scope);
        break;
      case "open_in_container":
        result = await openInContainer(data as { url: string; containerName?: string; cookieStoreId?: string; color?: string; icon?: string; active?: boolean }, scope);
        break;
      case "find_text":
        result = await findText(target, data);
        break;
      default:
        result = { success: false, error: `Unknown action: ${action}` };
    }
  } catch (error) {
    result = { success: false, error: (error as Error).message };
  }

  // Report the target tab's URL after the operation so the server's guard
  // can track the current page (data.url). Only for single-tab actions; the
  // tab-creating actions set `url` themselves, and a closed tab has none.
  if (
    result.success &&
    typeof result.url !== "string" &&
    action !== undefined &&
    isSingleTabAction(action) &&
    action !== "closeTab"
  ) {
    try {
      const tab = await resolveTab(tabId);
      if (tab && tab.url) {
        result = { ...result, url: tab.url };
      }
    } catch {
      // Tab vanished -- report the result without a URL
    }
  }

  postWireResponse(message, result);

  return result;
}

// ---------------------------------------------------------------------------
// Wire protocol helpers
// ---------------------------------------------------------------------------

/**
 * Send the result of a native command back to the native host. Messages from
 * the popup / content script carry no requestId and get the raw result via
 * sendResponse instead.
 */
function postWireResponse(message: NativeMessage, result: CommandResult): void {
  if (message.requestId) {
    try {
      postToHost(toWireResponse(message.requestId, result));
    } catch (e) {
      // Port disconnected meanwhile, or the result is not serializable. The
      // server fails the request on its own timeout / WS disconnect.
      console.error(
        `Failed to send response for requestId ${message.requestId}:`,
        e,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

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

// Context menus
browser.contextMenus.create({
  id: "kitsune-screenshot",
  title: t("menuScreenshot"),
  contexts: ["page"],
});

browser.contextMenus.create({
  id: "kitsune-inspect",
  title: t("menuInspect"),
  contexts: ["all"],
});

browser.contextMenus.onClicked.addListener(
  (
    info: { menuItemId: string; pageX?: number; pageY?: number; frameId?: number },
    tab: browser.tabs.Tab,
  ): void => {
    if (info.menuItemId === "kitsune-screenshot") {
      void takeScreenshot(tab.id).then((result) => {
        if (!result.success) return;
        try {
          postToHost({
            action: "screenshotTaken",
            data: result.imageData,
            tab: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" },
          });
        } catch (error) {
          console.warn("[KitsuneMCP] Could not hand the screenshot to the native host:", (error as Error).message);
        }
      });
    } else if (info.menuItemId === "kitsune-inspect") {
      // The frame the menu was opened in (its content script handles it).
      browser.tabs
        .sendMessage(
          tab.id,
          { action: "inspectElement", x: info.pageX, y: info.pageY },
          { frameId: info.frameId ?? TOP_FRAME_ID },
        )
        .catch((error: unknown) => {
          // No content script in that frame (e.g. a page extensions cannot enter)
          console.warn("[KitsuneMCP] Inspect element failed:", (error as Error).message);
        });
    }
  },
);

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

setConnectionHooks({
  onCommand: (message) => { void handleCommand(message); },
  onConfirmed: () => { void refreshSetupState(); },
  onDisconnected: () => {
    cancelAllApprovals();
    void refreshSetupState();
  },
});
browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
connectNativeHost();
// Session count changes without any event reaching the Extension.
setInterval(() => { void refreshSetupState(); }, SETUP_REFRESH_MS);
console.log("[KitsuneMCP] Background script initialized");
