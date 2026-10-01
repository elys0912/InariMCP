/**
 * Extension background/human-wait.ts: waits on the human (captcha banner)
 * and their withdrawal by cancel_human_wait, against a fake `browser`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllApprovals, requestApproval } from '../../packages/extension/src/background/approvals.ts';
import { cancelHumanWait, solveCaptcha, trackHumanWait } from '../../packages/extension/src/background/human-wait.ts';

type Sent = { tabId: number; message: Record<string, unknown>; frameId: number };

function installFakeBrowser(options: { activeTabId?: number; queryFails?: boolean; notifyFails?: boolean } = {}) {
  const sent: Sent[] = [];
  const notify = vi.fn(async () => {
    if (options.notifyFails) throw new Error('notifications disabled');
    return 'n';
  });
  (globalThis as { browser?: unknown }).browser = {
    i18n: { getMessage: () => '' },
    runtime: { getURL: (p: string) => `moz-extension://test/${p}` },
    notifications: { create: notify, clear: async () => true },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    tabs: {
      get: async (id: number) => ({ id }),
      query: async () => {
        if (options.queryFails) throw new Error('no window');
        return [{ id: options.activeTabId ?? 5 }];
      },
      sendMessage: async (tabId: number, message: Record<string, unknown>, o: { frameId: number }) => {
        sent.push({ tabId, message, frameId: o.frameId });
        return { cancelled: true };
      },
    },
  };
  return { sent, notify };
}

let fake: ReturnType<typeof installFakeBrowser>;
beforeEach(() => { fake = installFakeBrowser(); });
afterEach(() => {
  cancelAllApprovals();
  delete (globalThis as { browser?: unknown }).browser;
});

describe('background/human-wait.ts', () => {
  it('remembers the pinned tab while the handler waits, so cancel_human_wait reaches its banner', async () => {
    let release!: () => void;
    const running = trackHumanWait('r-1', undefined, (tabId) => {
      expect(tabId).toBe(5); // the active tab, pinned once
      return new Promise((resolve) => { release = () => resolve({ success: true }); });
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    expect(await cancelHumanWait({ requestId: 'r-1' })).toMatchObject({ success: true, cancelled: true });
    expect(fake.sent).toEqual([{ tabId: 5, message: { action: 'cancelHumanWait' }, frameId: 0 }]);

    release();
    await running;
    // the wait is over: nothing left to withdraw
    expect(await cancelHumanWait({ requestId: 'r-1' })).toEqual({ success: true, cancelled: false });
    expect(fake.sent).toHaveLength(1);
  });

  it('answers cancelled:false for a missing or non-scalar requestId', async () => {
    expect(await cancelHumanWait()).toEqual({ success: true, cancelled: false });
    expect(await cancelHumanWait({ requestId: { id: 1 } })).toEqual({ success: true, cancelled: false });
    expect(await cancelHumanWait({ requestId: 'unknown' })).toEqual({ success: true, cancelled: false });
    expect(fake.sent).toEqual([]);
  });

  it('withdraws a pending approval request of that requestId without messaging any tab', async () => {
    const answer = requestApproval(7, { message: 'Proceed?' });
    expect(await cancelHumanWait({ requestId: 7 })).toEqual({ success: true, cancelled: true });
    await expect(answer).resolves.toMatchObject({ cancelled: true });
    expect(fake.sent).toEqual([]);
  });

  it('passes the given tabId on when the tab cannot be resolved', async () => {
    fake = installFakeBrowser({ queryFails: true });
    const seen: (number | undefined)[] = [];
    await trackHumanWait(undefined, undefined, async (tabId) => { seen.push(tabId); return { success: true }; });
    expect(seen).toEqual([undefined]);
  });

  it('solveCaptcha notifies the human (not for detectOnly) and asks the top frame', async () => {
    await solveCaptcha(3, { timeout: 1_000 });
    expect(fake.notify).toHaveBeenCalledTimes(1);
    expect(fake.sent.at(-1)).toEqual({ tabId: 3, message: { action: 'solveCaptcha', timeout: 1_000 }, frameId: 0 });

    await solveCaptcha(3, { detectOnly: true });
    expect(fake.notify).toHaveBeenCalledTimes(1);
    expect(fake.sent.at(-1)?.message).toEqual({ action: 'solveCaptcha', detectOnly: true });
  });

  it('solveCaptcha still asks the page when notifications fail', async () => {
    fake = installFakeBrowser({ notifyFails: true });
    expect(await solveCaptcha(3)).toMatchObject({ success: true });
    expect(fake.sent).toHaveLength(1);
  });
});
