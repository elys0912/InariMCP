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
} as const;

export const TOP_FRAME_ID = 0;

/** Message type of the content script's "is logging on for my tab?" query. */
export const LOGGING_STATE_QUERY = "kitsune:loggingState";

/** content → background: `{ type, console?: entry[], network?: entry[] }`. */
export const LOG_RECORD_MESSAGE = "kitsune:logRecords";
