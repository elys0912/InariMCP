// URL policy of one command: protected / blocked / allowed rules attached by
// the MCP Server, and the target-tab checks built on them (L2).

import { isApprovedHost } from "../approval";
import {
  compileUrlRules,
  urlListViolation,
  findUrlRule,
  type CompiledUrlRule,
  type UrlListViolation,
} from "../url-rule";
import type { CommandResult, UrlLists, NativeMessage } from "./types";

/**
 * Refuse a command when its target tab (resolved once in handleCommand, the
 * same tab the container scope check and the handler use) is on a
 * protected domain. Returns null when the command may proceed. Fails closed
 * if the tab could not be resolved.
 * `approvedHost`: the human approved this one call for that hostname (the
 * MCP Server consumed an approval token); a protected tab on exactly that
 * hostname is let through.
 */
export function checkProtectedTarget(
  tab: browser.tabs.Tab | undefined,
  patterns: CompiledUrlRule[],
  approvedHost?: string,
): CommandResult | null {
  if (!tab) {
    return {
      success: false,
      error: "Could not resolve the target tab for the protected domain check",
    };
  }
  const tabUrl = tab.url;
  const matched = findProtectedMatch(tabUrl, patterns);
  if (tabUrl && matched && !isApprovedHost(tabUrl, approvedHost)) {
    // url / matchedPattern end up in the wire response's `data`, so the
    // server can name the page that was actually refused (its own
    // last-known URL may be stale).
    return {
      success: false,
      safetyDecision: "confirmation_required",
      error: "Protected domain: confirmation required",
      url: tabUrl,
      matchedPattern: matched.rule.source,
    };
  }
  return null;
}

export const NO_URL_LISTS: UrlLists = { blocked: [], allowed: [], allowlistActive: false };

/** parseUrlPolicy. */
interface UrlPolicy {
  protectedRules: CompiledUrlRule[];
  lists: UrlLists;
  invalid: number;
}

/**
 * The URL policy attached to a command: `protectedUrlRules` (else the
 * legacy regex strings of `protectedUrlPatterns`, older MCP Servers),
 * `blockedUrlRules`, `allowedUrlRules`. `invalid` counts entries that could
 * not be used: the command is then refused (an unusable entry must not
 * narrow the policy; the server validates them, so this means a mismatch).
 */
export function parseUrlPolicy(message: NativeMessage): UrlPolicy {
  const protectedSource = Array.isArray(message.protectedUrlRules)
    ? message.protectedUrlRules
    : message.protectedUrlPatterns;
  const prot = compileUrlRules(protectedSource);
  const blocked = compileUrlRules(message.blockedUrlRules);
  const allowed = compileUrlRules(message.allowedUrlRules);
  return {
    protectedRules: prot.rules,
    lists: {
      blocked: blocked.rules,
      allowed: allowed.rules,
      allowlistActive: Array.isArray(message.allowedUrlRules) && message.allowedUrlRules.length > 0,
    },
    invalid: prot.invalid + blocked.invalid + allowed.invalid,
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

/** The first protected rule that matches the URL, if any. */
export function findProtectedMatch(url: string | undefined, patterns: CompiledUrlRule[]): CompiledUrlRule | undefined {
  return findUrlRule(url, patterns);
}
