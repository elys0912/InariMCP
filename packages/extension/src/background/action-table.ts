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
// strictest row (single-tab checks, approval required) whose handler refuses
// it.
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
//   approval        Whether the action needs a human approval (url-policy.ts
//                   checkApproval). Every action that changes page or browser
//                   state needs one, whatever the MCP Server attached: the
//                   server must send `approvedHost` for the site it acts on.
//                   "act"        (tab) acts on the target tab: approved for
//                                its site, checked before the handler runs.
//                   "actOnUrl"   opens a URL (data.url, else a blank tab):
//                                approved for that URL's site.
//                   "actPerTab"  (self) multi-tab action: the handler acts
//                                only on tabs on the approved site.
//                   "read"       (tab) reads the target tab: refused before
//                                the handler when it matches the attached
//                                `confirmReadUrlRules` (unless approved for
//                                its site).
//                   "readPerTab" (self) multi-tab read: the handler skips
//                                tabs matching those rules.
//                   "none"       changes no page data (UI only, waits, tab
//                                list, approvals, status).
//   needsTabId      (tab only) an explicit tabId is required; the active tab
//                   is not used as a fallback.
//   skipUrlReport   (tab only) no URL report after the call (the tab is gone).
//   handler         runs the action (inside handleCommand's try / catch).

import type { ContentAction } from "../content/types";
import type { CompiledUrlRule } from "../url-rule";
import { requestApproval } from "./approvals";
import { listContainers, openInContainer } from "./container-scope";
import { trackHumanWait, solveCaptcha, cancelHumanWait } from "./human-wait";
import { hostStatus, recheckHost } from "./native-connection";
import { navigateTo, navigateNewTab, navigateHistory } from "./navigation";
import { getPageInfo } from "./page-actions";
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
  /** confirm_read_sites rules attached by the MCP Server (`confirmReadUrlRules`). */
  readRules: CompiledUrlRule[];
  /** The site a human approved this one call for (`approvedHost`), if any. */
  approvedHost: string | undefined;
  /**
   * "act" rows: the origin (scheme, host and port) of the target tab's URL
   * the approval was checked on (site-origin.ts), else undefined.
   */
  approvedOrigin: string | undefined;
  /**
   * Commands from the Native Host: the pause count (control-state.ts) when
   * the pause switch was last looked at; undefined for the popup's commands.
   */
  pauseCount: number | undefined;
  urlLists: UrlLists;
  /** fox_navigate with newTab, routed as createTab. */
  navigateInNewTab: boolean;
}

export type ActionHandler = (c: ActionContext) => Promise<CommandResult>;

interface TabActionDescriptor {
  scope: "tab";
  approval: "act" | "actOnUrl" | "read" | "none";
  needsTabId?: true;
  skipUrlReport?: true;
  handler: ActionHandler;
}
interface SelfScopedActionDescriptor {
  scope: "self";
  approval: "actOnUrl" | "actPerTab" | "readPerTab" | "none";
  handler: ActionHandler;
}
interface NoTabActionDescriptor {
  scope: "noTab";
  approval: "none";
  handler: ActionHandler;
}
export type ActionDescriptor = TabActionDescriptor | SelfScopedActionDescriptor | NoTabActionDescriptor;

/**
 * Content-script-forwarded actions. Every command goes to the top frame
 * (sendToContentScript's default), never to whichever frame answers first.
 * An acting command carries the origin it was approved on: the content
 * script refuses it if its page is no longer there (content/handler.ts). A
 * command from the Native Host carries the pause count: it is not sent, or
 * refused by the content script, after a later pause (tab-target.ts).
 */
function toContentScript(action: ContentAction): ActionHandler {
  return (c) =>
    sendToContentScript(c.tabId, { ...c.data, approvedOrigin: c.approvedOrigin, pauseCount: c.pauseCount, action });
}

/**
 * Handler of a needsTabId row. handleCommand already refused the command
 * without an explicit tabId; the check here narrows the type for `run`.
 */
