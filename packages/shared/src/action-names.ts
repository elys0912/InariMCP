// Zod-free on purpose: the Extension bundles this module (see
// packages/shared/package.json "sideEffects" and scripts/build-extension.mjs),
// and zod would add about 110 KB to its scripts. Keep it free of imports.

/**
 * Browser command action names.
 *
 * These are the action strings sent as BrowserCommand.action from the MCP
 * Server to the Extension (or headless backend).
 *
 * Note: these are NOT MCP tool names (those carry the `fox_` prefix).
 */
export const BROWSER_ACTIONS = [
  // --- Page interaction ---
  'screenshot',
  'click',
  'type',
  'scroll',
  'navigate',
  'get_page_info',
  'get_elements',
  'wait_for_element',
  'highlight',

  // --- Tab management ---
  'get_tabs',
  'screenshot_all_tabs',
  'create_tab',
  'close_tab',
  'focus_tab',
  // 0.2.0: fox_tab action "window" (maximize / restore / fullscreen the tab's window).
  'set_window_state',

  // --- Form / input ---
  'set_value',
  'select_option',
  'hover',

  // --- Reload / navigation ---
  'refresh',
  'hard_refresh',
  'go_back',
  'go_forward',

  // --- Wait / observe ---
  'wait_for_network_idle',
  'scroll_and_capture',

  // --- Keyboard / text ---
  'press_key',
  'get_text',

  // --- Approval ---
  'request_approval',
  'solve_captcha',
  /**
   * Internal, not a tool: sent by the MCP Server when it gave up waiting on
   * request_approval / solve_captcha, so the Extension withdraws the banner.
   * data.requestId = the timed-out command's requestId.
   */
  'cancel_human_wait',

  // --- Snapshot, find, dialogs, containers, navigation and URL waits ---
  'snapshot',
  'find_text',
  'handle_dialog',
  'list_containers',
  'open_in_container',
  'wait_for_navigation',
  'wait_for_url',
] as const;

/** Union type of all valid browser action names */
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/**
 * Upper bounds of scroll_capture (the screenshot scope; the browser action
 * scrollAndCapture), so that one call cannot keep the user's tab scrolling
 * for long: the MCP Server's schema refuses more (mcp-server
 * tools/schemas.ts), and the Extension's content script cuts a command to
 * them (content/inspect.ts scrollCaptureLimits).
 *   MAX_SCROLLS   steps: 2.5 times the default 20
 *   MAX_DELAY_MS  the delay between two steps: 4 times the default 500 ms
 *   BUDGET_MS     all the delays together, the one before the first step
 *                 included: 5 s under the daemon's command timeout (30 s),
 *                 for the work of each step, so the answer comes before the
 *                 daemon stops waiting
 */
export const SCROLL_CAPTURE_LIMITS = {
  MAX_SCROLLS: 50,
  MAX_DELAY_MS: 2_000,
  BUDGET_MS: 25_000,
} as const;
