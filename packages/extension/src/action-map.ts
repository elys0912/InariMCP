// InariMCP wire action map
//
// The MCP Server sends BrowserCommand.action in snake_case (the values of
// BROWSER_ACTIONS in packages/shared/src/actions.ts). The background script's
// dispatcher uses its own internal names (mostly camelCase, inherited from
// the fork source). This table converts wire names to internal names once,
// at the entry of handleCommand().
//
// Value semantics:
//   string -> internal action name: a row of the action table
//             (background/action-table.ts), which holds the checks and the
//             handler of each internal action
//   null   -> known wire action that the extension does not implement yet
//             (answered with "Not implemented in extension: <name>", which is
//             distinct from "Unknown action")
//
// Imported by background/wire.ts (bundled into dist/background.js); the
// contract tests import WIRE_ACTION_MAP the same way.
//
// Every entry of BROWSER_ACTIONS must appear here, and nothing else, and
// every internal name must be a row of the action table: checked by the type
// below (`satisfies`) and by the contract test. Only types are imported, so
// this file adds nothing from packages/shared or background/ to the bundle
// (and stays loadable on its own by the contract tests).

import type { BrowserAction } from "@inari-mcp/shared/action-names";
import type { InternalAction } from "./background/action-table";

const WIRE_ACTIONS = {
  // --- Page interaction ---
  screenshot: "screenshot",
  click: "click",
  type: "type",
  scroll: "scroll",
  navigate: "navigate",
  get_page_info: "getPageInfo",
  get_elements: "getElements",
  wait_for_element: "waitForElement",
  highlight: "highlight",

  // --- Tab management ---
  get_tabs: "getTabs",
  screenshot_all_tabs: "screenshotAllTabs",
  create_tab: "createTab",
  close_tab: "closeTab",
  focus_tab: "focusTab",

  // --- Form / input ---
  set_value: "setValue",
  select_option: "selectOption",
  hover: "hover",

  // --- Reload / navigation ---
  refresh: "refresh",
  hard_refresh: "hardRefresh",
  go_back: "goBack",
  go_forward: "goForward",

  // --- Wait / observe ---
  wait_for_network_idle: "waitForNetworkIdle",
  scroll_and_capture: "scrollAndCapture",

  // --- Keyboard / text ---
  press_key: "pressKey",
  get_text: "getText",

  // --- Approval / workflow ---
  request_approval: "requestApproval",
  run_workflow: null,
  solve_captcha: "solveCaptcha",
  cancel_human_wait: "cancelHumanWait",
  audit_page: null,

  // --- P3-3 actions (container / find keep their snake_case internal names) ---
  snapshot: null,
  find_text: "find_text",
  handle_dialog: null,
  list_containers: "list_containers",
  open_in_container: "open_in_container",
  wait_for_navigation: "waitForNavigation",
  wait_for_url: "waitForUrl",
} as const satisfies Record<BrowserAction, InternalAction | null>;

export const WIRE_ACTION_MAP: ReadonlyMap<string, string | null> = new Map<string, string | null>(
  Object.entries(WIRE_ACTIONS),
);