function withTabId(run: (tabId: number) => Promise<CommandResult>): ActionHandler {
  return async (c) => (c.tabId === undefined ? { success: false, error: "tabId is required" } : run(c.tabId));
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
  screenshot: { scope: "tab", approval: "read", handler: (c) => takeScreenshot(c.tabId, optionsOf<ScreenshotOptions>(c)) },
  click: { scope: "tab", approval: "act", handler: toContentScript("click") },
  type: { scope: "tab", approval: "act", handler: toContentScript("type") },
  scroll: { scope: "tab", approval: "none", handler: toContentScript("scroll") },
  navigate: { scope: "tab", approval: "actOnUrl", handler: (c) => navigateTo(c.tabId, optionsOf<{ url: string }>(c)) },
  getPageInfo: { scope: "tab", approval: "read", handler: (c) => getPageInfo(c.tabId) },
  getElements: { scope: "tab", approval: "read", handler: toContentScript("getElements") },
  highlight: { scope: "tab", approval: "none", handler: toContentScript("highlight") },
  waitForElement: { scope: "tab", approval: "none", handler: toContentScript("waitForElement") },

  // --- Tab management ---
  getTabs: { scope: "self", approval: "none", handler: (c) => getAllTabs(optionsOf<GetAllTabsOptions>(c), c.scope) },
  createTab: {
    scope: "self",
    approval: "actOnUrl",
    handler: (c) =>
      c.navigateInNewTab
        ? navigateNewTab(optionsOf<{ url: string; waitForLoad?: boolean }>(c), c.scope)
        : createNewTab(optionsOf<{ url?: string; active?: boolean }>(c), c.scope),
  },
  closeTab: { scope: "tab", approval: "act", needsTabId: true, skipUrlReport: true, handler: withTabId(closeTab) },
  focusTab: { scope: "tab", approval: "none", needsTabId: true, handler: withTabId(focusTab) },
  getTabInfo: { scope: "tab", approval: "none", needsTabId: true, handler: withTabId(getTabInfo) },
  findTabs: { scope: "self", approval: "none", handler: (c) => findTabs(optionsOf<FindTabsOptions>(c), c.scope) },
  screenshotAllTabs: {
    scope: "self",
    approval: "readPerTab",
    handler: (c) => screenshotAllTabs(optionsOf<ScreenshotOptions>(c), c.scope, c.readRules, c.urlLists),
  },

  // --- Reload / navigation ---
  refresh: { scope: "tab", approval: "act", handler: (c) => refreshTab(c.tabId, optionsOf<RefreshOptions>(c)) },
  hardRefresh: {
    scope: "tab",
    approval: "act",
    handler: (c) => refreshTab(c.tabId, { ...optionsOf<RefreshOptions>(c), bypassCache: true }),
  },
  reloadAll: {
    scope: "self",
    approval: "actPerTab",
    handler: (c) => reloadAllTabs(optionsOf<ReloadAllOptions>(c), c.scope, c.approvedHost, c.urlLists),
  },
  reloadByUrl: {
    scope: "self",
    approval: "actPerTab",
    handler: (c) => reloadTabsByUrl(optionsOf<ReloadByUrlOptions>(c), c.scope, c.approvedHost, c.urlLists),
  },
  goBack: { scope: "tab", approval: "act", handler: (c) => navigateHistory(c.tabId, "back") },
  goForward: { scope: "tab", approval: "act", handler: (c) => navigateHistory(c.tabId, "forward") },

  // --- Popup ---
  status: { scope: "noTab", approval: "none", handler: status },

  // --- Approval / human wait ---
  requestApproval: { scope: "noTab", approval: "none", handler: (c) => requestApproval(c.message.requestId, c.data) },
  solveCaptcha: {
    scope: "tab",
    approval: "none",
    handler: (c) => trackHumanWait(c.message.requestId, c.tabId, (id) => solveCaptcha(id, optionsOf<{ detectOnly?: boolean }>(c))),
  },
  cancelHumanWait: { scope: "noTab", approval: "none", handler: (c) => cancelHumanWait(c.data) },

  // --- Content script (form / input, wait / observe, text) ---
  getValue: { scope: "tab", approval: "read", handler: toContentScript("getValue") },
  setValue: { scope: "tab", approval: "act", handler: toContentScript("setValue") },
  selectOption: { scope: "tab", approval: "act", handler: toContentScript("selectOption") },
  hover: { scope: "tab", approval: "none", handler: toContentScript("hover") },
  waitForChange: { scope: "tab", approval: "none", handler: toContentScript("waitForChange") },
  scrollAndCapture: { scope: "tab", approval: "read", handler: toContentScript("scrollAndCapture") },
  clickAndWait: { scope: "tab", approval: "act", handler: toContentScript("clickAndWait") },
  pressKey: { scope: "tab", approval: "act", handler: toContentScript("pressKey") },
  getText: { scope: "tab", approval: "read", handler: toContentScript("getText") },
  waitForNetworkIdle: { scope: "tab", approval: "none", handler: toContentScript("waitForNetworkIdle") },

  // --- Tab waits ---
  waitForNavigation: { scope: "tab", approval: "none", handler: (c) => waitForNavigation(c.tabId, c.data) },
  waitForUrl: { scope: "tab", approval: "none", handler: (c) => waitForUrl(c.tabId, c.data) },

  // --- Containers / find (snake_case internal names) ---
  list_containers: { scope: "self", approval: "none", handler: (c) => listContainers(c.scope) },
  open_in_container: {
    scope: "self",
    approval: "actOnUrl",
    handler: (c) =>
      openInContainer(
        optionsOf<{ url: string; containerName?: string; cookieStoreId?: string; color?: string; icon?: string; active?: boolean }>(c),
        c.scope,
      ),
  },
  find_text: { scope: "tab", approval: "read", handler: (c) => findText(c.target, c.data) },
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
  approval: "act",
  handler: (c) => Promise.resolve({ success: false, error: `Unknown action: ${c.action}` }),
};

/** The descriptor of an internal action name (UNKNOWN_ACTION if none). */
export function describeAction(action: string): ActionDescriptor {
  return ACTION_TABLE.get(action) ?? UNKNOWN_ACTION;
}
