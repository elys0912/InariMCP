/**
 * The relay's part of the human-approval flow: every acting tool, and reads
 * of a confirm_read_sites site, ask the human first.
 *
 * A tool call answered with confirmation_required carries
 * `details.approval` (tools/handlers.ts). The relay then asks the human
 * outside the page and, when approved, repeats the call once with the
 * one-time token the daemon issued:
 *
 *   1. MCP elicitation (elicitation/create, form mode), when the client
 *      declared the `elicitation` capability. The human's answer (accept +
 *      approve=true, anything else = no) is reported to the daemon
 *      (POST /approval/elicitation). A timeout counts as "no answer".
 *   2. Otherwise — or when the elicitation request fails for any other
 *      reason (method not found, transport error), or the daemon does not
 *      take elicitation answers (its FOX_APPROVAL_ELICITATION is off:
 *      `elicitation_disabled`) — the Extension's toolbar popup
 *      (POST /approval/browser), with a badge and an OS notification.
 *
 * The LLM never sees the token: it travels only relay → daemon.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  ClientCapabilities,
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { isRecord } from '@inari-mcp/shared';
import { errorMessage } from '../utils/errors.js';
import type { ApprovalReason } from '../tools/approval-flow.js';

/** `details.approval` of a confirmation_required result. */
export interface ApprovalInfo {
  requestId: string;
  toolName: string;
  /** The site the approval covers. */
  host: string;
  url: string;
  /** The confirm_read_sites entry of a read; null for an acting tool. */
  matchedPattern: string | null;
  summary: string;
  expiresAt: number;
}

export type { ApprovalReason };

/** Every ApprovalReason, so a value read off the wire can be checked (keys checked by the compiler). */
const APPROVAL_REASONS: Readonly<Record<ApprovalReason, true>> = {
  approved: true,
  declined: true,
  timeout: true,
  cancelled: true,
  unknown_request: true,
  elicitation_disabled: true,
  no_browser: true,
  browser_error: true,
};

export function isApprovalReason(v: unknown): v is ApprovalReason {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(APPROVAL_REASONS, v);
}

/**
 * Daemon answer of POST /approval/elicitation and /approval/browser
 * (tools/approval-flow.ts). `reason` is absent when the relay could not get
 * an answer from the daemon at all.
 */
export interface ApprovalReply {
  success: boolean;
  approved: boolean;
  reason?: ApprovalReason;
  approvalToken?: string;
  error?: string;
}

export type ApprovalOutcome =
  | { kind: 'approved'; via: 'elicitation' | 'browser'; token: string }
  | { kind: 'not_approved'; via: 'elicitation' | 'browser'; reason: string }
  | { kind: 'unavailable'; detail: string };

export interface ApprovalDeps {
  /** Client declared form elicitation. */
  canElicit: boolean;
  elicit(params: ElicitRequestFormParams, timeoutMs: number): Promise<ElicitResult>;
  reportElicitation(requestId: string, approved: boolean): Promise<ApprovalReply>;
  askBrowser(requestId: string): Promise<ApprovalReply>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** The approval request in the `approval` object of a JSON block, or null when it is not a complete one. */
function approvalInfoOf(a: Record<string, unknown>): ApprovalInfo | null {
  const str = (k: string): string | null => {
    const v = a[k];
    return typeof v === 'string' ? v : null;
  };
  const requestId = str('requestId');
  const toolName = str('toolName');
  const host = str('host');
  const expiresAt = a['expiresAt'];
  if (!requestId || !toolName || !host || typeof expiresAt !== 'number') return null;
  return {
    requestId,
    toolName,
    host,
    url: str('url') ?? '',
    matchedPattern: str('matchedPattern'),
    summary: str('summary') ?? '',
    expiresAt,
  };
}

/** The approval request of one text block: JSON with `confirmationRequired: true` and an `approval` object. */
function approvalInfoOfText(text: string): ApprovalInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed['confirmationRequired'] !== true) return null;
  const a = parsed['approval'];
  return isRecord(a) ? approvalInfoOf(a) : null;
}

