import { z } from 'zod';
import { READ_SELECTOR_RULE_TEXT, SCROLL_CAPTURE_LIMITS } from '@inari-mcp/shared';

// ---------------------------------------------------------------------------
// Tool classification (used by SafetyGuard and the MCP annotations)
// ---------------------------------------------------------------------------

/**
 * The single source of the tool classes; see tools/classification.ts for
 * what the SafetyGuard and the MCP annotations derive from it.
 *   - observe:  reads the page or browser state, changes nothing
 *   - interact: changes UI state only (scroll, overlay, active tab), never
 *               page data, and returns no page content; allowed in
 *               read-only mode
 *   - act:      changes page or browser state (input, navigation, tabs,
 *               and hover, which runs the page's own handlers)
 *   - wait / human: as named
 */
export type ToolClassification =
  | 'observe'
  | 'interact'
  | 'act'
  | 'wait'
  | 'human';

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

/** A z.object of any fields. Unlike z.AnyZodObject, its `shape` is typed (ZodRawShape, not any). */
export type ObjectSchema = z.ZodObject<z.ZodRawShape, z.UnknownKeysParam>;

/**
 * One operation. The public tools (public-tools.ts) run the operations and
 * carry the names and descriptions MCP clients see.
 */
export interface ToolDefinition {
  /**
   * Zod input schema. A public tool that is this operation as is lists it in
   * tools/list; a grouped one takes its variant's fields from it.
   */
  inputSchema: ObjectSchema;
  /**
   * Parses a call when the arguments have rules across fields that an
   * object schema cannot express (default: inputSchema). See callSchemaOf().
   */
  callSchema?: z.ZodType;
  /** Safety classification */
  classification: ToolClassification;
  /**
   * Per-tool exceptions to the MCP annotations derived from
   * `classification` (tools/classification.ts toolAnnotations()).
   */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /**
   * The tool does not act on the content of a tab, so the blocked/allowed
   * check of the tab's last-known URL does not apply (safety/guard.ts
   * TAB_INDEPENDENT_TOOLS, derived in tools/classification.ts).
   */
  tabIndependent?: true;
}

