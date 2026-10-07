import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tool classification (used by SafetyGuard and the MCP annotations)
// ---------------------------------------------------------------------------

/**
 * The single source of the tool classes; see tools/classification.ts for
 * what the SafetyGuard and the MCP annotations derive from it.
 *   - observe:  reads the page or browser state, changes nothing
 *   - interact: changes UI state only (hover, scroll, overlay, active tab),
 *               never page data; allowed in read-only mode
 *   - act:      changes page or browser state (input, navigation, tabs)
 *   - script:   runs caller-supplied JavaScript
 *   - wait / logging / workflow / human: as named
 */
export type ToolClassification =
  | 'observe'
  | 'interact'
  | 'act'
  | 'script'
  | 'wait'
  | 'logging'
  | 'workflow'
  | 'human';

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  /** fox_* prefixed tool name */
  name: string;
  /** MCP tool description (English) */
  description: string;
  /** Zod input schema for validation */
  inputSchema: z.ZodType;
  /** Safety classification */
  classification: ToolClassification;
  /**
   * Per-tool exceptions to the MCP annotations derived from
   * `classification` (tools/classification.ts toolAnnotations()).
   */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

/** Common element locator fields shared across many tools */
const elementLocator = {
  selector: z.string().optional().describe('CSS selector'),
  xpath: z.string().optional().describe('XPath expression'),
  text: z.string().optional().describe(
    'Visible text of the element: the innermost element whose whole text contains it ' +
    '(case-sensitive; enabled, visible matches first). Top document only: not inside iframes or shadow DOM',
  ),
};

const tabId = z.number().int().optional().describe('Tab ID (defaults to active tab)');
/**
 * Upper bound of every timeout argument. The Native Host keeps a command's
 * bookkeeping (the requested screenshot filename) for 10 minutes
 * (native-host/src/host.ts IN_FLIGHT_TTL_MS); the daemon waits up to
 * argument + 5 s, so 580 s keeps that inside the 10 minutes.
 */
export const MAX_TIMEOUT_ARG_MS = 580_000;

const timeoutMs = z.number().int().positive().max(MAX_TIMEOUT_ARG_MS).optional()
  .describe(`Timeout in milliseconds (at most ${MAX_TIMEOUT_ARG_MS})`);

/** Shared by every urlPattern argument (same on the Extension and headless). */
const URL_PATTERN_NOTE =
  'JavaScript regex, case-sensitive, unanchored (matches anywhere in the full URL); ' +
  'use [Ee]xample for a case-insensitive part.';

// =========================================================================
// Observe tools (read-only)
// =========================================================================

const foxScreenshotSchema = z.object({
  scope: z.enum(['viewport', 'full_page', 'all_tabs', 'scroll_capture'])
    .optional()
    .default('viewport')
    .describe('Capture scope: viewport (default), full_page, all_tabs, or scroll_capture'),
  tabId,
  saveToFile: z.boolean().optional().default(true).describe(
    'Save the image to a file and return it as a resource_link (default). Images are never returned ' +
    'inline, so false captures nothing and only returns the tab info (headless: ignored, always saved)',
  ),
  filename: z.string().optional().describe('Optional filename for saved screenshot'),
  // all_tabs options
  urlPattern: z.string().optional().describe(`all_tabs: only tabs whose URL matches this regex. ${URL_PATTERN_NOTE}`),
  includeData: z.boolean().optional().default(false).describe(
    'No effect: base64 image data is never returned; all_tabs images are saved to files like the others',
  ),
  timeout: timeoutMs.describe('all_tabs: time budget for capturing all tabs in ms (default 20000); tabs left when it runs out are reported as skipped'),
  // scroll_capture options
  scrollStep: z.number().int().optional().describe('Pixels to scroll each step (default: 80% of viewport)'),
  delay: z.number().int().optional().default(500).describe('Delay between scrolls in ms (for scroll_capture scope)'),
  maxScrolls: z.number().int().optional().default(20).describe('Maximum number of scroll steps (for scroll_capture scope)'),
  restore: z.boolean().optional().default(true).describe('Restore original scroll position after capture'),
});

const foxSnapshotSchema = z.object({
  tabId,
  selector: z.string().optional().describe('CSS selector to snapshot a subtree (defaults to full page)'),
  maxDepth: z.number().int().positive().optional().describe('Maximum tree depth to traverse'),
  includeText: z.boolean().optional().default(true).describe('Include text content in snapshot nodes'),
  roles: z.array(z.string()).optional().describe('Filter to specific ARIA roles (e.g. ["button", "link"])'),
});

