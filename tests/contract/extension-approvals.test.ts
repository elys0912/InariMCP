/**
 * Extension background/approvals.ts: the pending approval requests of the
 * toolbar popup (request_approval), run against a fake `browser`. Covers the
 * decision input checks, the timeout, the withdrawal by requestId and the
 * badge count reported to setup-badge.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_NOTIFICATION_PREFIX,
  cancelAllApprovals,
  cancelApprovalByRequestId,
  decideApproval,
  listApprovals,
  requestApproval,
} from '../../packages/extension/src/background/approvals.ts';

interface Calls {
  badgeText: string[];
  created: string[];
  cleared: string[];
}

/** The `browser` parts approvals.ts and setup-badge.ts touch. */
function installFakeBrowser(options: { notifications?: boolean } = {}): Calls {
  const calls: Calls = { badgeText: [], created: [], cleared: [] };
  (globalThis as { browser?: unknown }).browser = {
    i18n: { getMessage: () => '' },
    runtime: { getURL: (p: string) => `moz-extension://test/${p}` },
    ...(options.notifications === false
      ? {}
      : {
          notifications: {
            create: async (id: string) => { calls.created.push(id); return id; },
            clear: async (id: string) => { calls.cleared.push(id); return true; },
          },
        }),
    browserAction: {
      setBadgeText: async ({ text }: { text: string }) => { calls.badgeText.push(text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  };
  return calls;
}

let calls: Calls;
beforeEach(() => { calls = installFakeBrowser(); });
afterEach(() => {
  cancelAllApprovals();
  vi.useRealTimers();
  delete (globalThis as { browser?: unknown }).browser;
});

const TOOL_CALL = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'tool_call',
  approvalId: 'ap-1',
  toolName: 'fox_click',
  host: 'bank.example.test',
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

describe('background/approvals.ts', () => {
  it('keeps a request pending until the popup approves it, then answers and clears it', async () => {
    const answer = requestApproval('r-1', TOOL_CALL());
    expect(listApprovals().map((v) => v.id)).toEqual(['ap-1']);
    expect(calls.created).toEqual([`${APPROVAL_NOTIFICATION_PREFIX}ap-1`]);
    expect(calls.badgeText.at(-1)).toBe('1');

    expect(decideApproval('ap-1', true)).toEqual({ success: true });
    await expect(answer).resolves.toMatchObject({
      success: true, approved: true, timedOut: false, cancelled: false, approvalId: 'ap-1', decidedBy: 'popup',
    });
    expect(listApprovals()).toEqual([]);
    expect(calls.cleared).toEqual([`${APPROVAL_NOTIFICATION_PREFIX}ap-1`]);
    expect(calls.badgeText.at(-1)).toBe(''); // no pending request: the setup state again
  });

  it('refuses a decision on an unknown id or with a non-boolean answer, and keeps the request', async () => {
    const answer = requestApproval('r-2', { message: 'Proceed?' });
    const id = listApprovals()[0]!.id;
    expect(id).toBe('msg-r-2');
    expect(decideApproval('msg-other', true)).toMatchObject({ success: false, error: 'This request is no longer pending' });
    expect(decideApproval(42, true)).toMatchObject({ success: false });
    expect(decideApproval(id, 'yes')).toMatchObject({ success: false, error: 'approved must be a boolean' });
    expect(listApprovals()).toHaveLength(1);

    expect(decideApproval(id, false)).toEqual({ success: true });
    await expect(answer).resolves.toMatchObject({ approved: false, decidedBy: 'popup' });
    // decided once: a second answer finds nothing
    expect(decideApproval(id, true)).toMatchObject({ success: false });
  });

  it('times out at the deadline with timedOut and no decision', async () => {
    vi.useFakeTimers();
    const answer = requestApproval('r-3', { message: 'Wait?', timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(listApprovals()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toMatchObject({ approved: false, timedOut: true, decidedBy: 'none' });
    expect(listApprovals()).toEqual([]);
  });

  it('cancel_human_wait withdraws the request of that requestId only', async () => {
    const first = requestApproval(42, { message: 'A' });
    const second = requestApproval('r-other', { message: 'B' });
    expect(cancelApprovalByRequestId('42')).toBe(true);
    await expect(first).resolves.toMatchObject({ approved: false, cancelled: true, decidedBy: 'none' });
    expect(cancelApprovalByRequestId('42')).toBe(false);
    expect(listApprovals().map((v) => v.id)).toEqual(['msg-r-other']);
    cancelAllApprovals();
    await expect(second).resolves.toMatchObject({ cancelled: true });
    expect(calls.badgeText.at(-1)).toBe('');
  });

  it('a repeated id (server retry) cancels the older entry and keeps one', async () => {
    const older = requestApproval('r-4', TOOL_CALL());
    const newer = requestApproval('r-5', TOOL_CALL());
    await expect(older).resolves.toMatchObject({ cancelled: true });
    expect(listApprovals()).toHaveLength(1);
    expect(decideApproval('ap-1', true)).toEqual({ success: true });
    await expect(newer).resolves.toMatchObject({ approved: true });
  });

  it('refuses a malformed tool_call request without showing it', async () => {
    await expect(requestApproval('r-6', TOOL_CALL({ host: '' }))).resolves
      .toEqual({ success: false, error: 'Malformed approval request' });
    await expect(requestApproval('r-7', TOOL_CALL({ expiresAt: Date.now() - 1 }))).resolves
      .toMatchObject({ success: false });
    expect(listApprovals()).toEqual([]);
    expect(calls.created).toEqual([]);
  });

  it('still keeps the request when notifications are unavailable', async () => {
    calls = installFakeBrowser({ notifications: false });
    const answer = requestApproval('r-8', { message: 'No OS notification' });
    expect(listApprovals()).toHaveLength(1);
    expect(calls.badgeText.at(-1)).toBe('1');
    expect(decideApproval('msg-r-8', true)).toEqual({ success: true });
    await expect(answer).resolves.toMatchObject({ approved: true });
  });
});
