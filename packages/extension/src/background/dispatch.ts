// Command dispatcher (L4): one command from the Native Host or the popup,
// through the checks (container scope, URL lists, protected domains) to its
// handler, and the response back over Native Messaging. Which checks apply
// to an action, and its handler, come from the action table
// (action-table.ts).

import { describeAction, UNKNOWN_ACTION, type ActionDescriptor } from "./action-table";
import { parseContainerScope, enforceContainerScope, outOfScope } from "./container-scope";
import { postToHost } from "./native-connection";
import { resolveTab } from "./tab-target";
import type { NativeMessage, CommandResult, ScopeFilter } from "./types";
import { parseUrlPolicy, hasUrlLists, checkListedTarget, checkProtectedTarget } from "./url-policy";
import { resolveWireAction, toWireResponse } from "./wire";

export async function handleCommand(message: NativeMessage): Promise<CommandResult> {
  const { data } = message;
  let tabId = message.tabId;
  let result: CommandResult = { success: false };

  // Normalize the wire action name (snake_case) to the internal name once,
  // before any check, so every check and the handler see the same row of
  // the action table.
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
  // Row of the action table (fail closed: an unknown name gets the strictest
  // row, UNKNOWN_ACTION). A message without an action has no row: it skips
  // the tab checks, is checked strictly by the container scope, and ends in
  // UNKNOWN_ACTION's refusal.
  const entry: ActionDescriptor | undefined = action === undefined ? undefined : describeAction(action);
  const singleTab = entry?.scope === "tab";

  // Resolve the target tab of a single-tab action ONCE (explicit tabId, else
  // the active tab of the current window) and pin its id: the container
  // scope check, the protected-domain check, the handler and the URL report
  // below then all see the same tab, even if the active tab changes
  // meanwhile. Undefined when it cannot be resolved -- the checks then fail
  // closed and the handler reports the missing tab.
  let target: browser.tabs.Tab | undefined;
  if (singleTab) {
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
    const selfScoped = entry !== undefined && entry.scope !== "tab";
    const decision = await enforceContainerScope(selfScoped, target, containerScope);
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
  if (hasUrlLists(urlLists) && singleTab) {
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
  // single-tab captures and to every acting tool without a `url` argument.
  // Only rows with protectedCheck "upfront" are checked here: the logging
  // actions and the multi-tab actions (screenshot_all_tabs, reload_all,
  // reload_by_url) apply the patterns in their handlers, and actions that
  // act on no existing tab (new tab, tab list, approval, status) have no
  // target to check.
  if (protectedPatterns.length > 0 && entry?.protectedCheck === "upfront") {
    const refusal = checkProtectedTarget(target, protectedPatterns, approvedHost);
    if (refusal) {
      result = refusal;
      postWireResponse(message, result);
      return result;
    }
  }

  const descriptor = entry ?? UNKNOWN_ACTION;
  try {
    if (descriptor.scope === "tab" && descriptor.needsTabId && (tabId === undefined || message.tabId === undefined)) {
      result = { success: false, error: "tabId is required" };
    } else {
      result = await descriptor.handler({
        action,
        message,
        data,
        tabId,
        target,
        scope,
        protectedPatterns,
        urlLists,
        approvedHost,
        navigateInNewTab,
      });
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
    entry?.scope === "tab" &&
    entry.skipUrlReport !== true
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
