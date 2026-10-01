// Command dispatcher (L4): one command from the Native Host or the popup,
// through the checks (container scope, URL lists, protected domains) to its
// handler, and the response back over Native Messaging.

import { isSingleTabAction, SELF_PROTECTED_ACTIONS } from "./action-policy";
import { requestApproval } from "./approvals";
import {
  parseContainerScope,
  enforceContainerScope,
  outOfScope,
  listContainers,
  openInContainer,
} from "./container-scope";
import { trackHumanWait, solveCaptcha, cancelHumanWait } from "./human-wait";
import { startLoggingOnTab, stopLoggingOnTab, getLogsOfTab, clearLogsOfTab } from "./logging";
import { hostStatus, recheckHost, postToHost } from "./native-connection";
import { navigateTo, navigateNewTab, navigateHistory } from "./navigation";
import {
  performClick,
  performType,
  performScroll,
  getPageInfo,
  getElements,
  executeScript,
  highlightElement,
  waitForElement,
} from "./page-actions";
import { refreshTab, reloadAllTabs, reloadTabsByUrl } from "./reload";
import { takeScreenshot, screenshotAllTabs } from "./screenshot";
import { refreshSetupState } from "./setup-badge";
import { resolveTab, sendToContentScript } from "./tab-target";
import { waitForNavigation, waitForUrl } from "./tab-wait";
import {
  getAllTabs,
  createNewTab,
  closeTab,
  focusTab,
  getTabInfo,
  findTabs,
  findText,
} from "./tabs";
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
} from "./types";
import { parseUrlPolicy, hasUrlLists, checkListedTarget, checkProtectedTarget } from "./url-policy";
import { resolveWireAction, toWireResponse } from "./wire";

export async function handleCommand(message: NativeMessage): Promise<CommandResult> {
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
