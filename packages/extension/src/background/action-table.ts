// Action descriptor table (L4): one row per internal action name, with the
// checks handleCommand applies to it and the handler it runs. The single
// source of which actions exist in the background and how each is checked.
//
// Wire names (snake_case, BrowserCommand.action) are converted to these
// internal names by WIRE_ACTION_MAP (../action-map.ts) before the lookup;
// every non-null value of that map is a key of this table (type-checked
// there, and by tests/contract/wire-action-map.test.ts). Rows without a wire
// name are internal-only ("status": popup).
//
// Fail closed: an action that is not in the table gets UNKNOWN_ACTION, the
// strictest row (single-tab checks, protected check up front) whose handler
// refuses it.
//
// Columns:
//   scope           "tab"   targets one tab. handleCommand resolves the
//                           target tab once (explicit tabId, else the active
//                           tab), the container scope requires it to be in
//                           the agent container, the blocked / allowed URL
//                           lists are checked against its URL, and its URL
//                           is reported after a successful call.
//                   "self"  multi-tab, new tab or container action that
//                           enforces the container scope itself (filters
//                           tabs / containers, creates the tab inside the
//                           container); the handler gets `scope`.
//                   "noTab" touches no tab and no container (approval
//                           requests are shown in the toolbar popup;
//                           cancel_human_wait only withdraws a wait whose
//                           command already passed the scope check).
//   protectedCheck  "upfront" handleCommand refuses a target tab matching
//                             `protectedUrlPatterns` before the handler runs
//                             (unless the human approved that host).
//                   "handler" the handler applies the patterns itself
//                             (multi-tab actions skip protected tabs,
//                             start_logging refuses on its own tab,
//                             get_*_logs report a pause).
//                   "none"    no existing tab to check.
//   needsTabId      (tab only) an explicit tabId is required; the active tab
//                   is not used as a fallback.
//   skipUrlReport   (tab only) no URL report after the call (the tab is gone).
//   handler         runs the action (inside handleCommand's try / catch).

import type { ContentAction } from "../content/types";
import type { CompiledUrlRule } from "../url-rule";
import { requestApproval } from "./approvals";
import { listContainers, openInContainer } from "./container-scope";
import { trackHumanWait, solveCaptcha, cancelHumanWait } from "./human-wait";
import { startLoggingOnTab, stopLoggingOnTab, getLogsOfTab, clearLogsOfTab } from "./logging";
import { hostStatus, recheckHost } from "./native-connection";
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
import { sendToContentScript } from "./tab-target";
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
  UrlLists,
} from "./types";

/** What handleCommand hands to a handler, after every check passed. */
export interface ActionContext {
  /** Internal action name (undefined only for UNKNOWN_ACTION). */
  action: string | undefined;
  message: NativeMessage;
  data: NativeMessage["data"];
  /** The pinned target tab id (scope "tab"), else message.tabId. */
  tabId: number | undefined;
  /** The target tab resolved once (scope "tab"), else undefined. */
  target: browser.tabs.Tab | undefined;
  /** Container scope filter, null when container_scope is off. */
  scope: ScopeFilter | null;
  protectedPatterns: CompiledUrlRule[];
  urlLists: UrlLists;
  /** Hostname a human approved for this one call. */
  approvedHost: string | undefined;
  /** fox_navigate with newTab, routed as createTab. */
  navigateInNewTab: boolean;
}

export type ActionHandler = (c: ActionContext) => Promise<CommandResult>;

interface TabActionDescriptor {
  scope: "tab";
  protectedCheck: "upfront" | "handler";
  needsTabId?: true;
  skipUrlReport?: true;
  handler: ActionHandler;
}
interface SelfScopedActionDescriptor {
  scope: "self";
  protectedCheck: "handler" | "none";
  handler: ActionHandler;
}
interface NoTabActionDescriptor {
  scope: "noTab";
  protectedCheck: "none";
  handler: ActionHandler;
}
export type ActionDescriptor = TabActionDescriptor | SelfScopedActionDescriptor | NoTabActionDescriptor;

/**
 * Content-script-forwarded actions. Every command goes to the top frame
 * (sendToContentScript's default), never to whichever frame answers first.
 */
function toContentScript(action: ContentAction): ActionHandler {
  return (c) => sendToContentScript(c.tabId, { ...c.data, action });
}

