// Messages and limits shared by the background and content scripts
//
// Both sides of a runtime message must use the same type string, and both
// buffers of the console / network logs the same limits; a value defined
// twice could drift apart and silently stop logging. The background and
// content modules re-export these from their constants.ts.
//
// Imported by the background and content modules (bundled into both). Keep it
// dependency-free and without top-level side effects: content.js runs it on
// every injection, before its __fox_injected guard.

/** content → background: `{ type, console?: entry[], network?: entry[] }`. */
export const LOG_RECORD_MESSAGE = "inari:logRecords";

/** content → background: "is logging on for my tab?" (reply `{ enabled, ... }`). */
export const LOGGING_STATE_QUERY = "inari:loggingState";

/**
 * Console entries and network entries kept per tab, each (oldest dropped):
 * the content script's unsent entries and the background's buffer.
 */
export const LOG_ENTRY_LIMIT = 500;

/**
 * Longest string of a recorded log entry (characters): the response body
 * and the console message the content script keeps, and any string field
 * the background accepts from it.
 */
export const LOG_TEXT_LIMIT = 5000;
