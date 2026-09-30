import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  callWithApproval,
  canElicit,
  elicitationApproved,
  elicitationParams,
  findApprovalRequest,
  obtainApproval,
  type ApprovalDeps,
  type ApprovalInfo,
} from '../src/relay/approval.js';

const INFO: ApprovalInfo = {
  requestId: 'req-1',
  toolName: 'fox_click',
  host: 'bank.example.test',
  protectedUrl: 'https://bank.example.test/transfer',
  matchedPattern: 'bank\\.example\\.test',
  summary: 'selector: "#go"',
  expiresAt: Date.now() + 120_000,
};

function confirmation(info: ApprovalInfo = INFO): CallToolResult {
  return {
    isError: true,
    content: [
      { type: 'text', text: 'fox_click targets a protected site' },
      {
        type: 'text',
        text: JSON.stringify({ code: 'SAFETY_BLOCKED', decision: 'confirmation_required', confirmationRequired: true, approval: info }),
      },
    ],
  };
}

const OK: CallToolResult = { content: [{ type: 'text', text: '{"success":true}' }] };

function deps(overrides: Partial<ApprovalDeps> = {}): ApprovalDeps & {
  reportElicitation: ReturnType<typeof vi.fn>;
  askBrowser: ReturnType<typeof vi.fn>;
  elicit: ReturnType<typeof vi.fn>;
} {
  return {
    canElicit: true,
    elicit: vi.fn(async () => ({ action: 'accept', content: { approve: true } })),
    reportElicitation: vi.fn(async (_id: string, approved: boolean) =>
      approved
        ? { success: true, approved: true, reason: 'approved', approvalToken: 'kat_e' }
        : { success: true, approved: false, reason: 'declined' }),
    askBrowser: vi.fn(async () => ({ success: true, approved: true, reason: 'approved', approvalToken: 'kat_b' })),
    ...overrides,
  } as never;
}

describe('findApprovalRequest', () => {
  it('reads details.approval of a confirmation_required result', () => {
    expect(findApprovalRequest(confirmation())).toEqual(INFO);
  });

  it('ignores successes, other denials and results without an approval request', () => {
    expect(findApprovalRequest(OK)).toBeNull();
    expect(findApprovalRequest({
      isError: true,
      content: [{ type: 'text', text: '{"code":"SAFETY_BLOCKED","decision":"read_only"}' }],
    })).toBeNull();
    expect(findApprovalRequest({
      isError: true,
      content: [{ type: 'text', text: '{"confirmationRequired":true}' }],
    })).toBeNull();
  });
});

describe('elicitation helpers', () => {
  it('canElicit: form mode, or the legacy empty capability', () => {
    expect(canElicit({ elicitation: {} })).toBe(true);
    expect(canElicit({ elicitation: { form: {} } })).toBe(true);
    expect(canElicit({ elicitation: { url: {} } })).toBe(false);
    expect(canElicit({})).toBe(false);
    expect(canElicit(undefined)).toBe(false);
  });

  it('asks for an explicit boolean and names tool, site and arguments', () => {
    const params = elicitationParams(INFO);
    expect(params.message).toContain('fox_click');
    expect(params.message).toContain('bank.example.test');
    expect(params.message).toContain('selector: "#go"');
    expect(params.requestedSchema.required).toEqual(['approve']);
    expect(params.requestedSchema.properties['approve']).toMatchObject({ type: 'boolean', default: false });
  });

  it('only accept + approve=true approves', () => {
    expect(elicitationApproved({ action: 'accept', content: { approve: true } })).toBe(true);
    expect(elicitationApproved({ action: 'accept', content: { approve: false } })).toBe(false);
    expect(elicitationApproved({ action: 'accept' })).toBe(false);
    expect(elicitationApproved({ action: 'decline' })).toBe(false);
    expect(elicitationApproved({ action: 'cancel' })).toBe(false);
  });
});

describe('obtainApproval: elicitation first, popup as fallback', () => {
  it('elicitation approved → token from the daemon, popup not asked', async () => {
    const d = deps();
    await expect(obtainApproval(INFO, d)).resolves.toEqual({ kind: 'approved', via: 'elicitation', token: 'kat_e' });
    expect(d.reportElicitation).toHaveBeenCalledWith('req-1', true);
    expect(d.askBrowser).not.toHaveBeenCalled();
  });

  it('elicitation declined → reported as declined, popup not asked', async () => {
    const d = deps({ elicit: vi.fn(async () => ({ action: 'decline' as const })) });
    await expect(obtainApproval(INFO, d)).resolves.toMatchObject({ kind: 'not_approved', reason: 'declined' });
    expect(d.reportElicitation).toHaveBeenCalledWith('req-1', false);
    expect(d.askBrowser).not.toHaveBeenCalled();
  });

  it('elicitation timeout → no answer, popup not asked', async () => {
    const d = deps({ elicit: vi.fn(async () => { throw new McpError(ErrorCode.RequestTimeout, 'timeout'); }) });
    await expect(obtainApproval(INFO, d)).resolves.toMatchObject({ kind: 'not_approved', reason: 'timeout' });
    expect(d.askBrowser).not.toHaveBeenCalled();
  });

  it('elicitation fails otherwise → popup', async () => {
    const d = deps({ elicit: vi.fn(async () => { throw new McpError(ErrorCode.MethodNotFound, 'nope'); }) });
    await expect(obtainApproval(INFO, d)).resolves.toEqual({ kind: 'approved', via: 'browser', token: 'kat_b' });
    expect(d.askBrowser).toHaveBeenCalledWith('req-1');
  });

  it('client without elicitation → popup directly', async () => {
    const d = deps({ canElicit: false });
    await expect(obtainApproval(INFO, d)).resolves.toMatchObject({ kind: 'approved', via: 'browser' });
    expect(d.elicit).not.toHaveBeenCalled();
  });

  it('no channel at all → unavailable, with the reason', async () => {
    const d = deps({
      canElicit: false,
      askBrowser: vi.fn(async () => ({ success: false, approved: false, reason: 'no_browser', error: 'No Firefox connected' })),
    });
    const outcome = await obtainApproval(INFO, d);
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.detail).toContain('does not support');
    expect(outcome.kind === 'unavailable' && outcome.detail).toContain('No Firefox connected');
  });
});

describe('callWithApproval', () => {
  it('passes results that need no approval through', async () => {
    const call = vi.fn(async () => OK);
    await expect(callWithApproval(call, deps())).resolves.toBe(OK);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('approved → repeats the call once with the token', async () => {
    const call = vi.fn(async (token?: string) => (token ? OK : confirmation()));
    await expect(callWithApproval(call, deps())).resolves.toBe(OK);
    expect(call.mock.calls).toEqual([[], ['kat_e']]);
  });

  it('declined → original result plus a note, no retry', async () => {
    const call = vi.fn(async () => confirmation());
    const result = await callWithApproval(call, deps({ elicit: vi.fn(async () => ({ action: 'cancel' as const })) }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[1]).toMatchObject({ type: 'text' });
    expect((result.content[1] as { text: string }).text).toContain('declined');
  });

  it('does not loop when the retry needs a new approval', async () => {
    const call = vi.fn(async () => confirmation());
    const d = deps();
    const result = await callWithApproval(call, d);
    expect(call).toHaveBeenCalledTimes(2);
    expect(d.reportElicitation).toHaveBeenCalledTimes(1);
    expect(findApprovalRequest(result)).not.toBeNull();
  });
});
