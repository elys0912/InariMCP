// Constants of the content script modules (no side effects).

export const TIMEOUTS = {
  DEFAULT: 10_000,
  WAIT_ELEMENT: 10_000,
  NETWORK_IDLE: 10_000,
  CAPTCHA: 180_000,
  SCROLL_STEP: 500,
  /** fox_type: all per-character delays together (see typingDelay). */
  TYPING_BUDGET: 10_000,
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

/** Same string as LOG_RECORD_MESSAGE in background/constants.ts. */
export const LOG_RECORD_MESSAGE = "kitsune:logRecords";

// Message type used to ask the background script whether logging is on
// for this tab (same string as LOGGING_STATE_QUERY in background/constants.ts).
export const LOGGING_STATE_QUERY = "kitsune:loggingState";
