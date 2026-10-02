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

// --- Defaults of the timeout / timeoutMs argument (see argTimeout) ---

export const WAIT_FOR_ELEMENT_DEFAULT_MS = 10_000;
export const WAIT_FOR_NETWORK_IDLE_DEFAULT_MS = 10_000;
export const WAIT_FOR_NAVIGATION_DEFAULT_MS = 30_000;
export const WAIT_FOR_URL_DEFAULT_MS = 15_000;
export const WAIT_AND_ACT_DEFAULT_MS = 15_000;
/** How long fox_handle_dialog waits for a dialog before it arms itself. */
export const HANDLE_DIALOG_DEFAULT_MS = 10_000;

// --- Waits ---

/** Poll interval of wait_and_act when pollIntervalMs is not given (or not a positive number). */
export const WAIT_AND_ACT_POLL_MS = 200;
/** Shortest poll interval of wait_and_act; smaller pollIntervalMs values are raised to it. */
export const WAIT_AND_ACT_POLL_MIN_MS = 10;
/** How long fox_highlight's outline stays (the duration argument is ignored). */
export const HIGHLIGHT_MS = 2_000;
/** Longest a dialog nobody asked for may stay open before it is dismissed (it blocks the page). */
export const DIALOG_GRACE_MS = 2_000;
/** An armed fox_handle_dialog applies to the next dialog within this time only. */
export const ARM_TTL_MS = 30_000;

// --- Sizes ---

/** fox_snapshot text is cut at this many characters. */
export const SNAPSHOT_MAX_CHARS = 50_000;
/** get_text: maxLength when not given. */
export const GET_TEXT_DEFAULT_MAX_LENGTH = 20_000;
/** get_elements returns at most this many elements (the limit argument is ignored). */
export const GET_ELEMENTS_MAX = 50;
/** Text of an element in get_elements / scroll toElement results is cut at this many characters. */
export const ELEMENT_TEXT_MAX_CHARS = 100;
/** select_option: options listed when no option matches. */
export const AVAILABLE_OPTIONS_MAX = 20;
/** Characters of a dialog message quoted in the auto-dismiss warning. */
export const DIALOG_MESSAGE_PREVIEW_CHARS = 80;
/** scroll: pixels per step when amount is not given (or not a number). */
export const SCROLL_DEFAULT_AMOUNT_PX = 300;
/** Viewport of the headless browser context. */
export const VIEWPORT = { width: 1280, height: 800 } as const;
/** fox_type without selector: iframes followed to find the focused element (deeper: refused). */
export const FOCUS_MAX_FRAME_DEPTH = 8;