const foxGetElementsSchema = z.object({
  selector: z.string().describe('CSS selector to find elements'),
  limit: z.number().int().optional().default(50).describe('Maximum elements to return'),
  tabId,
});

const foxGetTextSchema = z.object({
  selector: z.string().optional().describe('CSS selector; defaults to the whole page body'),
  maxLength: z.number().int().optional().default(20000).describe('Truncate returned text to this many characters'),
  tabId,
});

const foxFindTextSchema = z.object({
  query: z.string().describe('Text to search for in the page'),
  caseSensitive: z.boolean().optional().default(false).describe('Case-sensitive search'),
  entireWord: z.boolean().optional().default(false).describe('Match entire words only'),
  includeRectData: z.boolean().optional().default(false).describe('Include bounding rect data for matches'),
  tabId,
});

const foxGetPageInfoSchema = z.object({
  tabId,
});

const foxGetTabsSchema = z.object({
  currentWindowOnly: z.boolean().optional().default(true).describe('Only list tabs in the current window'),
  limit: z.number().int().optional().default(50).describe('Max tabs to return'),
  urlPattern: z.string().optional().describe(`Only tabs whose URL matches this regex, before applying limit. ${URL_PATTERN_NOTE}`),
  includeFavicon: z.boolean().optional().default(false).describe('Include favIconUrl per tab'),
});

// =========================================================================
// Act tools (state-changing)
// =========================================================================

/** fox_navigate actions; only goto takes a `url`. */
export const NAVIGATE_ACTIONS = ['goto', 'back', 'forward', 'refresh', 'hard_refresh'] as const;
export type NavigateAction = (typeof NAVIGATE_ACTIONS)[number];

/**
 * Whether fox_navigate goes to its `url` argument: only for goto, the
 * default action. back / forward / refresh / hard_refresh act on the tab
 * as it is. The single rule behind the call schema below and the guard's
 * targetUrlOf() (safety/guard.ts).
 */
export function navigateGoesToUrl(action: unknown): boolean {
  return (action ?? 'goto') === 'goto';
}

const foxNavigateSchema = z.object({
  action: z.enum(NAVIGATE_ACTIONS)
    .optional()
    .default('goto')
    .describe('Navigation action type'),
  url: z.string().optional().describe('URL to navigate to (required for goto)'),
  tabId,
  newTab: z.boolean().optional().default(false).describe('Open URL in new tab (for goto)'),
  waitForLoad: z.boolean().optional().default(true).describe('Wait for page to fully load'),
  bypassCache: z.boolean().optional().default(false).describe('Bypass browser cache (for refresh)'),
});

const foxClickSchema = z.object({
  ...elementLocator,
  x: z.number().optional().describe('X coordinate to click'),
  y: z.number().optional().describe('Y coordinate to click'),
  tabId,
  doubleClick: z.boolean().optional().default(false).describe('Perform double-click'),
  rightClick: z.boolean().optional().default(false).describe('Perform right-click'),
});

const foxTypeSchema = z.object({
  text: z.string().describe('Text to type (never used to find the element)'),
  selector: z.string().optional().describe('CSS selector for the input element'),
  placeholder: z.string().optional().describe('Placeholder text to find the input'),
  name: z.string().optional().describe('Name attribute of the input'),
  id: z.string().optional().describe('ID of the input element'),
  tabId,
  clear: z.boolean().optional().default(false).describe('Clear existing content first'),
  pressEnter: z.boolean().optional().default(false).describe(
    'Press Enter after typing. In a form field this also submits the form the way a real Enter does ' +
    '(unless a keydown handler cancels it); the result reports it in `enter`',
  ),
  delay: z.number().int().min(0).optional().default(50).describe(
    'Delay between keystrokes in ms (0 = none). Reduced automatically so that all delays together stay within 10 s',
  ),
});

const foxPressKeySchema = z.object({
  key: z.string().describe("Key to press, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'a'"),
  ...elementLocator,
  id: z.string().optional().describe('ID of the element'),
  ctrl: z.boolean().optional().default(false).describe('Hold Ctrl'),
  shift: z.boolean().optional().default(false).describe('Hold Shift'),
  alt: z.boolean().optional().default(false).describe('Hold Alt'),
  meta: z.boolean().optional().default(false).describe('Hold Meta/Cmd'),
  tabId,
});

