// KitsuneMCP approval requests (shared by background and popup)
//
// Human approval is asked in the toolbar popup, never in the page: content
// scripts, page JavaScript and the LLM's own tools (fox_click,
// fox_execute_script, ...) cannot reach the popup, and the background only
// accepts a decision from an extension page (the popup). See
// background/approvals.ts.
//
// Two kinds of request arrive as `request_approval` commands:
//   protected_action  sent by the MCP Server for a protected-site action
//                     (shared ApprovalPromptSchema). Approving it lets the
//                     server issue a one-time token for exactly that call.
//   message           fox_request_approval: a yes/no question written by
//                     Claude. The answer goes back to Claude and unlocks
//                     nothing.
//
// Imported by the background modules and popup.ts (bundled into both). Contract tests
// load it as a module; it also publishes its helpers on globalThis for them.

import { clipText } from "./text-clip";

/** runtime.sendMessage types between the popup and the background. */
export const APPROVAL_MESSAGE = {
  /** popup → background: list pending requests → { success, approvals } */
  LIST: "kitsune:approvals:list",
  /** popup → background: { id, approved } → { success, error? } */
  DECIDE: "kitsune:approvals:decide",
} as const;

export type ApprovalKind = "protected_action" | "message";

export type ApprovalDecision = "approved" | "denied" | "timeout" | "cancelled";

/** What the popup shows for one pending request (serializable). */
export interface ApprovalView {
  id: string;
  kind: ApprovalKind;
  createdAt: number;
  /** When the background stops waiting (epoch ms). */
  deadline: number;
  // protected_action
  toolName?: string;
  host?: string;
  url?: string;
  matchedPattern?: string;
  summary?: string;
  // message
  message?: string;
  detail?: string;
}

export const APPROVAL_TEXT_LIMITS = { MESSAGE: 500, DETAIL: 500, SUMMARY: 800, URL: 300 } as const;

export function clipApprovalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > max ? `${clipText(value, max)}…` : value;
}

/**
 * Build the popup view of a `request_approval` command. Null when a
 * protected_action request is malformed (it is refused, not shown).
 */
export function parseApprovalPrompt(
  data: unknown,
  requestId: string,
  now: number,
  defaultTimeoutMs: number,
): ApprovalView | null {
  const d = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const timeout =
    typeof d.timeout === "number" && Number.isFinite(d.timeout) && d.timeout > 0
      ? d.timeout
      : defaultTimeoutMs;

  if (d.kind === "protected_action") {
    const str = (k: string): string | null =>
      typeof d[k] === "string" && d[k] !== "" ? (d[k] as string) : null;
    const approvalId = str("approvalId");
    const toolName = str("toolName");
    const host = str("host");
    const expiresAt = d.expiresAt;
    if (!approvalId || !toolName || !host || typeof expiresAt !== "number" || !(expiresAt > now)) {
      return null;
    }
    return {
      id: approvalId,
      kind: "protected_action",
      createdAt: now,
      deadline: Math.min(now + timeout, expiresAt),
      toolName,
      host,
      url: clipApprovalText(d.url, APPROVAL_TEXT_LIMITS.URL),
      matchedPattern: clipApprovalText(d.matchedPattern, APPROVAL_TEXT_LIMITS.URL),
      summary: clipApprovalText(d.summary, APPROVAL_TEXT_LIMITS.SUMMARY),
    };
  }

  return {
    id: `msg-${requestId}`,
    kind: "message",
    createdAt: now,
    deadline: now + timeout,
    message: clipApprovalText(d.message, APPROVAL_TEXT_LIMITS.MESSAGE),
    detail: clipApprovalText(d.detail, APPROVAL_TEXT_LIMITS.DETAIL),
  };
}

/** Command result for a decided request (goes back to the MCP Server). */
export function approvalCommandResult(
  view: ApprovalView,
  decision: ApprovalDecision,
  now: number,
): { success: true; [key: string]: unknown } {
  return {
    success: true,
    approved: decision === "approved",
    timedOut: decision === "timeout",
    cancelled: decision === "cancelled",
    ...(view.kind === "protected_action" ? { approvalId: view.id } : {}),
    decidedBy: decision === "approved" || decision === "denied" ? "popup" : "none",
    decidedAt: new Date(now).toISOString(),
  };
}

/**
 * Whether an approved call may run on this tab: the tab's hostname equals
 * the hostname the human approved (MCP Server `approvedHost`). Both are
 * compared lower-case without a trailing dot, as URL rules compare hosts
 * (url-rule.ts), so `example.com.` is the approved `example.com`.
 */
export function isApprovedHost(tabUrl: string | undefined, approvedHost: unknown): boolean {
  if (typeof approvedHost !== "string" || approvedHost === "" || !tabUrl) return false;
  const bare = (host: string): string => host.toLowerCase().replace(/\.$/, "");
  try {
    const approved = bare(approvedHost);
    return approved !== "" && bare(new URL(tabUrl).hostname) === approved;
  } catch {
    return false;
  }
}

(globalThis as { KITSUNE_APPROVAL?: unknown }).KITSUNE_APPROVAL = {
  APPROVAL_MESSAGE,
  parseApprovalPrompt,
  approvalCommandResult,
  isApprovedHost,
};
