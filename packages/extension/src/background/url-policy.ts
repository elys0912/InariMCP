// URL policy of one command: the human-approval checks and the
// confirm-read / blocked / allowed rules attached by the MCP Server, and the
// target-tab checks built on them (L2).

import { isApprovedHost } from "../approval";
import {
  compileUrlRules,
  urlListViolation,
  findUrlRule,
  type CompiledUrlRule,
  type UrlListViolation,
} from "../url-rule";
import type { CommandResult, UrlLists, NativeMessage } from "./types";

/** The page a new tab opened without a URL shows (background/tabs.ts createNewTab). */
const NEW_TAB_URL = "about:blank";

/**
 * Which approval check handleCommand applies to a single command before its
 * handler (the action table's `approval` column, see action-table.ts):
 *   act       acting on the target tab: approved for the tab's site
 *   actOnUrl  opening a URL (data.url, else a blank tab): approved for
 *             that URL's site
 *   read      reading the target tab: approved for its site when it matches
 *             the attached confirm_read_sites rules
 */
export type ApprovalCheck = "act" | "actOnUrl" | "read";

/**
 * The approval check of one command. Returns null when the command may
 * proceed.
 *
 * Acting commands are the Extension's own floor: they run only when the MCP
 * Server reports a human approval (`approvedHost`) for the site they act on,
 * whatever else the server attached or left out. A command without it is
 * refused with safetyDecision "confirmation_required" and the URL, so that
 * the server can ask the human about that site. Reads are checked only
 * against the confirm_read_sites rules the server attached.
 *
 * `tab`: the target tab resolved once in handleCommand (the same tab the
 * container scope check and the handler use). Fails closed when it could
 * not be resolved.
 */
export function checkApproval(
  check: ApprovalCheck,
  tab: browser.tabs.Tab | undefined,
  data: NativeMessage["data"],
  readRules: CompiledUrlRule[],
  approvedHost: string | undefined,
): CommandResult | null {
  switch (check) {
    case "act":
      if (!tab) return unresolvedTab();
      return checkApprovedUrl(tab.url, approvedHost);
    case "actOnUrl":
      return checkApprovedUrl(urlToOpen(data), approvedHost);
    case "read":
      if (readRules.length === 0) return null;
      if (!tab) return unresolvedTab();
      return checkReadSite(tab.url, readRules, approvedHost);
    default: {
      const unhandled: never = check;
      return { success: false, error: `Unknown approval check: ${String(unhandled)}` };
    }
  }
}

function unresolvedTab(): CommandResult {
  return { success: false, error: "Could not resolve the target tab for the approval check" };
}

/** The URL an opening command opens: `data.url`, else a blank tab. */
function urlToOpen(data: NativeMessage["data"]): string {
  const url = data?.url;
  return typeof url === "string" && url !== "" ? url : NEW_TAB_URL;
}

/** An acting command on `url`: runs only with an approval for its site. */
function checkApprovedUrl(url: string | undefined, approvedHost: string | undefined): CommandResult | null {
  if (isApprovedHost(url, approvedHost)) return null;
  // url ends up in the wire response's `data`, so the server can name the
  // page the human is asked about (its own last-known URL may be stale).
  return {
    success: false,
    safetyDecision: "confirmation_required",
    error: "Human approval required: an acting command runs only on the site a human approved",
    ...(url ? { url } : {}),
  };
}

/** A read of `url`: refused when it matches confirm_read_sites, unless approved for its site. */
function checkReadSite(
  url: string | undefined,
  rules: CompiledUrlRule[],
  approvedHost: string | undefined,
): CommandResult | null {
  const matched = findUrlRule(url, rules);
  if (!url || !matched || isApprovedHost(url, approvedHost)) return null;
  return {
    success: false,
    safetyDecision: "confirmation_required",
    error: "Human approval required: the target tab is on a site of confirm_read_sites",
    url,
    matchedPattern: matched.rule.source,
  };
}

/**
 * Whether a multi-tab read must skip this tab (screenshot_all_tabs): it
 * matches the attached confirm_read_sites rules.
 */
export function isReadConfirmTab(tab: browser.tabs.Tab, readRules: CompiledUrlRule[]): boolean {
  return readRules.length > 0 && findUrlRule(tab.url, readRules) !== undefined;
}

export const NO_URL_LISTS: UrlLists = { blocked: [], allowed: [], allowlistActive: false };

/** parseUrlPolicy. */
interface UrlPolicy {
  readRules: CompiledUrlRule[];
  lists: UrlLists;
  invalid: number;
}

/**
 * The URL policy attached to a command: `confirmReadUrlRules`,
 * `blockedUrlRules`, `allowedUrlRules`. `invalid` counts entries that could
 * not be used, and a field that is there but not an array (compileUrlRules):
 * the command is then refused (an unusable entry must not narrow the policy;
 * the server validates them, so this means a mismatch).
 */
export function parseUrlPolicy(message: NativeMessage): UrlPolicy {
  const read = compileUrlRules(message.confirmReadUrlRules);
  const blocked = compileUrlRules(message.blockedUrlRules);
  const allowed = compileUrlRules(message.allowedUrlRules);
  return {
    readRules: read.rules,
    lists: {
      blocked: blocked.rules,
      allowed: allowed.rules,
      allowlistActive: Array.isArray(message.allowedUrlRules) && message.allowedUrlRules.length > 0,
    },
    invalid: read.invalid + blocked.invalid + allowed.invalid,
  };
}

/** Whether the lists apply at all (nothing to check otherwise). */
export function hasUrlLists(lists: UrlLists): boolean {
  return lists.blocked.length > 0 || lists.allowlistActive;
}

/** urlListViolation (url-rule.ts) over a command's lists. */
export function violatesUrlLists(
  url: string | undefined,
  lists: UrlLists,
): UrlListViolation | null {
  return urlListViolation(url, lists.blocked, lists.allowed, lists.allowlistActive);
}

/**
 * Refuse a command whose target tab (resolved once in handleCommand) is on
 * a URL the blocked / allowed lists refuse -- the guard's Layer 3 check on
 * the tab's real URL, which the server may not know. Fails closed if the
 * tab could not be resolved.
 */
export function checkListedTarget(tab: browser.tabs.Tab | undefined, lists: UrlLists): CommandResult | null {
  if (!tab) {
    return {
      success: false,
      error: "Could not resolve the target tab for the blocked / allowed URL check",
    };
  }
  const violation = violatesUrlLists(tab.url, lists);
  if (violation === null) return null;
  return {
    success: false,
    safetyDecision: violation.decision,
    error:
      `Refused: the target tab is on '${tab.url}', which ${violation.reason}. ` +
      "Navigate it elsewhere (fox_navigate with a url) or close it.",
    url: tab.url,
  };
}