/** The schema a call of the operation is parsed with. */
export function callSchemaOf(def: ToolDefinition): z.ZodType {
  return def.callSchema ?? def.inputSchema;
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

/**
 * The fields whose value the tools mask (shared/src/field-mask.ts), for the
 * descriptions of the tools that return values.
 */
export const MASKED_FIELDS_NOTE =
  'password, hidden, one-time-code and payment card (autocomplete cc-*) fields, and the options of such a select';

/**
 * Shared by the tools whose CSS selector is checked before it is used
 * (reads, waits, scroll, highlight: shared/src/field-mask.ts
 * readSelectorProblem, and headless/helpers.ts playwrightDialectProblem).
 */
export const READ_SELECTOR_NOTE =
  `${READ_SELECTOR_RULE_TEXT} Headless: plain CSS only (no xpath=, text=, role=, //, >> or other Playwright selector forms).`;

/** Shared by the tools that find an element without reading it. */
export const ELEMENT_LOCATION_NOTE =
  "Returns at most the element's tag, generated selector and position, never its text, value or links.";

// =========================================================================
// Observe tools (read-only)
// =========================================================================

/** fox_screenshot scopes; each runs one browser action (handlers.ts). */
export const SCREENSHOT_SCOPES = ['viewport', 'full_page', 'all_tabs', 'scroll_capture'] as const;
export type ScreenshotScope = (typeof SCREENSHOT_SCOPES)[number];

/**
 * Upper bounds of scroll_capture (shared SCROLL_CAPTURE_LIMITS): the
 * schema refuses more steps or a longer delay, and the Extension also stops
 * after the budget of delays in total.
 */
const MAX_SCROLL_CAPTURE_STEPS = SCROLL_CAPTURE_LIMITS.MAX_SCROLLS;
const MAX_SCROLL_CAPTURE_DELAY_MS = SCROLL_CAPTURE_LIMITS.MAX_DELAY_MS;
/** The total of the delays of one scroll_capture (the Extension's budget), in seconds. */
const SCROLL_CAPTURE_BUDGET_S = SCROLL_CAPTURE_LIMITS.BUDGET_MS / 1_000;

const foxScreenshotSchema = z.object({
  scope: z.enum(SCREENSHOT_SCOPES)
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
  scrollStep: z.number().int().positive().optional().describe('Pixels to scroll each step (default: 80% of viewport)'),
  delay: z.number().int().min(0).max(MAX_SCROLL_CAPTURE_DELAY_MS).optional().default(500).describe(
    `Delay between scrolls in ms (for scroll_capture scope; at most ${MAX_SCROLL_CAPTURE_DELAY_MS}, ` +
    `and the delays stop after ${SCROLL_CAPTURE_BUDGET_S} s in total)`,
  ),
  maxScrolls: z.number().int().positive().max(MAX_SCROLL_CAPTURE_STEPS).optional().default(20).describe(
    `Maximum number of scroll steps (for scroll_capture scope; at most ${MAX_SCROLL_CAPTURE_STEPS}, ` +
    `fewer when the delays reach ${SCROLL_CAPTURE_BUDGET_S} s in total)`,
  ),
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
  limit: z.number().int().positive().optional().default(50).describe('Maximum elements to return'),
  tabId,
});

const foxGetTextSchema = z.object({
  selector: z.string().optional().describe('CSS selector; defaults to the whole page body'),
  maxLength: z.number().int().positive().optional().default(20000).describe('Truncate returned text to this many characters'),
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
  limit: z.number().int().positive().optional().default(50).describe('Max tabs to return'),
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
  url: z.string().optional().describe('URL to navigate to (required for goto; not allowed with the other actions)'),
  tabId,
  newTab: z.boolean().optional().default(false).describe('Open URL in new tab (for goto)'),
  waitForLoad: z.boolean().optional().default(true).describe('Wait for page to fully load'),
  bypassCache: z.boolean().optional().default(false).describe('Bypass browser cache (for refresh)'),
});

/**
 * goto needs a url; the other actions refuse one, so that a url they would
 * not use cannot decide which site the guard checks.
 */
const foxNavigateCallSchema = foxNavigateSchema.superRefine((args, ctx) => {
  const hasUrl = typeof args.url === 'string' && args.url !== '';
  if (navigateGoesToUrl(args.action)) {
    if (!hasUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required for goto' });
    }
  } else if (args.url !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: `url is only used by goto, not by ${args.action}; omit it (or use goto)`,
    });
  }
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
  index: z.number().int().min(0).optional().describe('Option index to select'),
  tabId,
});

const foxHoverSchema = z.object({
  selector: z.string().describe('CSS selector for the element'),
  tabId,
});

/** The directions fox_scroll accepts (the headless backend checks the same list). */
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right', 'top', 'bottom'] as const;

const foxScrollSchema = z.object({
  direction: z.enum(SCROLL_DIRECTIONS).optional().describe('Scroll direction'),
  amount: z.number().int().min(0).optional().default(300).describe('Scroll amount in pixels'),
  selector: z.string().optional().describe('CSS selector for scrollable element'),
  toElement: z.string().optional().describe('CSS selector of element to scroll into view'),
  tabId,
});

