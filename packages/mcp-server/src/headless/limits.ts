/**
 * Timeouts, waits and size limits of the headless backend (backend.ts,
 * actions.ts, helpers.ts). No imports, so helpers.ts stays loadable without
 * playwright.
 *
 * Not here: the startup timeout (utils/headless-env.ts, ENV_DEFAULTS) and the
 * per-command timeouts the MCP server waits for (connection/manager.ts).
 */

// --- Timeouts of single steps (the call has no timeout argument for them) ---
// Each stays below HEADLESS_COMMAND_TIMEOUT_MS (35 s, connection/manager.ts),
// so a step fails on its own before the server stops waiting
// (tests/headless-helpers.test.ts).

/** page.goto() of navigate and create_tab, page.reload() of refresh. */
export const NAVIGATE_TIMEOUT_MS = 30_000;
/** page.goBack() / page.goForward(). */
export const HISTORY_TIMEOUT_MS = 15_000;
/**
 * Waiting for an element: click, hover, snapshot, get_text, the focus of
 * press_key, and each of the two waits of type / set_value (find, then fill).
 */
export const ELEMENT_TIMEOUT_MS = 10_000;
/** The option lookup and page.selectOption() of select_option. */
export const SELECT_OPTION_TIMEOUT_MS = 5_000;
/**
 * A page script: execute_script, each eval_chain step, and each condition /
 * action of wait_and_act. A script whose promise never settles is given up
 * (it may still run in the page).
 */
export const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * wait_for_* (element, network idle, navigation, url): how long after the
 * Playwright wait's own timeout it is given up (bounded by the deadline as well).
 */
export const WAIT_GIVE_UP_SLACK_MS = 1_000;

// --- Values in place of an unusable argument ---
// The other arguments are used as the tool schemas deliver them (helpers.ts
// parseArgs); these two schema fields allow zero and negative numbers. Both
// equal the schema default (tests/headless-helpers.test.ts).

/** wait_and_act: the wait when timeoutMs is zero or negative. */
export const WAIT_AND_ACT_DEFAULT_MS = 15_000;
/** wait_and_act: the poll interval when pollIntervalMs is zero or negative. */
export const WAIT_AND_ACT_POLL_MS = 200;

// --- Waits ---

/** Shortest poll interval of wait_and_act; smaller pollIntervalMs values are raised to it. */
export const WAIT_AND_ACT_POLL_MIN_MS = 10;
/** The CSS outline fox_highlight draws (for its duration argument). */
export const HIGHLIGHT_OUTLINE = '3px solid red';
/** Longest a dialog nobody asked for may stay open before it is dismissed (it blocks the page). */
export const DIALOG_GRACE_MS = 2_000;
/** An armed fox_handle_dialog applies to the next dialog within this time only. */
export const ARM_TTL_MS = 30_000;

// --- Sizes ---

/** fox_snapshot text is cut at this many characters. */
export const SNAPSHOT_MAX_CHARS = 50_000;
/** get_elements returns at most this many elements (the limit argument is ignored). */
export const GET_ELEMENTS_MAX = 50;
/** Text of an element in get_elements / scroll toElement results is cut at this many characters. */
export const ELEMENT_TEXT_MAX_CHARS = 100;
/** select_option: options listed when no option matches. */
export const AVAILABLE_OPTIONS_MAX = 20;
/** Characters of a dialog message quoted in the auto-dismiss warning. */
export const DIALOG_MESSAGE_PREVIEW_CHARS = 80;
/** Viewport of the headless browser context. */
export const VIEWPORT = { width: 1280, height: 800 } as const;
/** fox_type without selector: iframes followed to find the focused element (deeper: refused). */
export const FOCUS_MAX_FRAME_DEPTH = 8;
