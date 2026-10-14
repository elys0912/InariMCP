// Approval requests (toolbar popup, never the page) (L3).
//
// A request_approval command stays pending here until the human decides in
// the popup (APPROVAL_MESSAGE.DECIDE, accepted from extension pages only),
// it times out, the server withdraws it (cancel_human_wait) or the Native
// Host disconnects. The badge shows how many are pending (the count is
// reported to setup-badge.ts). The answer is the command's response, on the
// server's own requestId.

import { t } from "../i18n";
import {
  parseApprovalPrompt,
  approvalCommandResult,
  type ApprovalView,
  type ApprovalDecision,
} from "../approval";
import { clipText } from "../text-clip";
import { LIMITS, TIMEOUTS } from "./constants";
import { setPendingApprovalCount } from "./setup-badge";
import type { CommandResult } from "./types";

interface PendingApproval {
  view: ApprovalView;
  /** requestId of the request_approval command (cancel_human_wait key). */
  requestId: string;
  finish: (decision: ApprovalDecision) => void;
}

/** Pending requests by ApprovalView.id, in arrival order. */
const pendingApprovals = new Map<string, PendingApproval>();
export const APPROVAL_NOTIFICATION_PREFIX = "inari-approval-";

export function requestApproval(
  requestId: number | string | undefined,
  data: Record<string, unknown> = {},
): Promise<CommandResult> {
  const key = requestId === undefined ? `local-${Date.now()}` : String(requestId);
  const view = parseApprovalPrompt(data, key, Date.now(), TIMEOUTS.APPROVAL);
  if (view === null) {
    return Promise.resolve({ success: false, error: "Malformed approval request" });
  }
  // A repeated id (server retry) replaces the older entry.
  pendingApprovals.get(view.id)?.finish("cancelled");

  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    const finish = (decision: ApprovalDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingApprovals.get(view.id)?.finish === finish) pendingApprovals.delete(view.id);
      browser.notifications?.clear?.(APPROVAL_NOTIFICATION_PREFIX + view.id)?.catch(() => {});
      setPendingApprovalCount(pendingApprovals.size);
      resolve(approvalCommandResult(view, decision, Date.now()));
    };
    const timer = setTimeout(() => finish("timeout"), Math.max(0, view.deadline - Date.now()));
    pendingApprovals.set(view.id, { view, requestId: key, finish });
    setPendingApprovalCount(pendingApprovals.size);
    notifyApproval(view);
  });
}

/** OS notification pointing at the toolbar popup (best effort). */
function notifyApproval(view: ApprovalView): void {
  try {
    if (!browser.notifications) return;
    const message =
      view.kind === "protected_action"
        ? t("notifyApprovalProtected", [view.toolName ?? "", view.host ?? ""])
        : t("notifyApprovalQuestion", clipText(view.message || t("notifyApprovalDefault"), LIMITS.APPROVAL_NOTIFICATION_TEXT));
    browser.notifications
      .create(APPROVAL_NOTIFICATION_PREFIX + view.id, {
        type: "basic",
        title: t("notifyApprovalTitle"),
        message,
        iconUrl: browser.runtime.getURL("icons/icon.svg"),
      })
      .catch(() => {});
  } catch {
    // Notifications unavailable -- the badge still shows the request
  }
}

/**
 * cancel_human_wait: withdraw the request of the request_approval command
 * with this requestId. False when none is pending.
 */
export function cancelApprovalByRequestId(requestId: string): boolean {
  for (const entry of pendingApprovals.values()) {
    if (entry.requestId === requestId) {
      entry.finish("cancelled");
      return true;
    }
  }
  return false;
}

export function cancelAllApprovals(): void {
  for (const entry of [...pendingApprovals.values()]) entry.finish("cancelled");
}

/** Popup: the pending requests, oldest first. */
export function listApprovals(): ApprovalView[] {
  return [...pendingApprovals.values()].map((entry) => entry.view);
}

/** Popup: the human's decision on one request. */
export function decideApproval(id: unknown, approved: unknown): CommandResult {
  const entry = typeof id === "string" ? pendingApprovals.get(id) : undefined;
  if (!entry) return { success: false, error: "This request is no longer pending" };
  if (typeof approved !== "boolean") return { success: false, error: "approved must be a boolean" };
  entry.finish(approved ? "approved" : "denied");
  return { success: true };
}
