// Zod-free on purpose: the Extension bundles this module (see
// packages/shared/package.json "sideEffects" and scripts/build-extension.mjs),
// and zod would add about 110 KB to its scripts. Keep it free of imports.

/**
 * Browser command action names.
 *
 * These are the action strings sent as BrowserCommand.action from the MCP
 * Server to the Extension (or headless backend). They map 1:1 to the
 * fork-source server.py _dispatch_action routing table.
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

  // --- New actions (P3-3) ---
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
