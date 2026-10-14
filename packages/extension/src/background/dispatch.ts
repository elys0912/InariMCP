// Command dispatcher (L4): one command from the Native Host or the popup,
// through the checks (pause switch, container scope, URL lists, human
// approval) to its handler, and the response back over Native Messaging.
// A pause stops the commands from the Native Host that are still running.
// Which checks apply to an action, and its handler, come from the action
// table (action-table.ts). While a command from the Native Host runs, the
// toolbar badge shows it (setup-badge.ts).

import { errorMessage } from "../error-message";
import type { CompiledUrlRule } from "../url-rule";
import { describeAction, UNKNOWN_ACTION, type ActionContext, type ActionDescriptor } from "./action-table";
import { parseContainerScope, enforceContainerScope, outOfScope } from "./container-scope";
import { isPaused, pauseSignal } from "./control-state";
import { postToHost } from "./native-connection";
import { startHostCommand } from "./setup-badge";
import { abortContentCommands, resolveTab } from "./tab-target";
import type { NativeMessage, CommandResult, ScopeFilter, UrlLists } from "./types";
import { parseUrlPolicy, hasUrlLists, checkListedTarget, checkApproval, isUpfrontApproval } from "./url-policy";
import { resolveWireAction, toWireResponse } from "./wire";

/**
 * Where a command came from: "host" over Native Messaging (the MCP Server,
 * wire action names only), "page" from the Extension's own pages (the popup,
 * which also uses internal names such as "status").
 */
export type CommandSource = "host" | "page";

/**
 * The answer to every command from the Native Host while the user has paused
 * agent actions in the popup (control-state.ts), and to those still running
 * when the pause comes. The error starts with
 * "paused", and safetyDecision "paused" lets the MCP Server tell it from a
 * browser failure.
 */
export const PAUSED_REFUSAL: CommandResult = {
  success: false,
  safetyDecision: "paused",
  error: "paused: the user paused agent actions in the Inari MCP for Firefox toolbar popup",
};

export async function handleCommand(message: NativeMessage, source: CommandSource): Promise<CommandResult> {
  // Commands from the user's own pages (the popup) are not the agent's: the
  // pause switch does not apply to them.
  const result = source === "host" ? await runHostCommand(message) : await runCommand(message, source);
  postWireResponse(message, result);

  return result;
}

/** Check a command, then run its handler. */
async function runCommand(message: NativeMessage, source: CommandSource): Promise<CommandResult> {
  const checked = await checkCommand(message, source);
  return checked.kind === "refused" ? checked.result : runChecked(checked);
}

/**
 * A command from the Native Host. The pause switch is looked at when it
 * arrives (refused before anything runs, not shown as running), again after
 * the checks (they wait on the browser) and before the answer. A pause while
 * the handler runs answers at once (untilPaused).
 */
async function runHostCommand(message: NativeMessage): Promise<CommandResult> {
  if (isPaused()) return { ...PAUSED_REFUSAL };

  const finishHostCommand = startHostCommand();
  try {
    const checked = await checkCommand(message, "host");
    if (isPaused()) return { ...PAUSED_REFUSAL };
    if (checked.kind === "refused") return checked.result;

    const result = await untilPaused(runChecked(checked), checked.context.tabId);
    return isPaused() ? { ...PAUSED_REFUSAL } : result;
  } finally {
    finishHostCommand();
  }
}

/**
 * `running`, or PAUSED_REFUSAL as soon as agent actions are paused. The
 * handler is not waited for then: the content script of `tabId` is told to
 * stop, and its typing, waits and scroll_and_capture end at their next step
 * (content/abort.ts).
 */
