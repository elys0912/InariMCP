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
//   message    fox_request_approval: a yes/no question written by the MCP
//              client. The answer goes back to the MCP client and unlocks
//              nothing.
//
// Imported by the background modules and popup.ts (bundled into both).
// Contract tests import it as a module.

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

/** The request's timeout (a positive number of ms), else the default. */
function approvalTimeout(d: Record<string, unknown>, defaultTimeoutMs: number): number {
  return typeof d.timeout === "number" && Number.isFinite(d.timeout) && d.timeout > 0 ? d.timeout : defaultTimeoutMs;
}

/** A non-empty string field of the request, else null. */
function requestText(d: Record<string, unknown>, key: string): string | null {
  const value = d[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The view of a tool_call request; null when it is malformed or already expired. */
function toolCallView(d: Record<string, unknown>, now: number, timeout: number): ApprovalView | null {
  const approvalId = requestText(d, "approvalId");
  const toolName = requestText(d, "toolName");
  const host = requestText(d, "host");
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
  const timeout = approvalTimeout(d, defaultTimeoutMs);
  if (d.kind === "tool_call") return toolCallView(d, now, timeout);

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

/** The rule of shared/src/approval-site.ts, for the modules that import it from here. */
export { isApprovedSite } from "@inari-mcp/shared/approval-site";
