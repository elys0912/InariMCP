/**
 * Tool calls that need a human approval, made as the relay makes them
 * (relay/approval.ts): the first call is refused with an approval request,
 * the human approves it through MCP elicitation, and the call is repeated
 * once with the one-time token.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { findApprovalRequest } from '../../src/relay/approval.js';
import { answerFromElicitation } from '../../src/tools/approval-flow.js';
import { createToolHandler } from '../../src/tools/handlers.js';

/** A handler of tools/handlers.ts (createToolHandler()). */
export type ToolHandler = ReturnType<typeof createToolHandler>;

/** The approval request a refused call opened (relay/approval.ts findApprovalRequest()). */
export type ApprovalRequest = NonNullable<ReturnType<typeof findApprovalRequest>>;

export interface ApprovingCall {
  /** The answer of the call with the token, or of the first call when it opened no request. */
  result: CallToolResult;
  /** The request the first call opened; null when it needed no approval or could not be approved. */
  request: ApprovalRequest | null;
}

/**
 * Call `handler` with `args`; when the answer opens an approval request, the
 * human approves it and the call is repeated with the token.
 * `beforeApproval` runs between the refusal and the approval, to check what
 * the refused call did.
 */
export async function callApproving(
  handler: ToolHandler,
  args: Record<string, unknown>,
  beforeApproval: () => void = () => {},
): Promise<ApprovingCall> {
  const first = await handler(args);
  const request = findApprovalRequest(first);
  if (request === null) return { result: first, request };

  beforeApproval();
  const { approvalToken } = answerFromElicitation(request.requestId, true);
  const result = await handler(args, { approvalToken });

  return { result, request };
}

/**
 * An acting call of `tool`: refused, approved by the human, repeated with the
 * token; the answer of the repeated call. Throws when the first call opened
 * no approval request.
 */
export async function callWithApprovalToken(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { result, request } = await callApproving(createToolHandler(tool), args);
  if (request === null) throw new Error(`no approval request: ${JSON.stringify(result.content)}`);

  return result;
}
