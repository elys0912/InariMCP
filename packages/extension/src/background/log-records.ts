// Console / network log records: sanitizing and querying a buffer (L0, pure).
// The per-tab buffers themselves are in logging.ts.

import type { CommandResult } from "./types";
import { clipText } from "../text-clip";

/**
 * Copy one log entry from a content script into plain data: strings (cut
 * at 5000 characters), finite numbers, booleans, null, and one level of
 * string records (headers). Anything else is dropped; null if not an object.
 */
export function sanitizeLogRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 20)) {
    if (typeof value === "string") {
      out[key] = clipText(value, 5000);
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const record: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
        if (typeof v === "string") record[clipText(k, 200)] = clipText(v, 1000);
      }
      out[key] = record;
    }
  }
  return out;
}

/**
 * Append the valid entries of `incoming` (an array, else nothing) to
 * `target`, keeping only the newest `limit`. Returns how many were added.
 */
export function appendLogRecords(target: Record<string, unknown>[], incoming: unknown, limit: number): number {
  if (!Array.isArray(incoming)) return 0;
  let added = 0;
  for (const raw of incoming) {
    const entry = sanitizeLogRecord(raw);
    if (entry === null) continue;
    target.push(entry);
    added++;
  }
  if (target.length > limit) target.splice(0, target.length - limit);
  return added;
}

/** Positive integer `limit`, else 100 (the tool default). */
export function logLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 100;
}

/** fox_get_console_logs filters over a buffer (newest `limit` entries). */
export function queryConsoleLogs(
  entries: Record<string, unknown>[],
  options: Record<string, unknown> = {},
): CommandResult {
  let logs = entries;
  if (typeof options.level === "string" && options.level !== "") {
    logs = logs.filter((l) => l.level === options.level);
  }
  if (typeof options.search === "string" && options.search !== "") {
    const needle = options.search.toLowerCase();
    logs = logs.filter((l) => typeof l.message === "string" && l.message.toLowerCase().includes(needle));
  }
  const limit = logLimit(options.limit);
  if (logs.length > limit) logs = logs.slice(-limit);
  return { success: true, logs, totalCount: entries.length, returnedCount: logs.length };
}

/** fox_get_network_logs filters over a buffer (urlPattern: case-sensitive regex, as every urlPattern). */
export function queryNetworkLogs(
  entries: Record<string, unknown>[],
  options: Record<string, unknown> = {},
): CommandResult {
  let logs = entries;
  if (typeof options.urlPattern === "string" && options.urlPattern !== "") {
    let pattern: RegExp;
    try {
      pattern = new RegExp(options.urlPattern);
    } catch (error) {
      return { success: false, error: `Invalid urlPattern: ${(error as Error).message}` };
    }
    logs = logs.filter((l) => typeof l.url === "string" && pattern.test(l.url));
  }
  if (typeof options.method === "string" && options.method !== "") {
    const method = options.method.toUpperCase();
    logs = logs.filter((l) => typeof l.method === "string" && l.method.toUpperCase() === method);
  }
  if (typeof options.status === "number") {
    logs = logs.filter((l) => l.status === options.status);
  }
  if (options.errorsOnly === true) {
    logs = logs.filter((l) => !!l.error || (typeof l.status === "number" && l.status >= 400));
  }
  const limit = logLimit(options.limit);
  if (logs.length > limit) logs = logs.slice(-limit);
  return { success: true, logs, totalCount: entries.length, returnedCount: logs.length };
}
