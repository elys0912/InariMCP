// Which checks of handleCommand apply to which internal action (L0, data).
// The scope check's default deny relies on isSingleTabAction: an action in
// none of the sets is a single-tab action.

/**
 * Actions that apply `protectedUrlPatterns` in their own handler instead of
 * being refused up front: all_tabs, reload_all and reload_by_url skip
 * protected tabs, start_logging refuses on its own tab, get_*_logs report a
 * pause.
 */
export const SELF_PROTECTED_ACTIONS: ReadonlySet<string> = new Set([
  "screenshotAllTabs",
  "reloadAll",
  "reloadByUrl",
  "startLogging",
  "getConsoleLogs",
  "getNetworkLogs",
]);

/**
 * Actions that do not target a single tab and enforce the scope themselves
 * (by filtering tabs / containers, or by choosing the container of a new
 * tab). Every other action is treated as single-tab and checked up front,
 * so unknown actions fall into the strict branch (default deny).
 */
export const SCOPE_SELF_ENFORCED_ACTIONS: ReadonlySet<string> = new Set([
  // multi-tab: targets / results filtered to the agent container
  "getTabs",
  "findTabs",
  "screenshotAllTabs",
  "reloadAll",
  "reloadByUrl",
  // new tab: created inside the agent container
  "createTab",
  // container management: restricted to the agent container
  "list_containers",
  "open_in_container",
]);

/**
 * Actions that touch no tab and no container at all. Approval requests are
 * shown in the toolbar popup, and cancel_human_wait only withdraws a wait
 * the command it cancels already passed the scope check for.
 */
export const SCOPE_NO_TAB_ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "requestApproval",
  "cancelHumanWait",
]);

/** Internal action that targets one tab (the strict branch of the scope check). */
export function isSingleTabAction(action: string): boolean {
  return !SCOPE_SELF_ENFORCED_ACTIONS.has(action) && !SCOPE_NO_TAB_ACTIONS.has(action);
}
