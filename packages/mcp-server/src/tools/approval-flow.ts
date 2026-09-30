/**
 * Daemon side of the human-approval flow (safety/approval.ts).
 *
 * The relay (relay/approval.ts) gets a confirmation_required result carrying
 * `details.approval.requestId` and then asks the human through one channel:
 *
 *   POST /approval/elicitation { requestId, approved }
 *       The relay asked the MCP client (elicitation/create) and reports the
 *       human's answer. approved → token issued.
 *   POST /approval/browser { requestId }
 *       The daemon sends `request_approval` (ApprovalPromptSchema) to the
 *       Extension, which shows it in its toolbar popup — outside the page —
 *       and answers on the same requestId. approved → token issued.
 *
 * Either way the answer is `{ success, approved, approvalToken?, expiresAt?,
 * reason? }`. The relay then retries the tool call with the token.
 */

import type { ApprovalPrompt, BrowserResponse } from '@kitsune-mcp/shared';
import type { BrowserConnectionManager } from '../connection/manager.js';
import { getApprovalStore, isElicitationApprovalEnabled } from '../safety/approval.js';
import type { ApprovalRequest, ApprovalStore } from '../safety/approval.js';
import { getSafetyGuard } from '../safety/guard.js';
import { audit } from '../safety/audit.js';

/** How long the Extension's popup waits for the human (ms). */
export const BROWSER_APPROVAL_WAIT_MS = 60_000;

export type ApprovalReason =
  | 'approved'
  | 'declined'
  | 'timeout'
  | 'cancelled'
  | 'unknown_request'
  | 'elicitation_disabled'
  | 'no_browser'
  | 'browser_error';

export interface ApprovalReply {
  success: boolean;
  approved: boolean;
  reason: ApprovalReason;
  approvalToken?: string;
  expiresAt?: number;
  error?: string;
}

function auditDecision(
  request: ApprovalRequest,
  decision: 'approval_granted' | 'approval_denied',
  via: string,
  transport: string | undefined,
): void {
  if (!getSafetyGuard().config.auditLog) return;
  audit(
    request.target.toolName,
    { approvalId: request.id, host: request.target.host, via },
    request.protectedUrl,
    decision,
    transport,
  );
}

function unknownRequest(): ApprovalReply {
  return {
    success: false,
    approved: false,
    reason: 'unknown_request',
    error: 'No such approval request (unknown, expired or already answered)',
  };
}

function grant(
  store: ApprovalStore,
  request: ApprovalRequest,
  via: 'elicitation' | 'browser',
  transport: string | undefined,
): ApprovalReply {
  const issued = store.issueToken(request.id, via);
  if (!issued) return unknownRequest();
  auditDecision(request, 'approval_granted', via, transport);
  return {
    success: true,
    approved: true,
    reason: 'approved',
    approvalToken: issued.token,
    expiresAt: issued.expiresAt,
  };
}

/** The relay reports the human's answer to an MCP elicitation. */
export function answerFromElicitation(
  requestId: string,
  approved: boolean,
  transport?: string,
  store: ApprovalStore = getApprovalStore(),
  env: Record<string, string | undefined> = process.env,
): ApprovalReply {
  if (!isElicitationApprovalEnabled(env)) {
    return {
      success: false,
      approved: false,
      reason: 'elicitation_disabled',
      error: 'Approval by MCP elicitation is turned off (FOX_APPROVAL_ELICITATION); ask in the browser popup',
    };
  }
  const request = store.getRequest(requestId);
  if (!request) return unknownRequest();
  if (approved) return grant(store, request, 'elicitation', transport);
  store.closeRequest(requestId);
  auditDecision(request, 'approval_denied', 'elicitation', transport);
  return { success: true, approved: false, reason: 'declined' };
}

/** `request_approval` data for the Extension's popup. */
export function buildApprovalPrompt(request: ApprovalRequest, now = Date.now()): ApprovalPrompt {
  return {
    kind: 'protected_action',
    approvalId: request.id,
    toolName: request.target.toolName,
    host: request.target.host,
    url: request.protectedUrl,
    matchedPattern: request.matchedPattern,
    summary: request.summary,
    expiresAt: request.expiresAt,
    timeout: Math.max(1_000, Math.min(BROWSER_APPROVAL_WAIT_MS, request.expiresAt - now)),
  };
}

/** Whether the Extension's answer approves exactly this request. */
export function isBrowserApproval(response: BrowserResponse, approvalId: string): boolean {
  return (
    response.success === true &&
    response.data?.['approved'] === true &&
    response.data?.['approvalId'] === approvalId
  );
}

/** Ask the human in the Extension's toolbar popup and wait for the answer. */
export async function askBrowser(
  requestId: string,
  connectionManager: BrowserConnectionManager,
  transport?: string,
  store: ApprovalStore = getApprovalStore(),
): Promise<ApprovalReply> {
  const request = store.getRequest(requestId);
  if (!request) return unknownRequest();

  if (connectionManager.activeKind !== 'native-host') {
    return {
      success: false,
      approved: false,
      reason: 'no_browser',
      error:
        'No Firefox with the KitsuneMCP extension is connected, so nobody can be asked ' +
        'in the browser (headless mode has no human).',
    };
  }

  const response = await connectionManager.sendCommand({
    action: 'request_approval',
    requestId: '',
    data: { ...buildApprovalPrompt(request) },
  });

  if (isBrowserApproval(response, request.id)) {
    return grant(store, request, 'browser', transport);
  }

  if (!response.success) {
    return {
      success: false,
      approved: false,
      reason: 'browser_error',
      error: response.error ?? 'The browser did not answer the approval request',
    };
  }

  const data = response.data ?? {};
  const reason: ApprovalReason =
    data['timedOut'] === true ? 'timeout' : data['cancelled'] === true ? 'cancelled' : 'declined';
  store.closeRequest(request.id);
  if (reason === 'declined') auditDecision(request, 'approval_denied', 'browser', transport);
  return { success: true, approved: false, reason };
}