/** The approval request of a confirmation_required result, if any. */
export function findApprovalRequest(result: CallToolResult): ApprovalInfo | null {
  if (result.isError !== true) return null;
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    const info = approvalInfoOfText(block.text);
    if (info !== null) return info;
  }
  return null;
}

/** Whether the client declared form-mode elicitation (`{}` counts as form). */
export function canElicit(caps: ClientCapabilities | undefined): boolean {
  const e = caps?.elicitation;
  if (!isRecord(e)) return false;
  return Object.keys(e).length === 0 || isRecord(e['form']);
}

export function elicitationParams(info: ApprovalInfo): ElicitRequestFormParams {
  const lines = [
    'Inari MCP: allow this operation?',
    '',
    `Tool: ${info.toolName}`,
    `Site: ${info.host}` + (info.matchedPattern ? ` (confirm_read_sites: '${info.matchedPattern}')` : ''),
  ];
  if (info.url) lines.push(`Page: ${info.url}`);
  lines.push('Arguments:', info.summary || '(none)', '', 'The approval applies once, to exactly this call.');
  return {
    message: lines.join('\n'),
    requestedSchema: {
      type: 'object',
      properties: {
        approve: {
          type: 'boolean',
          title: 'Allow this operation',
          description: `Allow ${info.toolName} on ${info.host} once`,
          default: false,
        },
      },
      required: ['approve'],
    },
  };
}

/** accept + approve=true → approved; anything else → not approved. */
export function elicitationApproved(result: ElicitResult): boolean {
  return result.action === 'accept' && isRecord(result.content) && result.content['approve'] === true;
}

const MIN_WAIT_MS = 10_000;
const EXPIRY_MARGIN_MS = 5_000;

/** ErrorCode.RequestTimeout as McpError#code holds it (a plain number). */
const REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

function fromReply(via: 'elicitation' | 'browser', reply: ApprovalReply): ApprovalOutcome {
  if (reply.approved && typeof reply.approvalToken === 'string') {
    return { kind: 'approved', via, token: reply.approvalToken };
  }
  if (!reply.success) {
    return { kind: 'unavailable', detail: reply.error ?? reply.reason ?? 'approval failed' };
  }
  return { kind: 'not_approved', via, reason: reply.reason ?? 'declined' };
}

/** What the elicitation step ends with: the outcome, or why the browser is asked instead. */
type ElicitationStep = { outcome: ApprovalOutcome } | { fallback: string };

/** Hand the human's answer in the MCP client's dialog to the daemon. */
async function reportElicitationAnswer(
  info: ApprovalInfo,
  deps: ApprovalDeps,
  answer: ElicitResult,
): Promise<ElicitationStep> {
  const approved = elicitationApproved(answer);
  let reply: ApprovalReply;
  try {
    reply = await deps.reportElicitation(info.requestId, approved);
  } catch (err: unknown) {
    return { outcome: { kind: 'unavailable', detail: errorMessage(err) } };
  }
  if (reply.reason !== 'elicitation_disabled') return { outcome: fromReply('elicitation', reply) };
  // The running daemon does not take elicitation answers (its
  // FOX_APPROVAL_ELICITATION differs from this relay's). A "no" stays a
  // no; a "yes" would be lost, so the human is asked in the browser
  // (the request is still open in the daemon).
  if (!approved) return { outcome: { kind: 'not_approved', via: 'elicitation', reason: 'declined' } };
  const problem = reply.error ?? 'the daemon does not accept elicitation answers';
  deps.log?.(`daemon refused the elicitation answer (${problem}) — asking in the browser instead`);
  return { fallback: problem };
}