const foxHighlightSchema = z.object({
  selector: z.string().describe('CSS selector for the element'),
  duration: z.number().int().positive().optional().default(3000).describe('Highlight duration in ms'),
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

/** 0.2.0: the window states fox_tab action "window" accepts. */
export const WINDOW_STATES = ['maximized', 'normal', 'fullscreen'] as const;

const foxSetWindowStateSchema = z.object({
  state: z.enum(WINDOW_STATES).optional().default('maximized').describe(
    "Window state: 'maximized' (default), 'normal' (restore) or 'fullscreen'",
  ),
  tabId: z.number().int().optional().describe('Tab whose window to change (defaults to the active tab)'),
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
  idleTime: z.number().int().min(0).optional().default(500).describe('How long network must be idle (ms)'),
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
// Dialog tool
// =========================================================================

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

const OPERATIONS = {
  // --- Observe ---
  fox_screenshot: {
    inputSchema: foxScreenshotSchema,
    classification: 'observe',
  },
  fox_snapshot: {
    inputSchema: foxSnapshotSchema,
    classification: 'observe',
  },
  fox_get_elements: {
    inputSchema: foxGetElementsSchema,
    classification: 'observe',
  },
  fox_get_text: {
    inputSchema: foxGetTextSchema,
    classification: 'observe',
  },
  fox_find_text: {
    inputSchema: foxFindTextSchema,
    classification: 'observe',
  },
  fox_get_page_info: {
    inputSchema: foxGetPageInfoSchema,
    classification: 'observe',
  },
  fox_get_tabs: {
    inputSchema: foxGetTabsSchema,
    classification: 'observe',
    tabIndependent: true,
  },

  // --- Act ---
  fox_navigate: {
    inputSchema: foxNavigateSchema,
    callSchema: foxNavigateCallSchema,
    classification: 'act',
  },
  fox_click: {
    inputSchema: foxClickSchema,
    classification: 'act',
  },
  fox_type: {
    inputSchema: foxTypeSchema,
    classification: 'act',
  },
  fox_press_key: {
    inputSchema: foxPressKeySchema,
    classification: 'act',
  },
  fox_set_value: {
    inputSchema: foxSetValueSchema,
    classification: 'act',
  },
  fox_select_option: {
    inputSchema: foxSelectOptionSchema,
    classification: 'act',
  },
  fox_hover: {
    inputSchema: foxHoverSchema,
    classification: 'act',
    annotations: { destructiveHint: false },
  },
  fox_scroll: {
    inputSchema: foxScrollSchema,
    classification: 'interact',
  },
  fox_highlight: {
    inputSchema: foxHighlightSchema,
    classification: 'interact',
  },
  fox_create_tab: {
    inputSchema: foxCreateTabSchema,
    classification: 'act',
    annotations: { destructiveHint: false },
    tabIndependent: true,
  },
  fox_close_tab: {
    inputSchema: foxCloseTabSchema,
    classification: 'act',
    tabIndependent: true,
  },
  fox_switch_tab: {
    inputSchema: foxSwitchTabSchema,
    classification: 'interact',
    tabIndependent: true,
  },
  // 0.2.0: fox_tab action "window". Changes the browser's UI only, so it is
  // class interact like fox_switch_tab (no approval, allowed in read-only mode).
  fox_set_window_state: {
    inputSchema: foxSetWindowStateSchema,
    classification: 'interact',
    tabIndependent: true,
  },

  // --- Wait ---
  fox_wait_for_element: {
    inputSchema: foxWaitForElementSchema,
    classification: 'wait',
  },
  fox_wait_for_network_idle: {
    inputSchema: foxWaitForNetworkIdleSchema,
    classification: 'wait',
  },
  fox_wait_for_navigation: {
    inputSchema: foxWaitForNavigationSchema,
    classification: 'wait',
  },
  fox_wait_for_url: {
    inputSchema: foxWaitForUrlSchema,
    classification: 'wait',
  },

  // --- Dialog ---
  fox_handle_dialog: {
    inputSchema: foxHandleDialogSchema,
    classification: 'act',
  },

  // --- Human ---
  fox_request_approval: {
    inputSchema: foxRequestApprovalSchema,
    classification: 'human',
  },
  fox_detect_captcha: {
    inputSchema: foxDetectCaptchaSchema,
    classification: 'human',
    annotations: { readOnlyHint: true },
  },

  // --- Container (Firefox contextualIdentities) ---
  fox_list_containers: {
    inputSchema: foxListContainersSchema,
    classification: 'observe',
    tabIndependent: true,
  },
  fox_open_in_container: {
    inputSchema: foxOpenInContainerSchema,
    classification: 'act',
    annotations: { destructiveHint: false },
    tabIndependent: true,
  },

  // --- Safety (always registered) ---
  fox_safety_status: {
    inputSchema: foxSafetyStatusSchema,
    classification: 'observe',
    tabIndependent: true,
  },
} satisfies Record<string, ToolDefinition>;

/** An operation: one entry of TOOL_SCHEMAS, run by a public tool (public-tools.ts). */
export type OperationName = keyof typeof OPERATIONS;

/** Whether `name` (a name from the wire) is an operation. */
export function isOperationName(name: string): name is OperationName {
  return Object.hasOwn(OPERATIONS, name);
}

/** Every operation name, in definition order. */
export const OPERATION_NAMES: readonly OperationName[] = Object.keys(OPERATIONS).filter(isOperationName);

/**
 * The operations by name. Keyed by string so that a name from the wire can
 * be looked up; code that knows an operation uses OperationName and
 * isOperationName().
 */
export const TOOL_SCHEMAS: Readonly<Record<string, ToolDefinition>> = OPERATIONS;

/** The server-internal tool that is always registered (registry.ts). */
export const SAFETY_STATUS_TOOL = 'fox_safety_status' satisfies OperationName;