const foxSetValueSchema = z.object({
  selector: z.string().describe('CSS selector for the input element'),
  value: z.string().describe('Value to set'),
  tabId,
});

const foxSelectOptionSchema = z.object({
  selector: z.string().describe('CSS selector for the select element'),
  value: z.string().optional().describe('Option value to select'),
  text: z.string().optional().describe('Option text to select'),
  index: z.number().int().optional().describe('Option index to select'),
  tabId,
});

const foxHoverSchema = z.object({
  selector: z.string().describe('CSS selector for the element'),
  tabId,
});

const foxScrollSchema = z.object({
  direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).optional().describe('Scroll direction'),
  amount: z.number().int().optional().default(300).describe('Scroll amount in pixels'),
  selector: z.string().optional().describe('CSS selector for scrollable element'),
  toElement: z.string().optional().describe('CSS selector of element to scroll into view'),
  tabId,
});

const foxHighlightSchema = z.object({
  selector: z.string().describe('CSS selector for the element'),
  duration: z.number().int().optional().default(3000).describe('Highlight duration in ms'),
  label: z.string().optional().describe('Label to show above the element'),
  tabId,
});

const foxCreateTabSchema = z.object({
  url: z.string().optional().default('about:blank').describe('URL to open in the new tab'),
  active: z.boolean().optional().default(true).describe('Make the new tab active'),
});

const foxCloseTabSchema = z.object({
  tabId: z.number().int().describe('ID of the tab to close'),
});

const foxSwitchTabSchema = z.object({
  tabId: z.number().int().describe('ID of the tab to focus/activate'),
});

// =========================================================================
// Wait tools
// =========================================================================

const foxWaitForElementSchema = z.object({
  selector: z.string().describe('CSS selector for the element'),
  timeout: timeoutMs.default(10000),
  visible: z.boolean().optional().default(true).describe('Wait for element to be visible'),
  tabId,
});

const foxWaitForNetworkIdleSchema = z.object({
  timeout: timeoutMs.default(10000),
  idleTime: z.number().int().optional().default(500).describe('How long network must be idle (ms)'),
  tabId,
});

const foxWaitForNavigationSchema = z.object({
  timeout: timeoutMs.default(30000),
  waitUntil: z.enum(['load', 'domcontentloaded']).optional().default('load')
    .describe('When to consider navigation complete'),
  urlPattern: z.string().optional().describe(`Regex the URL of the navigation must match (other navigations are skipped). ${URL_PATTERN_NOTE}`),
  tabId,
});

const foxWaitForUrlSchema = z.object({
  url: z.string().optional().describe('Exact URL to wait for'),
  urlPattern: z.string().optional().describe(`Regex the tab URL must match. ${URL_PATTERN_NOTE}`),
  timeout: timeoutMs.default(15000),
  tabId,
});

// =========================================================================
// Logging tools
// =========================================================================

const foxStartLoggingSchema = z.object({
  clearExisting: z.boolean().optional().default(false).describe('Clear any existing logs before starting'),
  tabId,
});

const foxStopLoggingSchema = z.object({
  tabId,
});

const foxGetConsoleLogsSchema = z.object({
  level: z.enum(['log', 'warn', 'error', 'info', 'debug']).optional().describe('Filter by log level'),
  search: z.string().optional().describe('Filter logs containing this text'),
  limit: z.number().int().optional().default(100).describe('Maximum number of logs to return'),
  tabId,
});

const foxGetNetworkLogsSchema = z.object({
  urlPattern: z.string().optional().describe(`Only requests whose URL matches this regex. ${URL_PATTERN_NOTE}`),
  method: z.string().optional().describe('Filter by HTTP method (GET, POST, etc.)'),
  status: z.number().int().optional().describe('Filter by HTTP status code'),
  errorsOnly: z.boolean().optional().default(false).describe('Only return failed requests'),
  limit: z.number().int().optional().default(100).describe('Maximum number of logs to return'),
  tabId,
});

const foxClearLogsSchema = z.object({
  console: z.boolean().optional().default(true).describe('Clear console logs'),
  network: z.boolean().optional().default(true).describe('Clear network logs'),
  tabId,
});

// =========================================================================
// Script tools (require fox_allow_scripts)
// =========================================================================