/** Ask the human in the MCP client's dialog (MCP elicitation). */
async function askByElicitation(info: ApprovalInfo, deps: ApprovalDeps, now: () => number): Promise<ElicitationStep> {
  const waitMs = Math.max(MIN_WAIT_MS, info.expiresAt - now() - EXPIRY_MARGIN_MS);
  let answer: ElicitResult;
  try {
    answer = await deps.elicit(elicitationParams(info), waitMs);
  } catch (err: unknown) {
    if (err instanceof McpError && err.code === REQUEST_TIMEOUT_CODE) {
      return { outcome: { kind: 'not_approved', via: 'elicitation', reason: 'timeout' } };
    }
    const problem = errorMessage(err);
    deps.log?.(`elicitation failed (${problem}) — asking in the browser instead`);
    return { fallback: problem };
  }
  return reportElicitationAnswer(info, deps, answer);
}

/** Ask the human in the Extension's popup; `elicitationProblem`: why the dialog did not answer, if it was tried. */
async function askInBrowser(
  info: ApprovalInfo,
  deps: ApprovalDeps,
  elicitationProblem: string | null,
): Promise<ApprovalOutcome> {
  try {
    const outcome = fromReply('browser', await deps.askBrowser(info.requestId));
    if (outcome.kind === 'unavailable') {
      const why = deps.canElicit
        ? `the MCP client's confirmation dialog failed (${elicitationProblem ?? 'unknown error'})`
        : 'the MCP client does not support confirmation dialogs (MCP elicitation)';
      return { kind: 'unavailable', detail: `${why}, and ${outcome.detail}` };
    }
    return outcome;
  } catch (err: unknown) {
    return { kind: 'unavailable', detail: errorMessage(err) };
  }
}

/** Ask the human: elicitation first, the Extension's popup as fallback. */
export async function obtainApproval(info: ApprovalInfo, deps: ApprovalDeps): Promise<ApprovalOutcome> {
  let elicitationProblem: string | null = null;
  if (deps.canElicit) {
    const step = await askByElicitation(info, deps, deps.now ?? Date.now);
    if ('outcome' in step) return step.outcome;
    elicitationProblem = step.fallback;
  }
  return askInBrowser(info, deps, elicitationProblem);
}

export function describeOutcome(outcome: ApprovalOutcome): string {
  const where = (via: 'elicitation' | 'browser'): string =>
    via === 'elicitation' ? "in the MCP client's confirmation dialog" : 'in the Inari MCP popup in Firefox';
  switch (outcome.kind) {
    case 'approved':
      return `The human approved this call ${where(outcome.via)}.`;
    case 'not_approved':
      if (outcome.reason === 'timeout') {
        return `Inari MCP asked the human ${where(outcome.via)}, but got no answer in time. ` +
          'Tell the user what you want to do and call the tool again when they are ready.';
      }
      if (outcome.reason === 'cancelled') {
        return `The approval request ${where(outcome.via)} was withdrawn before the human answered.`;
      }
      return `The human declined this call ${where(outcome.via)}. Do not retry it unless the user asks you to.`;
    case 'unavailable':
      return `Inari MCP could not ask the human: ${outcome.detail}.`;
    default: {
      const unhandled: never = outcome;
      return String(unhandled);
    }
  }
}

/** Add a text note after the first text block. */
export function appendNote(result: CallToolResult, note: string): CallToolResult {
  return {
    ...result,
    content: [
      ...result.content.slice(0, 1),
      { type: 'text' as const, text: note },
      ...result.content.slice(1),
    ],
  };
}

/**
 * Run a tool call; when it needs human approval, obtain it and repeat the
 * call once with the issued token. No loop: a second confirmation_required
 * (e.g. the tab is on another site than the approved one) is returned as is.
 */
export async function callWithApproval(
  call: (approvalToken?: string) => Promise<CallToolResult>,
  deps: ApprovalDeps,
): Promise<CallToolResult> {
  const first = await call();
  const info = findApprovalRequest(first);
  if (info === null) return first;

  const outcome = await obtainApproval(info, deps);
  if (outcome.kind !== 'approved') return appendNote(first, describeOutcome(outcome));

  const second = await call(outcome.token);
  if (findApprovalRequest(second) !== null) {
    return appendNote(
      second,
      'The human approved the previous attempt, but this call now needs a new approval ' +
      '(the target tab is on another site than the one approved). Call the tool again to ask the human again.',
    );
  }
  return second;
}
