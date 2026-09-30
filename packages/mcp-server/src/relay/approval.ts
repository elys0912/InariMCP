/**
 * The relay's part of the human-approval flow for protected-site actions.
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
 *      reason (method not found, transport error) — the Extension's toolbar
 *      popup (POST /approval/browser), with a badge and an OS notification.
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

/** `details.approval` of a confirmation_required result. */
export interface ApprovalInfo {
  requestId: string;
  toolName: string;
  host: string;
  protectedUrl: string;
  matchedPattern: string;
  summary: string;
  expiresAt: number;
}

/** Daemon answer of POST /approval/elicitation and /approval/browser. */
export interface ApprovalReply {
  success: boolean;
  approved: boolean;
  reason?: string;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The approval request of a confirmation_required result, if any. */
export function findApprovalRequest(result: CallToolResult): ApprovalInfo | null {
  if (result.isError !== true) return null;
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed['confirmationRequired'] !== true) continue;
    const a = parsed['approval'];
    if (!isRecord(a)) continue;
    const str = (k: string): string | null => (typeof a[k] === 'string' ? (a[k] as string) : null);
    const requestId = str('requestId');
    const toolName = str('toolName');
    const host = str('host');
    if (!requestId || !toolName || !host || typeof a['expiresAt'] !== 'number') continue;
    return {
      requestId,
      toolName,
      host,
      protectedUrl: str('protectedUrl') ?? '',
      matchedPattern: str('matchedPattern') ?? '',
      summary: str('summary') ?? '',
      expiresAt: a['expiresAt'],
    };
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
    'KitsuneMCP: approve an action on a protected site?',
    '',
    `Tool: ${info.toolName}`,
    `Site: ${info.host}` + (info.matchedPattern ? ` (safety.json pattern '${info.matchedPattern}')` : ''),
  ];
  if (info.protectedUrl) lines.push(`Page: ${info.protectedUrl}`);
  lines.push('Arguments:', info.summary || '(none)', '', 'The approval applies once, to exactly this call.');
  return {
    message: lines.join('\n'),
    requestedSchema: {
      type: 'object',
      properties: {
        approve: {
          type: 'boolean',
          title: 'Approve this action',
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

function fromReply(via: 'elicitation' | 'browser', reply: ApprovalReply): ApprovalOutcome {
  if (reply.approved && typeof reply.approvalToken === 'string') {
    return { kind: 'approved', via, token: reply.approvalToken };
  }
  if (!reply.success) {
    return { kind: 'unavailable', detail: reply.error ?? reply.reason ?? 'approval failed' };
  }
  return { kind: 'not_approved', via, reason: reply.reason ?? 'declined' };
}

/** Ask the human: elicitation first, the Extension's popup as fallback. */
export async function obtainApproval(info: ApprovalInfo, deps: ApprovalDeps): Promise<ApprovalOutcome> {
  const now = deps.now ?? Date.now;
  let elicitationProblem: string | null = null;

  if (deps.canElicit) {
    const waitMs = Math.max(MIN_WAIT_MS, info.expiresAt - now() - EXPIRY_MARGIN_MS);
    let answer: ElicitResult | null = null;
    try {
      answer = await deps.elicit(elicitationParams(info), waitMs);
    } catch (err: unknown) {
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        return { kind: 'not_approved', via: 'elicitation', reason: 'timeout' };
      }
      elicitationProblem = err instanceof Error ? err.message : String(err);
      deps.log?.(`elicitation failed (${elicitationProblem}) — asking in the browser instead`);
    }
    if (answer !== null) {
      try {
        return fromReply('elicitation', await deps.reportElicitation(info.requestId, elicitationApproved(answer)));
      } catch (err: unknown) {
        return { kind: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
      }
    }
  }

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
    return { kind: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
}

export function describeOutcome(outcome: ApprovalOutcome): string {
  const where = (via: 'elicitation' | 'browser'): string =>
    via === 'elicitation' ? "in the MCP client's confirmation dialog" : 'in the KitsuneMCP popup in Firefox';
  switch (outcome.kind) {
    case 'approved':
      return `The human approved this call ${where(outcome.via)}.`;
    case 'not_approved':
      if (outcome.reason === 'timeout') {
        return `KitsuneMCP asked the human ${where(outcome.via)}, but got no answer in time. ` +
          'Tell the user what you want to do and call the tool again when they are ready.';
      }
      if (outcome.reason === 'cancelled') {
        return `The approval request ${where(outcome.via)} was withdrawn before the human answered.`;
      }
      return `The human declined this call ${where(outcome.via)}. Do not retry it unless the user asks you to.`;
    case 'unavailable':
      return `KitsuneMCP could not ask the human: ${outcome.detail}.`;
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
 * (e.g. the tab moved to another protected site) is returned as is.
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
      '(the target page or site changed). Call the tool again to ask the human again.',
    );
  }
  return second;
}