const foxExecuteScriptSchema = z.object({
  script: z.string().describe('JavaScript code to execute'),
  tabId,
});

const evalStepSchema = z.object({
  script: z.string().describe('JavaScript expression to evaluate'),
  label: z.string().optional().describe('Human-readable label for this step'),
  captureConsole: z.boolean().optional().default(true).describe('Capture console output for this step'),
  stopOnError: z.boolean().optional().default(true).describe('Abort chain if this step throws'),
});

const foxEvalChainSchema = z.object({
  steps: z.array(evalStepSchema).min(1).describe(
    'Ordered list of JS expressions to evaluate. Each step receives the prior result as `$prev`.',
  ),
  tabId,
});

const foxInjectObserverSchema = z.object({
  selector: z.string().optional().default('body').describe('Root element to observe'),
  observerId: z.string().optional().describe('ID for this observer (to remove it later)'),
  observeAttributes: z.boolean().optional().default(true).describe('Observe attribute changes'),
  observeChildList: z.boolean().optional().default(true).describe('Observe child list changes'),
  observeSubtree: z.boolean().optional().default(true).describe('Observe subtree changes'),
  tabId,
});

const foxRemoveObserverSchema = z.object({
  observerId: z.string().describe('ID of the observer to remove'),
  tabId,
});

// =========================================================================
// Workflow tools
// =========================================================================

const workflowAssertSchema = z.object({
  urlContains: z.string().optional().describe('Current URL must contain this substring'),
  textContains: z.string().optional().describe('Visible page text must contain this substring'),
  selectorExists: z.string().optional().describe('This CSS selector must match at least one element'),
});

const workflowStepSchema = z.object({
  label: z.string().optional().describe('Human-readable step name'),
  tool: z.string().describe('Browser tool to call, e.g. fox_navigate, fox_click, fox_type'),
  arguments: z.record(z.unknown()).optional().describe('Arguments for the tool'),
  assert: workflowAssertSchema.optional().describe('Checks to run after the step succeeds'),
});

const foxRunWorkflowSchema = z.object({
  steps: z.array(workflowStepSchema).min(1).describe('Ordered workflow steps'),
  stopOnFailure: z.boolean().optional().default(true).describe('Stop at the first failing step'),
  screenshotOnFailure: z.boolean().optional().default(true).describe('Capture a screenshot when a step fails'),
});

const foxAuditPageSchema = z.object({
  screenshot: z.boolean().optional().default(true).describe('Also capture a screenshot'),
  fullPage: z.boolean().optional().default(false).describe('Make the screenshot full-page'),
  tabId,
});

const foxWaitAndActSchema = z.object({
  condition: z.string().describe('JS expression that returns truthy when ready'),
  actionScript: z.string().describe('JS to run once condition is met'),
  pollIntervalMs: z.number().int().optional().default(200).describe('How often to check condition'),
  timeoutMs: z.number().int().max(MAX_TIMEOUT_ARG_MS).optional().default(15000)
    .describe(`Max wait time in ms before giving up (at most ${MAX_TIMEOUT_ARG_MS})`),
  tabId,
});

const foxHandleDialogSchema = z.object({
  action: z.enum(['accept', 'dismiss']).describe('Whether to accept or dismiss the dialog'),
  promptText: z.string().optional().describe('Text to enter in a prompt dialog before accepting'),
  timeout: timeoutMs.default(5000),
  tabId,
});

// =========================================================================
// Human tools
// =========================================================================

const foxRequestApprovalSchema = z.object({
  message: z.string().describe('What you are asking permission to do, in plain language'),
  detail: z.string().optional().describe('Optional extra context shown in smaller text'),
  timeout: timeoutMs.default(60000),
  tabId,
});

const foxDetectCaptchaSchema = z.object({
  timeout: timeoutMs.default(180000),
  tabId,
});

// =========================================================================
// Container tools (Firefox contextualIdentities, implemented in P7)
// =========================================================================

const foxListContainersSchema = z.object({});

const foxOpenInContainerSchema = z.object({
  url: z.string().describe('URL to open in the container tab'),
  containerName: z.string().optional().describe('Container name to use (creates if not found)'),
  cookieStoreId: z.string().optional().describe('cookieStoreId of an existing container (e.g. "firefox-container-1", as returned by fox_list_containers). Takes precedence over containerName'),
  active: z.boolean().optional().default(true).describe('Make the new tab active'),
});

