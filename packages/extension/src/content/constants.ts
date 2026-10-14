// Constants of the content script modules (no side effects).

export const TIMEOUTS = {
  DEFAULT: 10_000,
  WAIT_ELEMENT: 10_000,
  NETWORK_IDLE: 10_000,
  CAPTCHA: 180_000,
  SCROLL_STEP: 500,
  /**
   * scroll_and_capture: all the steps' delays together. Inside the MCP
   * Server's command timeout (30 s), so the capture ends before the server
   * stops waiting for it.
   */
  SCROLL_CAPTURE_BUDGET: 25_000,
  /** fox_type: all per-character delays together (see typingDelay). */
  TYPING_BUDGET: 10_000,
  /** fox_click_and_wait without waitTimeout. */
  CLICK_AND_WAIT: 5_000,
  /** fox_highlight without duration. */
  HIGHLIGHT: 3_000,
} as const;

/** Pauses and poll intervals (ms). */
export const DELAYS = {
  /** Poll interval of waitForElement (default), waitForNetworkIdle and clickAndWait. */
  POLL: 100,
  /** After scrollIntoView, before acting on the element (click, type, hover). */
  SCROLL_INTO_VIEW: 100,
  /** Between mousedown and mouseup of a click. */
  MOUSE_DOWN_UP: 50,
  /** After fox_scroll to an element. */
  SCROLL_TO_ELEMENT: 500,
  /** After fox_scroll by direction or to a position. */
  SCROLL_SETTLE: 300,
  /** Check of the captcha response tokens while the banner is shown. */
  CAPTCHA_POLL: 1_000,
  /** fox_wait_for_network_idle without idleTime: no request this long. */
  NETWORK_IDLE_TIME: 500,
  /** clickAndWait without waitForSelector: no new DOM change this long ends the wait. */
  CLICK_SETTLE: 500,
} as const;

/** Defaults of tool arguments the command does not give. */
export const DEFAULTS = {
  /** fox_type: delay between characters (ms, see typingDelay). */
  TYPING_DELAY: 50,
  /** fox_scroll by direction: pixels. */
  SCROLL_AMOUNT: 300,
  /** get_elements: elements returned. */
  ELEMENTS_LIMIT: 50,
  /** fox_get_text: characters returned. */
  TEXT_MAX_LENGTH: 20_000,
  /** scroll_and_capture: scroll steps. */
  SCROLL_CAPTURE_MAX_SCROLLS: 20,
  /** scroll_and_capture step: this share of the viewport height. */
  SCROLL_CAPTURE_STEP_RATIO: 0.8,
} as const;

/** Counts and lengths (characters) that cut what is returned or kept. */
export const LIMITS = {
  /** getPageInfo: interactive elements looked at, and the text / value of each. */
  PAGE_INFO_ELEMENTS: 100,
  PAGE_INFO_TEXT: 100,
  /** getPageInfo: fields per form, and the value of each. */
  FORM_FIELDS: 20,
  FORM_FIELD_VALUE: 50,
  /** getPageInfo: headings, and the text of each. */
  HEADINGS: 20,
  HEADING_TEXT: 100,
  /** scroll_and_capture: visible elements per snapshot, and the text of each. */
  SNAPSHOT_ELEMENTS: 50,
  SNAPSHOT_TEXT: 50,
  /** Element info (getElementInfo): text and value. */
  ELEMENT_TEXT: 200,
  /** Matches of a text locator looked at (findByText). */
  TEXT_MATCHES: 50,
  /** Classes of one element in a generated selector. */
  SELECTOR_CLASSES: 2,
  /** clickAndWait: changes returned. */
  CLICK_WAIT_CHANGES: 20,
  /** scroll_and_capture: the page counts as scrolled to the end this close (px). */
  SCROLL_END_SLACK: 10,
  /**
   * scroll_and_capture: most steps, and the longest delay of one step (ms),
   * whatever the command asks for (scrollCaptureLimits).
   */
  SCROLL_CAPTURE_MAX_SCROLLS: 50,
  SCROLL_CAPTURE_MAX_DELAY: 2_000,
} as const;

export const INTERACTIVE_SELECTORS = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[onclick]",
  '[role="button"]',
  '[role="link"]',
  '[tabindex]:not([tabindex="-1"])',
] as const;

/** Look of the fox_highlight overlay (highlightElement). */
export const HIGHLIGHT_STYLE = {
  /** Border, and background of the label. */
  COLOR: "#7c3aed",
  /** The same color, translucent: fill of the overlay, and its glow. */
  FILL: "rgba(124, 58, 237, 0.1)",
  GLOW: "rgba(124, 58, 237, 0.5)",
  /** Above the page's own content. */
  Z_INDEX: 999_999,
} as const;

/**
 * `type` of the background → content message that stops the commands running
 * in the frame (the pause switch, abort.ts). Not a ContentAction: handler.ts
 * answers it before any command handler.
 */
export const ABORT_REQUEST_TYPE = "inari:content:abort";

/** DOM id of the captcha wait banner (solveCaptcha, cancelHumanWait). */
export const CAPTCHA_BANNER_ID = "__fox_captcha_banner";
