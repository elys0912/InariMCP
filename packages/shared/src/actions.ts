import { z } from 'zod';

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
  'execute_script',

  // --- Tab management ---
  'get_tabs',
  'get_tab_info',
  'find_tabs',
  'screenshot_all_tabs',
  'create_tab',
  'close_tab',
  'focus_tab',

  // --- Form / input ---
  'get_value',
  'set_value',
  'select_option',
  'hover',

  // --- Reload / navigation ---
  'refresh',
  'hard_refresh',
  'reload_all',
  'reload_by_url',
  'go_back',
  'go_forward',

  // --- Wait / observe ---
  'wait_for_change',
  'wait_for_network_idle',
  'observe_element',
  'stop_observing',
  'scroll_and_capture',
  'click_and_wait',

  // --- Console / network logging ---
  'start_logging',
  'stop_logging',
  'get_console_logs',
  'get_network_logs',
  'clear_logs',

  // --- Advanced scripting ---
  'eval_chain',
  'wait_and_act',
  'press_key',
  'get_text',

  // --- Approval / workflow ---
  'request_approval',
  'run_workflow',
  'solve_captcha',
  /**
   * Internal, not a tool: sent by the MCP Server when it gave up waiting on
   * request_approval / solve_captcha, so the Extension withdraws the banner.
   * data.requestId = the timed-out command's requestId.
   */
  'cancel_human_wait',
  'audit_page',
  'inject_observer',

  // --- New actions (P3-3) ---
  'snapshot',
  'find_text',
  'handle_dialog',
  'list_containers',
  'open_in_container',
  'wait_for_navigation',
  'wait_for_url',
  'remove_observer',
] as const;

/** Union type of all valid browser action names */
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** Zod schema that validates a string as a known browser action */
export const BrowserActionSchema = z.enum(BROWSER_ACTIONS);
