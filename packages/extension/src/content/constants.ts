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

/** DOM id of the captcha wait banner (solveCaptcha, cancelHumanWait). */
export const CAPTCHA_BANNER_ID = "__fox_captcha_banner";

// Message types and log limits shared with the background (../wire-messages.ts).
export { LOG_RECORD_MESSAGE, LOGGING_STATE_QUERY, LOG_ENTRY_LIMIT, LOG_TEXT_LIMIT } from "../wire-messages";
