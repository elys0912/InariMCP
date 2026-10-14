// Constants of the content script modules (no side effects).

export const TIMEOUTS = {
  WAIT_ELEMENT: 10_000,
  NETWORK_IDLE: 10_000,
  CAPTCHA: 180_000,
  SCROLL_STEP: 500,
  /**
   * scroll_and_capture: all the delays together, the one before the first
   * step included. 5 s under the MCP Server's command timeout (30 s), for
   * the work of each step, so the capture ends before the server stops
   * waiting for it.
   */
  SCROLL_CAPTURE_BUDGET: 25_000,
  /** fox_type: all per-character delays together (see typingDelay). */
  TYPING_BUDGET: 10_000,
  /** fox_highlight without duration. */
  HIGHLIGHT: 3_000,
} as const;

/** Pauses and poll intervals (ms). */
export const DELAYS = {
  /** Poll interval of waitForElement (default) and waitForNetworkIdle. */
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
  /** scroll_and_capture: scroll steps when the command gives none. */
  SCROLL_CAPTURE_SCROLLS: 20,
  /** scroll_and_capture step: this share of the viewport height. */
  SCROLL_CAPTURE_STEP_RATIO: 0.8,
} as const;

/** Counts, lengths (characters) and durations (ms) that cut what is returned, kept or waited for. */
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
  /** scroll_and_capture: the page counts as scrolled to the end this close (px). */
  SCROLL_END_SLACK: 10,
  /**
   * scroll_and_capture: most steps, and the longest delay of one step (ms),
   * whatever the command asks for (scrollCaptureLimits). 50 steps are
   * 2.5 times the default 20; a delay of 2 s still leaves 11 steps in
   * TIMEOUTS.SCROLL_CAPTURE_BUDGET.
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

/**
 * Look of the highlight overlay (highlightElement). It is set on the element
 * itself (style attribute and element.animate): the add-on puts no stylesheet
 * into pages, whose class or keyframe names a page could probe for.
 */
export const HIGHLIGHT_STYLE = {
  /** Border, and background of the label. */
  COLOR: "#7c3aed",
  /** The same color, translucent: fill of the overlay, and its glow. */
  FILL: "rgba(124, 58, 237, 0.1)",
  GLOW: "rgba(124, 58, 237, 0.5)",
  /** Blur radius of the glow, in px. */
  GLOW_BLUR: 10,
  /** The glow at the peak of each pulse: color and blur radius (px). */
  GLOW_PEAK: "rgba(124, 58, 237, 0.8)",
  GLOW_PEAK_BLUR: 20,
  /** One pulse of the glow (out and back). */
  PULSE_MS: 1_500,
  /** Above the page's own content. */
  Z_INDEX: 999_999,
} as const;

/**
 * `type` of the background → content message that stops the commands running
 * in the frame (the pause switch, abort.ts), with the background's
 * `pauseCount`. Not a ContentAction: handler.ts answers it before any
 * command handler.
 */
export const ABORT_REQUEST_TYPE = "inari:content:abort";

/** DOM id of the captcha wait banner (solveCaptcha, cancelHumanWait). */
export const CAPTCHA_BANNER_ID = "__fox_captcha_banner";
