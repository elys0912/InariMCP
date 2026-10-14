export const ENV_PREFIX = 'FOX_' as const;

/** Highest TCP port number (ports are 1..MAX_PORT). */
export const MAX_PORT = 65_535;

/** Milliseconds per second, for converting timestamps and durations. */
export const MS_PER_SECOND = 1_000;

export const ENV = {
  FOX_PORT: 'FOX_PORT',
  FOX_HOST: 'FOX_HOST',
  FOX_HTTP_PORT: 'FOX_HTTP_PORT',
  FOX_WS_PORT: 'FOX_WS_PORT',
  FOX_CAPS: 'FOX_CAPS',
  FOX_HEADLESS: 'FOX_HEADLESS',
  FOX_HEADLESS_STARTUP_TIMEOUT: 'FOX_HEADLESS_STARTUP_TIMEOUT',
  FOX_EXECUTABLE: 'FOX_EXECUTABLE',
  FOX_SCREENSHOTS_DIR: 'FOX_SCREENSHOTS_DIR',
  /** Days to keep screenshots the Native Host saved (Native Host screenshot-store.ts). */
  FOX_SCREENSHOT_RETENTION_DAYS: 'FOX_SCREENSHOT_RETENTION_DAYS',
  FOX_DEBUG: 'FOX_DEBUG',
  FOX_CONTAINER: 'FOX_CONTAINER',
  FOX_READ_ONLY: 'FOX_READ_ONLY',
  FOX_SAFETY_CONFIG: 'FOX_SAFETY_CONFIG',
  FOX_NATIVE_HOST_LOG: 'FOX_NATIVE_HOST_LOG',
  FOX_DAEMON_IDLE_TIMEOUT: 'FOX_DAEMON_IDLE_TIMEOUT',
  /**
   * `0` / `false` / `off` / `no`: never approve protected-site actions via
   * MCP elicitation; always ask in the Extension's toolbar popup. Read by the
   * relay (skips elicitation) and by the daemon (refuses
   * POST /approval/elicitation). Default: ENV_DEFAULTS.FOX_APPROVAL_ELICITATION.
   */
  FOX_APPROVAL_ELICITATION: 'FOX_APPROVAL_ELICITATION',
} as const;

export const LEGACY_ENV = {
  CLAUDE_BROWSER_HOST: 'CLAUDE_BROWSER_HOST',
  CLAUDE_BROWSER_HTTP_PORT: 'CLAUDE_BROWSER_HTTP_PORT',
  CLAUDE_BROWSER_WS_PORT: 'CLAUDE_BROWSER_WS_PORT',
  CLAUDE_BROWSER_HEADLESS: 'CLAUDE_BROWSER_HEADLESS',
  CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT: 'CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT',
  CLAUDE_BROWSER_EXECUTABLE: 'CLAUDE_BROWSER_EXECUTABLE',
  CLAUDE_BROWSER_SCREENSHOTS_DIR: 'CLAUDE_BROWSER_SCREENSHOTS_DIR',
  CLAUDE_BROWSER_READ_ONLY: 'CLAUDE_BROWSER_READ_ONLY',
  CLAUDE_BROWSER_SAFETY_CONFIG: 'CLAUDE_BROWSER_SAFETY_CONFIG',
} as const;

/** Default values for environment variables */
export const ENV_DEFAULTS = {
  FOX_HOST: '127.0.0.1',
  FOX_HTTP_PORT: 8765,
  FOX_WS_PORT: 8766,
  FOX_HEADLESS_STARTUP_TIMEOUT: 45_000,
  HEALTH_CHECK_INTERVAL_MS: 10_000,
  HEALTH_CHECK_MAX_FAILURES: 2,
  MAX_RESTART_ATTEMPTS: 10,
  BACKOFF_BASE_MS: 2_000,
  BACKOFF_MAX_MS: 60_000,
  /**
   * Whether protected-site approvals may be given through MCP elicitation
   * when FOX_APPROVAL_ELICITATION is unset. The single place to change the
   * default: elicitation answers reach the daemon through a local HTTP call
   * that any process holding the API token can make, while the popup needs a
   * person in Firefox.
   */
  FOX_APPROVAL_ELICITATION: true,
  /**
   * Native Messaging size limits (MDN "Native messaging", App side):
   *   - host → extension: "The maximum size of a single message from the
   *     application is 1 MB."
   *   - extension → host: "The maximum size of a message sent to the
   *     application is 4 GB."
   * NATIVE_MSG_MAX_SIZE is the outgoing (host → extension) hard limit.
   * NATIVE_MSG_MAX_INCOMING_SIZE is our own cap on extension → host frames:
   * large enough for full-page / all-tabs screenshot data URLs, small enough
   * that a corrupt length prefix cannot make the host buffer gigabytes.
   * Oversized frames are skipped, not treated as EOF.
   */
  NATIVE_MSG_MAX_SIZE: 1_048_576,
  NATIVE_MSG_MAX_INCOMING_SIZE: 64 * 1_048_576,
} as const;
