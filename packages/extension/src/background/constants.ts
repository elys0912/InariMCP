// Constants shared by the background modules (L0, no side effects).

export const TIMEOUTS = {
  COMMAND: 30_000,
  RECONNECT_MAX: 30_000,
  RECONNECT_INITIAL: 1_000,
  /** fox_wait_for_navigation without a timeout argument. */
  NAVIGATION: 30_000,
  /**
   * Load wait of navigate / refresh / new tab. Shorter than the daemon's 30 s
   * default for these commands, so the Extension reports the timeout itself.
   */
  PAGE_LOAD: 25_000,
  /** No "loading" status this long after tabs.update / reload: nothing to load. */
  TAB_LOAD_SETTLE: 1_000,
  /** One tabs.captureTab call of screenshot all_tabs. */
  CAPTURE_TAB: 5_000,
  /** Whole screenshot all_tabs run without a timeout argument (< daemon 30 s). */
  ALL_TABS_BUDGET: 20_000,
  /** request_approval without a timeout argument (popup wait). */
  APPROVAL: 60_000,
  /** fox_wait_for_url without a timeout argument. */
  WAIT_FOR_URL: 15_000,
  /** After the last reconnect attempt gave up: start a fresh cycle. */
  RECONNECT_RESTART: 60_000,
  /** sendToNativeHost: wait before the next attempt when not connected or posting failed. */
  SEND_RETRY_DELAY: 1_000,
  /** sendToNativeHost: wait for connectNativeHost() before checking the port again. */
  CONNECT_SETTLE: 500,
} as const;

/** Growth of the reconnect delay per attempt (up to TIMEOUTS.RECONNECT_MAX). */
export const RECONNECT_BACKOFF_FACTOR = 1.5;

export const TOP_FRAME_ID = 0;

/** Defaults of tool arguments the command does not give. */
export const DEFAULTS = {
  /** fox_tabs list: tabs returned. */
  TABS_LIMIT: 50,
  SCREENSHOT_FORMAT: "png",
  SCREENSHOT_QUALITY: 90,
} as const;

/** Counts and lengths (characters) that cut what is kept or shown. */
export const LIMITS = {
  /** Approval question in the desktop notification. */
  APPROVAL_NOTIFICATION_TEXT: 160,
  /** Console summary of a Native Messaging frame: action / requestId length, key names listed. */
  NATIVE_SUMMARY_TEXT: 64,
  NATIVE_SUMMARY_KEYS: 20,
  /** sendToNativeHost: attempts after the first when not connected or posting fails. */
  SEND_RETRIES: 3,
} as const;