/**
 * The command's data as the options type of a handler: the one place the
 * table narrows `data`. Not checked here -- the MCP Server validates each
 * operation's arguments (operation schemas), and handlers read them
 * defensively.
 */
function optionsOf<T>(c: ActionContext): T {
  return c.data as T;
}

/** status (popup): host connection and setup state. */
async function status(c: ActionContext): Promise<CommandResult> {
  // The popup asks for a recheck (e.g. right after running the installer)
  // so it need not wait for the reconnect backoff.
  if (c.data?.recheck === true && !hostStatus().confirmed) {
    recheckHost();
  }
  const setup = await refreshSetupState();
  return {
    success: true,
    connected: hostStatus().confirmed,
    version: browser.runtime.getManifest().version,
    setup,
  };
}

const ACTIONS = {
  // --- Page interaction ---
  screenshot: { scope: "tab", protectedCheck: "upfront", handler: (c) => takeScreenshot(c.tabId, optionsOf<ScreenshotOptions>(c)) },
  click: { scope: "tab", protectedCheck: "upfront", handler: (c) => performClick(c.tabId, c.data) },
  type: { scope: "tab", protectedCheck: "upfront", handler: (c) => performType(c.tabId, c.data) },
  scroll: { scope: "tab", protectedCheck: "upfront", handler: (c) => performScroll(c.tabId, c.data) },
  navigate: { scope: "tab", protectedCheck: "upfront", handler: (c) => navigateTo(c.tabId, optionsOf<{ url: string }>(c)) },
  getPageInfo: { scope: "tab", protectedCheck: "upfront", handler: (c) => getPageInfo(c.tabId) },
  getElements: { scope: "tab", protectedCheck: "upfront", handler: (c) => getElements(c.tabId, c.data) },
  executeScript: { scope: "tab", protectedCheck: "upfront", handler: (c) => executeScript(c.tabId, optionsOf<{ script: string }>(c)) },
  highlight: { scope: "tab", protectedCheck: "upfront", handler: (c) => highlightElement(c.tabId, c.data) },
  waitForElement: { scope: "tab", protectedCheck: "upfront", handler: (c) => waitForElement(c.tabId, c.data) },

  // --- Tab management ---
  getTabs: { scope: "self", protectedCheck: "none", handler: (c) => getAllTabs(optionsOf<GetAllTabsOptions>(c), c.scope) },
  createTab: {
    scope: "self",
    protectedCheck: "none",
    handler: (c) =>
      c.navigateInNewTab
        ? navigateNewTab(optionsOf<{ url: string; waitForLoad?: boolean }>(c), c.scope)
        : createNewTab(optionsOf<{ url?: string; active?: boolean }>(c), c.scope),
  },
  closeTab: { scope: "tab", protectedCheck: "upfront", needsTabId: true, skipUrlReport: true, handler: (c) => closeTab(c.tabId!) },
  focusTab: { scope: "tab", protectedCheck: "upfront", needsTabId: true, handler: (c) => focusTab(c.tabId!) },
  getTabInfo: { scope: "tab", protectedCheck: "upfront", needsTabId: true, handler: (c) => getTabInfo(c.tabId!) },
  findTabs: { scope: "self", protectedCheck: "none", handler: (c) => findTabs(optionsOf<FindTabsOptions>(c), c.scope) },
  screenshotAllTabs: {
    scope: "self",
    protectedCheck: "handler",
    handler: (c) => screenshotAllTabs(optionsOf<ScreenshotOptions>(c), c.scope, c.protectedPatterns, c.urlLists),
  },

  // --- Reload / navigation ---
  refresh: { scope: "tab", protectedCheck: "upfront", handler: (c) => refreshTab(c.tabId, optionsOf<RefreshOptions>(c)) },
  hardRefresh: {
    scope: "tab",
    protectedCheck: "upfront",
    handler: (c) => refreshTab(c.tabId, { ...optionsOf<RefreshOptions>(c), bypassCache: true }),
  },
  reloadAll: {
    scope: "self",
    protectedCheck: "handler",
    handler: (c) => reloadAllTabs(optionsOf<ReloadAllOptions>(c), c.scope, c.protectedPatterns, c.urlLists),
  },
  reloadByUrl: {
    scope: "self",
    protectedCheck: "handler",
    handler: (c) => reloadTabsByUrl(optionsOf<ReloadByUrlOptions>(c), c.scope, c.protectedPatterns, c.urlLists),
  },
  goBack: { scope: "tab", protectedCheck: "upfront", handler: (c) => navigateHistory(c.tabId, "back") },
  goForward: { scope: "tab", protectedCheck: "upfront", handler: (c) => navigateHistory(c.tabId, "forward") },

  // --- Popup ---
  status: { scope: "noTab", protectedCheck: "none", handler: status },

  // --- Approval / human wait ---
  requestApproval: { scope: "noTab", protectedCheck: "none", handler: (c) => requestApproval(c.message.requestId, c.data) },
  solveCaptcha: {
    scope: "tab",
    protectedCheck: "upfront",
    handler: (c) => trackHumanWait(c.message.requestId, c.tabId, (id) => solveCaptcha(id, optionsOf<{ detectOnly?: boolean }>(c))),
  },
  cancelHumanWait: { scope: "noTab", protectedCheck: "none", handler: (c) => cancelHumanWait(c.data) },

  // --- Content script (form / input, wait / observe, text) ---
  getValue: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("getValue") },
  setValue: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("setValue") },
  selectOption: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("selectOption") },
  hover: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("hover") },
  waitForChange: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("waitForChange") },
  observeElement: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("observeElement") },
  stopObserving: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("stopObserving") },
  scrollAndCapture: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("scrollAndCapture") },
  clickAndWait: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("clickAndWait") },
  pressKey: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("pressKey") },
  getText: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("getText") },
  waitForNetworkIdle: { scope: "tab", protectedCheck: "upfront", handler: toContentScript("waitForNetworkIdle") },

  // --- Tab waits ---
  waitForNavigation: { scope: "tab", protectedCheck: "upfront", handler: (c) => waitForNavigation(c.tabId, c.data) },
  waitForUrl: { scope: "tab", protectedCheck: "upfront", handler: (c) => waitForUrl(c.tabId, c.data) },

  // --- Console / network logging ---
  startLogging: {
    scope: "tab",
    protectedCheck: "handler",
    handler: (c) => startLoggingOnTab(c.target, c.data, c.protectedPatterns, c.approvedHost),
  },
  stopLogging: { scope: "tab", protectedCheck: "upfront", handler: (c) => stopLoggingOnTab(c.target) },
  getConsoleLogs: {
    scope: "tab",
    protectedCheck: "handler",
    handler: (c) => getLogsOfTab("getConsoleLogs", c.target, c.data, c.protectedPatterns),
  },
  getNetworkLogs: {
    scope: "tab",
    protectedCheck: "handler",
    handler: (c) => getLogsOfTab("getNetworkLogs", c.target, c.data, c.protectedPatterns),
  },
  clearLogs: { scope: "tab", protectedCheck: "upfront", handler: (c) => clearLogsOfTab(c.target, c.data) },

  // --- Containers / find (snake_case internal names) ---
  list_containers: { scope: "self", protectedCheck: "none", handler: (c) => listContainers(c.scope) },
  open_in_container: {
    scope: "self",
    protectedCheck: "none",
    handler: (c) =>
      openInContainer(
        optionsOf<{ url: string; containerName?: string; cookieStoreId?: string; color?: string; icon?: string; active?: boolean }>(c),
        c.scope,
      ),
  },
  find_text: { scope: "tab", protectedCheck: "upfront", handler: (c) => findText(c.target, c.data) },
} as const satisfies Record<string, ActionDescriptor>;

/** Internal action name handled by the background (a row of the table). */
export type InternalAction = keyof typeof ACTIONS;

/** The table, as a Map: lookups never hit Object.prototype keys. */
export const ACTION_TABLE: ReadonlyMap<string, ActionDescriptor> = new Map<string, ActionDescriptor>(
  Object.entries(ACTIONS),
);

/** Row for an action not in the table: strictest checks, then refused. */
export const UNKNOWN_ACTION: ActionDescriptor = {
  scope: "tab",
  protectedCheck: "upfront",
  handler: async (c) => ({ success: false, error: `Unknown action: ${c.action}` }),
};

/** The descriptor of an internal action name (UNKNOWN_ACTION if none). */
export function describeAction(action: string): ActionDescriptor {
  return ACTION_TABLE.get(action) ?? UNKNOWN_ACTION;
}