// =========================================================================
// Safety (always registered)
// =========================================================================

const foxSafetyStatusSchema = z.object({});

// ===========================================================================
// TOOL_SCHEMAS registry
// ===========================================================================

export const TOOL_SCHEMAS: Record<string, ToolDefinition> = {
  // --- Observe ---
  fox_screenshot: {
    name: 'fox_screenshot',
    description:
      'Take a screenshot. scope: viewport (visible area; a background tab given by tabId is captured without switching to it; a discarded tab fails), full_page (entire scrollable page; falls back to the visible area when it cannot, fullPageCaptured=false), all_tabs (every tab, or those whose URL matches the urlPattern regex, within the timeout budget; tabs on protected sites are skipped; fails when no tab could be captured), scroll_capture (takes NO images: scrolls the page and returns the interactive elements visible at each position). Images are saved to files and returned as resource_link, never as base64; saveToFile=false captures nothing, includeData has no effect, and the same filename overwrites the file. Headless: viewport and full_page only.',
    inputSchema: foxScreenshotSchema,
    classification: 'observe',
  },
  fox_snapshot: {
    name: 'fox_snapshot',
    description:
      'Extension path: not implemented (returns an error); use fox_get_page_info, fox_get_elements or fox_get_text there. Headless: returns the accessibility tree of the page (or of the first element matching selector) as indented YAML text (Playwright ariaSnapshot), filtered by maxDepth, includeText and roles, cut at 50000 characters.',
    inputSchema: foxSnapshotSchema,
    classification: 'observe',
  },
  fox_get_elements: {
    name: 'fox_get_elements',
    description:
      'List elements matching a CSS selector (querySelectorAll: the first `limit` matches, plus the total count). Per element: tag, id, classes, name, type, text (first 200 chars), value (password fields masked), href, src, placeholder, ariaLabel, role, disabled, checked, visible, position (viewport coordinates incl. centerX/centerY) and a generated CSS selector. Headless: tag, text and bounding box only, at most 50.',
    inputSchema: foxGetElementsSchema,
    classification: 'observe',
  },
  fox_get_text: {
    name: 'fox_get_text',
    description:
      'Extract the visible text content of the page or a specific element. Lighter-weight than a screenshot for reading page content.',
    inputSchema: foxGetTextSchema,
    classification: 'observe',
  },
  fox_find_text: {
    name: 'fox_find_text',
    description:
      'Search for text in the page using the native browser.find API (Firefox-only). Works across frames and finds text outside the viewport without DOM traversal. Returns match count and optionally bounding rects.',
    inputSchema: foxFindTextSchema,
    classification: 'observe',
  },
  fox_get_page_info: {
    name: 'fox_get_page_info',
    description:
      'Get an overview of the current page: URL, title, document/viewport size, scroll position, up to 100 visible interactive elements (tag, type, id, name, text, href, value, placeholder, ariaLabel, center position, generated selector), forms with their first 20 fields, and h1-h3 headings. Password values are masked. Not in any FOX_CAPS profile. Headless: URL and title only.',
    inputSchema: foxGetPageInfoSchema,
    classification: 'observe',
  },
  fox_get_tabs: {
    name: 'fox_get_tabs',
    description:
      'List open browser tabs: id, url, title, active, windowId, pinned, status (loading/complete), audible; plus totals and a summary. Defaults to the current window and at most 50 tabs. Use urlPattern (regex, applied before limit) to filter, currentWindowOnly=false for all windows, includeFavicon=true for favicon URLs. Headless: id, url, title and active only; arguments are ignored.',
    inputSchema: foxGetTabsSchema,
    classification: 'observe',
  },

  // --- Act ---
  fox_navigate: {
    name: 'fox_navigate',
    description:
      "Navigate in the browser. Actions: 'goto' (open a URL), 'back' / 'forward' (history navigation), 'refresh' (reload page), 'hard_refresh' (bypass cache, like Ctrl+Shift+R). goto / refresh with waitForLoad, and back / forward always, fail when the page does not finish loading within 25 s or the tab is closed (the navigation itself may still complete).",
    inputSchema: foxNavigateSchema,
    classification: 'act',
  },
  fox_click: {
    name: 'fox_click',
    description:
      'Click an element, located by selector (CSS), xpath, text or x+y viewport coordinates, checked in that order. Works in the top document only (not inside iframes or shadow DOM); fails on a disabled element. The element is scrolled into view and receives synthetic mousedown/mouseup/click events (isTrusted=false, not a real OS click; pages that require real user input may ignore it). doubleClick/rightClick send dblclick/contextmenu instead. Returns the clicked element\'s info. Headless: selector or x+y only.',
    inputSchema: foxClickSchema,
    classification: 'act',
  },
  fox_type: {
    name: 'fox_type',
    description:
      'Type text into an input, textarea or contenteditable element, located by selector, id, name or placeholder (in that order); without any of them, types into the focused field. The `text` value is never used to find the element. Fails on a disabled element; password fields are refused. Types character by character with synthetic key events (isTrusted=false), waiting `delay` ms per character (0 = none; shortened so all delays stay within 10 s); fox_set_value is faster for long values. clear empties the field first. pressEnter also submits the enclosing form like a real Enter (unless a keydown handler cancels it). Headless: selector and text only (with selector the field is filled, else the focused element receives the keys).',
    inputSchema: foxTypeSchema,
    classification: 'act',
  },
  fox_press_key: {
    name: 'fox_press_key',
    description:
      'Press a keyboard key with optional modifiers (Ctrl, Shift, Alt, Meta) on the element located by selector (CSS), xpath, text or id (checked in that order; it is focused first), else on the focused element. The key events are synthetic (isTrusted=false): page handlers see them, but the browser performs no default action (no focus move on Tab, no scrolling, no browser shortcuts). Plain Enter in a form field submits the form like a real Enter. Headless: selector only.',
    inputSchema: foxPressKeySchema,
    classification: 'act',
  },
  fox_set_value: {
    name: 'fox_set_value',
    description:
      'Set the value of an input, textarea, select or contenteditable element directly (no key events), then dispatch input and change events. Faster than fox_type and suited to long values. Reports success even when the element is of another kind (nothing changes) or, for a select, when no option has that value. Password fields are refused. Not in any FOX_CAPS profile.',
    inputSchema: foxSetValueSchema,
    classification: 'act',
  },
  fox_select_option: {
    name: 'fox_select_option',
    description:
      'Select an option in a dropdown/select element by value, visible text, or index.',
    inputSchema: foxSelectOptionSchema,
    classification: 'act',
  },
  fox_hover: {
    name: 'fox_hover',
    description:
      'Hover over an element to trigger hover effects, tooltips, or dropdown menus. Dispatches synthetic mouseenter / mouseover events (isTrusted=false): JavaScript hover handlers run, CSS :hover styles do not apply.',
    inputSchema: foxHoverSchema,
    classification: 'interact',
  },
  fox_scroll: {
    name: 'fox_scroll',
    description:
      'Scroll the page or a specific element in any direction, or scroll a target element into view.',
    inputSchema: foxScrollSchema,
    classification: 'interact',
  },
  fox_highlight: {
    name: 'fox_highlight',
    description:
      'Highlight an element on the page with a colored overlay for visual debugging. Optionally show a label.',
    inputSchema: foxHighlightSchema,
    classification: 'interact',
  },
  fox_create_tab: {
    name: 'fox_create_tab',
    description: 'Create a new browser tab, optionally with a URL.',
    inputSchema: foxCreateTabSchema,
    classification: 'act',
    annotations: { destructiveHint: false },
  },
  fox_close_tab: {
    name: 'fox_close_tab',
    description: 'Close a browser tab by its tab ID.',
    inputSchema: foxCloseTabSchema,
    classification: 'act',
  },
  fox_switch_tab: {
    name: 'fox_switch_tab',
    description: 'Focus/activate a browser tab by its tab ID.',
    inputSchema: foxSwitchTabSchema,
    classification: 'interact',
  },

  // --- Wait ---
  fox_wait_for_element: {
    name: 'fox_wait_for_element',
    description:
      'Wait for an element matching a CSS selector to appear (and optionally become visible) on the page.',
    inputSchema: foxWaitForElementSchema,
    classification: 'wait',
  },
  fox_wait_for_network_idle: {
    name: 'fox_wait_for_network_idle',
    description:
      'Wait until the page\'s own fetch/XHR requests (top frame) have been idle for idleTime ms. Use after actions that trigger API calls. Requests made by fox_execute_script, and requests already in flight before the first call on this page, are not seen. Fails when the network does not become idle within the timeout. Headless: uses Playwright\'s networkidle; idleTime is ignored.',
    inputSchema: foxWaitForNetworkIdleSchema,
    classification: 'wait',
  },
  fox_wait_for_navigation: {
    name: 'fox_wait_for_navigation',
    description:
      'Wait for the tab\'s next top-level navigation to finish (waitUntil: load or domcontentloaded), optionally only one whose URL matches the urlPattern regex. Only navigations that finish after this call count: a fast navigation already done (e.g. right after fox_click) is missed and the call times out. When the destination URL is known, prefer fox_wait_for_url, which returns at once if the URL already matches. Headless: waitUntil and urlPattern are ignored.',
    inputSchema: foxWaitForNavigationSchema,
    classification: 'wait',
  },
  fox_wait_for_url: {
    name: 'fox_wait_for_url',
    description:
      'Wait until the current URL matches an exact string or regex pattern. Useful for waiting on redirects or SPA route changes.',
    inputSchema: foxWaitForUrlSchema,
    classification: 'wait',
  },

  // --- Logging ---
  fox_start_logging: {
    name: 'fox_start_logging',
    description:
      'Start capturing console logs and fetch/XHR requests of the tab (top frame). Use before performing actions you want to monitor. Logs are kept per tab across reloads and navigations (the newest 500 console and 500 network entries) until fox_clear_logs or the tab is closed. Refused on a protected site unless approved; recording pauses while the tab is on one. Not supported in headless mode.',
    inputSchema: foxStartLoggingSchema,
    classification: 'logging',
  },
  fox_stop_logging: {
    name: 'fox_stop_logging',
    description:
      'Stop capturing console logs and network requests on this tab. Logs are preserved and can still be retrieved (until fox_clear_logs or the tab is closed). Not supported in headless mode.',
    inputSchema: foxStopLoggingSchema,
    classification: 'logging',
  },
  fox_get_console_logs: {
    name: 'fox_get_console_logs',
    description:
      'Return console messages captured since fox_start_logging on this tab (the most recent `limit`, filtered by level and/or a case-insensitive search text). Captured: page calls to console.log/warn/error/info/debug in the top frame only; not uncaught exceptions, browser errors, iframes, or console.log inside fox_execute_script. Kept per tab across reloads and navigations (the newest 500) until fox_clear_logs or the tab is closed. currentPageReached=false means the current page could not be asked for its latest entries. Paused while the tab is on a protected site. Not supported in headless mode.',
    inputSchema: foxGetConsoleLogsSchema,
    classification: 'logging',
    annotations: { readOnlyHint: true },
  },
  fox_get_network_logs: {
    name: 'fox_get_network_logs',
    description:
      'Return fetch/XHR requests captured since fox_start_logging on this tab (the most recent `limit`), filtered by URL regex, HTTP method, status code, or errors only (network error or status >= 400). Images, scripts, CSS and WebSocket traffic are not captured. Authorization, cookie, API-key and token headers and secret fields in URLs and bodies are masked; other headers and bodies (truncated) are returned as recorded. Kept per tab across navigations like the console logs. Not supported in headless mode.',
    inputSchema: foxGetNetworkLogsSchema,
    classification: 'logging',
    annotations: { readOnlyHint: true },
  },
  fox_clear_logs: {
    name: 'fox_clear_logs',
    description:
      'Clear captured console and/or network logs of this tab. Not supported in headless mode.',
    inputSchema: foxClearLogsSchema,
    classification: 'logging',
  },

  // --- Script ---
  fox_execute_script: {
    name: 'fox_execute_script',
    description:
      'Run JavaScript in the tab\'s top frame and return the value of the last expression (use a JSON-compatible value; a top-level `return` is not allowed, wrap code in an IIFE). Extension path: runs in the content script\'s isolated world; it sees the page DOM, but not variables or functions defined by the page\'s own scripts, and its console.log and fetch/XHR are not captured by the logging tools. Headless: runs in the page\'s own world (Playwright page.evaluate). Refused when script execution is disabled (allow_script_execution in safety.json or FOX_ALLOW_SCRIPTS=0).',
    inputSchema: foxExecuteScriptSchema,
    classification: 'script',
  },
  fox_eval_chain: {
    name: 'fox_eval_chain',
    description:
      'Extension path: not implemented (returns an error). Headless only: evaluate a sequence of JavaScript expressions in the page; each step receives the prior result as `$prev`, and console output is captured per step.',
    inputSchema: foxEvalChainSchema,
    classification: 'script',
  },
  fox_inject_observer: {
    name: 'fox_inject_observer',
    description:
      'Start a MutationObserver on an element (default body) that collects DOM changes (attributes, child list, subtree). The changes are returned by fox_remove_observer (the last 100). The observer ends when the page reloads or navigates. Requires script execution enabled. Headless: one observer per page (a new call replaces it, observerId is ignored); changes collect in window.__fox_mutations.',
    inputSchema: foxInjectObserverSchema,
    classification: 'script',
  },
  fox_remove_observer: {
    name: 'fox_remove_observer',
    description:
      'Remove an observer started by fox_inject_observer and get the changes it collected (the last 100). Fails when no observer with that ID exists on the current page. Headless: observerId is ignored and only the number of changes is returned.',
    inputSchema: foxRemoveObserverSchema,
    classification: 'script',
    annotations: { destructiveHint: false },
  },

  // --- Workflow ---
  fox_run_workflow: {
    name: 'fox_run_workflow',
    description:
      'Not implemented yet on any backend: always returns an error. Call the individual tools instead.',
    inputSchema: foxRunWorkflowSchema,
    classification: 'workflow',
  },
  fox_audit_page: {
    name: 'fox_audit_page',
    description:
      'Not implemented yet on any backend: always returns an error. Use fox_get_page_info, fox_get_elements and fox_screenshot instead.',
    inputSchema: foxAuditPageSchema,
    classification: 'observe',
  },
  fox_wait_and_act: {
    name: 'fox_wait_and_act',
    description:
      'Extension path: not implemented (returns an error). Headless only: poll the page until a JS condition is truthy, then run actionScript and return its result. Use for waiting on async UI state.',
    inputSchema: foxWaitAndActSchema,
    classification: 'script',
  },
  fox_handle_dialog: {
    name: 'fox_handle_dialog',
    description:
      'Extension path: not implemented (returns an error; commands to a tab showing an alert/confirm/prompt time out there). Headless only: wait for the next dialog and accept or dismiss it (promptText for prompts). Call it before the action that opens the dialog: it does not block other commands, and when no dialog comes within timeout it arms itself for the next dialog on the tab (30 s). Dialogs nobody handles are dismissed automatically after 2 s and reported in the next result of that tab. Not in any FOX_CAPS profile.',
    inputSchema: foxHandleDialogSchema,
    classification: 'act',
  },

  // --- Human ---
  fox_request_approval: {
    name: 'fox_request_approval',
    description:
      'Ask the human at the browser a yes/no question and wait for the answer. Shown in the KitsuneMCP toolbar popup in Firefox (badge + OS notification), never in the page. The answer is for you only: it does not unlock protected-site actions — those ask the human on their own when you call the tool. Unavailable in headless mode.',
    inputSchema: foxRequestApprovalSchema,
    classification: 'human',
  },
  fox_detect_captcha: {
    name: 'fox_detect_captcha',
    description:
      'Detect captchas on the page (reCAPTCHA, hCaptcha, Cloudflare Turnstile, generic image captchas). Reports what was found so the human can be asked to solve it. Does NOT auto-solve.',
    inputSchema: foxDetectCaptchaSchema,
    classification: 'human',
    annotations: { readOnlyHint: true },
  },

  // --- Container (Firefox contextualIdentities) ---
  fox_list_containers: {
    name: 'fox_list_containers',
    description:
      'List Firefox container identities (contextualIdentities). Returns name, color, icon, and cookieStoreId for each container. When container scope is enabled in safety.json, only the agent container is returned.',
    inputSchema: foxListContainersSchema,
    classification: 'observe',
  },
  fox_open_in_container: {
    name: 'fox_open_in_container',
    description:
      'Open a URL in a Firefox container tab. Specify the container by containerName (created if not found) or by cookieStoreId (must already exist). Provides isolated cookies/storage via the contextualIdentities API. When container scope is enabled in safety.json, only the agent container is allowed.',
    inputSchema: foxOpenInContainerSchema,
    classification: 'act',
    annotations: { destructiveHint: false },
  },

  // --- Safety (always registered) ---
  fox_safety_status: {
    name: 'fox_safety_status',
    description:
      'Show the active safety guard policy: read-only mode, script toggle, protected/blocked/allowed URL patterns, rate-limit state, and audit log location.',
    inputSchema: foxSafetyStatusSchema,
    classification: 'observe',
  },
};
