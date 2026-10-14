// Command dispatcher (L4): one command from the Native Host or the popup,
// through the checks (pause switch, container scope, URL lists, human
// approval) to its handler, and the response back over Native Messaging.
// Which checks apply to an action, and its handler, come from the action
// table (action-table.ts). While a command from the Native Host runs, the
// toolbar badge shows it (setup-badge.ts).

import { errorMessage } from "../error-message";
import { describeAction, UNKNOWN_ACTION, type ActionContext, type ActionDescriptor } from "./action-table";
import { parseContainerScope, enforceContainerScope, outOfScope } from "./container-scope";
import { isPaused } from "./control-state";
import { postToHost } from "./native-connection";
import { startHostCommand } from "./setup-badge";
import { resolveTab } from "./tab-target";
import type { NativeMessage, CommandResult, ScopeFilter } from "./types";
import { parseUrlPolicy, hasUrlLists, checkListedTarget, checkApproval } from "./url-policy";
import { resolveWireAction, toWireResponse } from "./wire";

/**
 * Where a command came from: "host" over Native Messaging (the MCP Server,
 * wire action names only), "page" from the Extension's own pages (the popup,
 * which also uses internal names such as "status").
 */
export type CommandSource = "host" | "page";

/**
 * The answer to every command from the Native Host while the user has paused
 * agent actions in the popup (control-state.ts). The error starts with
 * "paused", and safetyDecision "paused" lets the MCP Server tell it from a
 * browser failure.
 */
export const PAUSED_REFUSAL: CommandResult = {
  success: false,
  safetyDecision: "paused",
  error: "paused: the user paused agent actions in the Inari MCP for Firefox toolbar popup",
};

export async function handleCommand(message: NativeMessage, source: CommandSource): Promise<CommandResult> {
  // Commands from the user's own pages (the popup) are not the agent's.
  if (source === "host" && isPaused()) {
    const refusal = { ...PAUSED_REFUSAL };
    postWireResponse(message, refusal);
    return refusal;
  }

  const finishHostCommand = source === "host" ? startHostCommand() : undefined;
  try {
    const checked = await checkCommand(message, source);
    const result = checked.kind === "refused" ? checked.result : await runChecked(checked);
    postWireResponse(message, result);
    return result;
  } finally {
    finishHostCommand?.();
  }
}

/** A command that passed every check: what its handler runs with. */
interface CheckedCommand {
  kind: "checked";
  /** Its row of the action table (undefined: a message without an action). */
  entry: ActionDescriptor | undefined;
  context: ActionContext;
}

/** A command refused before its handler ran. */
interface RefusedCommand {
  kind: "refused";
  result: CommandResult;
}

const refused = (result: CommandResult): RefusedCommand => ({ kind: "refused", result });

/**
 * Every check before the handler: the action name, the container scope, the
 * URL rules attached by the MCP Server, the blocked / allowed lists and the
 * human approval.
 */
async function checkCommand(message: NativeMessage, source: CommandSource): Promise<CheckedCommand | RefusedCommand> {
  const { data } = message;

  // Normalize the wire action name (snake_case) to the internal name once,
  // before any check, so every check and the handler see the same row of
  // the action table.
  const resolved = resolveWireAction(message.action, source === "host");
  if (resolved.kind === "notImplemented") {
    return refused({ success: false, error: `Not implemented in extension: ${resolved.wireName}` });
  }
  if (resolved.kind === "unknown") {
    return refused({ success: false, error: `Unknown action: ${resolved.wireName}` });
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
  // scope check, the approval check, the handler and the URL report
  // then all see the same tab, even if the active tab changes meanwhile.
  // Undefined when it cannot be resolved -- the checks then fail closed and
  // the handler reports the missing tab.
  let target: browser.tabs.Tab | undefined;
  if (singleTab) {
    try {
      target = await resolveTab(message.tabId);
    } catch {
      target = undefined;
    }
  }
  const tabId = target ? target.id : message.tabId;

  // Container scope check (Layer 0). The MCP Server attaches
  // `containerScope` to every command when container_scope.enabled is true.
  // A scope that is there but unusable fails closed, like the URL rules
  // below.
  const containerScope = parseContainerScope(message.containerScope);
  if (containerScope.kind === "invalid") {
    return refused({
      success: false,
      safetyDecision: "config_error",
      error:
        "Refused: the container scope attached by the MCP Server could not be used " +
        "(Extension and MCP Server versions may not match).",
    });
  }
  let scope: ScopeFilter | null = null;
  if (containerScope.kind === "scope") {
    const selfScoped = entry !== undefined && entry.scope !== "tab";
    const decision = await enforceContainerScope(selfScoped, target, containerScope.scope);
    if (!decision.allowed) return refused(outOfScope(decision.error));
    scope = decision.scope;
  }

  const policy = parseUrlPolicy(message);
  if (policy.invalid > 0) {
    return refused({
      success: false,
      safetyDecision: "config_error",
      error:
        `Refused: ${policy.invalid} URL pattern(s) attached by the MCP Server could not be used ` +
        "(Extension and MCP Server versions may not match).",
    });
  }
  const readRules = policy.readRules;
  const urlLists = policy.lists;
  // Site a human approved for this one call (MCP Server approval token).
  const approvedHost = typeof message.approvedHost === "string" ? message.approvedHost : undefined;

  // blocked / allowed lists against the real URL of the target tab (the
  // guard only knows the last URL it saw for the tab, if any). The server
  // attaches them to the commands its own tab check covers; the multi-tab
  // actions skip such tabs themselves. A human approval does not lift this.
  if (hasUrlLists(urlLists) && singleTab) {
    const refusal = checkListedTarget(target, urlLists);
    if (refusal) return refused(refusal);
  }

  // Human approval, against the real URL of the target tab (not the
  // server's last-seen URL, which is shared by every session) or the URL the
  // command opens. Acting rows need it always: the MCP Server cannot switch
  // this off. Reading rows need it only on a tab matching the attached
  // confirm_read_sites rules. The multi-tab rows (actPerTab, readPerTab)
  // apply it in their handlers; "none" rows change no page data.
  // A message without an action has no row: it is refused below
  // (UNKNOWN_ACTION) without reaching a handler that acts.
  const approval = entry?.approval;
  if (approval === "act" || approval === "actOnUrl" || approval === "read") {
    const refusal = checkApproval(approval, target, data, readRules, approvedHost);
    if (refusal) return refused(refusal);
  }

  return {
    kind: "checked",
    entry,
    context: {
      action,
      message,
      data,
      tabId,
      target,
      scope,
      readRules,
      approvedHost,
      urlLists,
      navigateInNewTab,
    },
  };
}

/** Run the handler of a checked command, then report the tab's URL. */
async function runChecked({ entry, context }: CheckedCommand): Promise<CommandResult> {
  const descriptor = entry ?? UNKNOWN_ACTION;
  const missingTabId =
    descriptor.scope === "tab" &&
    descriptor.needsTabId === true &&
    (context.tabId === undefined || context.message.tabId === undefined);
  let result: CommandResult;
  try {
    result = missingTabId ? { success: false, error: "tabId is required" } : await descriptor.handler(context);
  } catch (error) {
    result = { success: false, error: errorMessage(error) };
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
      const tab = await resolveTab(context.tabId);
      if (tab && tab.url) {
        result = { ...result, url: tab.url };
      }
    } catch {
      // Tab vanished -- report the result without a URL
    }
  }
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