function untilPaused(running: Promise<CommandResult>, tabId: number | undefined): Promise<CommandResult> {
  const signal = pauseSignal();
  return new Promise((resolve) => {
    const onPause = (): void => {
      if (tabId !== undefined) void abortContentCommands(tabId);
      resolve({ ...PAUSED_REFUSAL });
    };
    signal.addEventListener("abort", onPause, { once: true });
    void running
      .then(resolve, (error: unknown) => resolve({ success: false, error: errorMessage(error) }))
      .finally(() => signal.removeEventListener("abort", onPause));
  });
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
 * Every check before the handler, in this order: the action name, the
 * container scope, the URL rules attached by the MCP Server, the blocked /
 * allowed lists and the human approval. The first refusal ends it.
 */
async function checkCommand(message: NativeMessage, source: CommandSource): Promise<CheckedCommand | RefusedCommand> {
  const route = routeCommand(message, source);
  if (route.kind === "refused") return route;

  const target = route.entry?.scope === "tab" ? await pinTargetTab(message.tabId) : undefined;
  const scope = await checkContainerScope(message, route.entry, target);
  if (scope.kind === "refused") return scope;

  const policy = checkUrlPolicy(message, route.entry, target);
  if (policy.kind === "refused") return policy;

  return {
    kind: "checked",
    entry: route.entry,
    context: {
      action: route.action,
      message,
      data: message.data,
      tabId: target ? target.id : message.tabId,
      target,
      scope: scope.filter,
      readRules: policy.readRules,
      approvedHost: policy.approvedHost,
      urlLists: policy.urlLists,
      navigateInNewTab: route.navigateInNewTab,
    },
  };
}

/** The action a command runs: its internal name and its row of the action table. */
interface RoutedCommand {
  kind: "routed";
  /** Internal action name (undefined: a message without an action). */
  action: string | undefined;
  entry: ActionDescriptor | undefined;
  /** fox_navigate with newTab, routed as createTab. */
  navigateInNewTab: boolean;
}

/**
 * The internal action of `resolved` (an internal name, wire.ts): fox_navigate
 * with newTab opens the URL in a fresh tab, so it is routed as createTab. The
 * scope check then treats it like fox_create_tab: the new tab is born inside
 * the agent container instead of requiring the current active tab to be in
 * scope.
 */
export function routeAction(
  resolved: string | undefined,
  data: NativeMessage["data"],
): { action: string | undefined; navigateInNewTab: boolean } {
  const navigateInNewTab = resolved === "navigate" && data?.newTab === true;
  return { action: navigateInNewTab ? "createTab" : resolved, navigateInNewTab };
}

/**
 * Normalize the wire action name (snake_case) to the internal name once,
 * before any check, so every check and the handler see the same row of the
 * action table.
 */
function routeCommand(message: NativeMessage, source: CommandSource): RoutedCommand | RefusedCommand {
  const resolved = resolveWireAction(message.action, source === "host");
  if (resolved.kind === "notImplemented") {
    return refused({ success: false, error: `Not implemented in extension: ${resolved.wireName}` });
  }
  if (resolved.kind === "unknown") {
    return refused({ success: false, error: `Unknown action: ${resolved.wireName}` });
  }

  const { action, navigateInNewTab } = routeAction(resolved.action, message.data);
  // Row of the action table (fail closed: an unknown name gets the strictest
  // row, UNKNOWN_ACTION). A message without an action has no row: it skips
  // the tab checks, is checked strictly by the container scope, and ends in
  // UNKNOWN_ACTION's refusal.
  const entry = action === undefined ? undefined : describeAction(action);
  return { kind: "routed", action, entry, navigateInNewTab };
}

/**
 * The target tab of a single-tab action, resolved ONCE (explicit tabId, else
 * the active tab of the current window) and pinned: the container scope
 * check, the approval check, the handler and the URL report then all see the
 * same tab, even if the active tab changes meanwhile. Undefined when it
 * cannot be resolved -- the checks then fail closed and the handler reports
 * the missing tab.
 */
async function pinTargetTab(tabId: number | undefined): Promise<browser.tabs.Tab | undefined> {
  try {
    return await resolveTab(tabId);
  } catch {
    return undefined;
  }
}

/** A command inside the container scope: the filter its handler gets (null when the scope is off). */
interface ScopedCommand {
  kind: "scoped";
  filter: ScopeFilter | null;
}

/**
 * Container scope check (Layer 0). The MCP Server attaches `containerScope`
 * to every command when container_scope.enabled is true. A scope that is
 * there but unusable fails closed, like the URL rules.
 */
async function checkContainerScope(
  message: NativeMessage,
  entry: ActionDescriptor | undefined,
  target: browser.tabs.Tab | undefined,
): Promise<ScopedCommand | RefusedCommand> {
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
  if (containerScope.kind !== "scope") return { kind: "scoped", filter: null };

  const selfScoped = entry !== undefined && entry.scope !== "tab";
  const decision = await enforceContainerScope(selfScoped, target, containerScope.scope);
  if (!decision.allowed) return refused(outOfScope(decision.error));

  return { kind: "scoped", filter: decision.scope };
}

/** A command the URL policy lets through: the rules its handler gets. */
interface AllowedCommand {
  kind: "allowed";
  readRules: CompiledUrlRule[];
  urlLists: UrlLists;
  /** Site a human approved for this one call (MCP Server approval token). */
  approvedHost: string | undefined;
}

/**
 * The URL policy attached by the MCP Server (an unusable rule fails closed),
 * the blocked / allowed lists, then the human approval.
 */
function checkUrlPolicy(
  message: NativeMessage,
  entry: ActionDescriptor | undefined,
  target: browser.tabs.Tab | undefined,
): AllowedCommand | RefusedCommand {
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
  const approvedHost = typeof message.approvedHost === "string" ? message.approvedHost : undefined;

  // blocked / allowed lists against the real URL of the target tab (the
  // guard only knows the last URL it saw for the tab, if any). The server
  // attaches them to the commands its own tab check covers; the multi-tab
  // actions skip such tabs themselves. A human approval does not lift this.
  const listRefusal =
    hasUrlLists(policy.lists) && entry?.scope === "tab" ? checkListedTarget(target, policy.lists) : null;
  if (listRefusal) return refused(listRefusal);

  // Human approval, against the real URL of the target tab (not the
  // server's last-seen URL, which is shared by every session) or the URL the
  // command opens. Acting rows need it always: the MCP Server cannot switch
  // this off. Reading rows need it only on a tab matching the attached
  // confirm_read_sites rules. A message without an action has no row: it is
  // refused later (UNKNOWN_ACTION) without reaching a handler that acts.
  const approval = entry?.approval;
  const approvalRefusal = isUpfrontApproval(approval)
    ? checkApproval(approval, { tab: target, data: message.data, readRules: policy.readRules, approvedHost })
    : null;
  if (approvalRefusal) return refused(approvalRefusal);

  return { kind: "allowed", readRules: policy.readRules, urlLists: policy.lists, approvedHost };
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
