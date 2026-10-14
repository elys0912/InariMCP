// InariMCP approval requests (shared by background and popup)
//
// Human approval is asked in the toolbar popup, never in the page: content
// scripts, page JavaScript and the LLM's own tools (fox_click, ...) cannot
// reach the popup, and the background only accepts a decision from an
// extension page (the popup). See background/approvals.ts.
//
// Two kinds of request arrive as `request_approval` commands:
//   tool_call  sent by the MCP Server for a tool call that needs a human
//              decision: every acting tool, and reads of a
//              confirm_read_sites site (shared ApprovalPromptSchema).
//              Approving it lets the server issue a one-time token for
//              exactly that call.
//   message    fox_request_approval: a yes/no question written by Claude.
//              The answer goes back to Claude and unlocks nothing.
//
// Imported by the background modules and popup.ts (bundled into both).
// Contract tests import it as a module.

import { approvalSiteOf, bareHost } from "@inari-mcp/shared/approval-site";
import { clipText } from "./text-clip";

/** runtime.sendMessage types between the popup and the background. */
export const APPROVAL_MESSAGE = {
  /** popup → background: list pending requests → { success, approvals } */
  LIST: "inari:approvals:list",
  /** popup → background: { id, approved } → { success, error? } */
  DECIDE: "inari:approvals:decide",
} as const;

export type ApprovalKind = "tool_call" | "message";

export type ApprovalDecision = "approved" | "denied" | "timeout" | "cancelled";

/** What the popup shows for one pending request (serializable). */
export interface ApprovalView {
  id: string;
  kind: ApprovalKind;
  createdAt: number;
  /** When the background stops waiting (epoch ms). */
  deadline: number;
  // tool_call
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
 * tool_call request is malformed (it is refused, not shown).
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

  if (d.kind === "tool_call") {
    const str = (k: string): string | null => {
      const value = d[k];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const approvalId = str("approvalId");
    const toolName = str("toolName");
    const host = str("host");
    const expiresAt = d.expiresAt;
    if (!approvalId || !toolName || !host || typeof expiresAt !== "number" || !(expiresAt > now)) {
      return null;
    }
    return {
      id: approvalId,
      kind: "tool_call",
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
    ...(view.kind === "tool_call" ? { approvalId: view.id } : {}),
    decidedBy: decision === "approved" || decision === "denied" ? "popup" : "none",
    decidedAt: new Date(now).toISOString(),
  };
}

/**
 * Whether an approved call may run on this URL (the target tab's, or the URL
 * a new tab opens): its site (approvalSiteOf, the rule the MCP Server binds
 * the approval with) equals the site the human approved (the command's
 * `approvedHost`), compared as bare hostnames, so `example.com.` is the
 * approved `example.com`.
 */
export function isApprovedSite(url: string | undefined, approvedSite: unknown): boolean {
  if (typeof approvedSite !== "string" || approvedSite === "") return false;
  const site = approvalSiteOf(url);
  return site !== null && site === bareHost(approvedSite);
}
