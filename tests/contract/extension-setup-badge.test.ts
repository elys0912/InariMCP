/**
 * Extension background/setup-badge.ts: the setup state shown in the popup
 * and on the toolbar badge, from the Native Host connection state and its
 * `status` reply (native-connection.ts replaced by a mock). Pending approval
 * requests take precedence over the setup state on the badge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  status: { confirmed: true, portOpen: true, lastError: null as string | null },
  reply: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('../../packages/extension/src/background/native-connection', () => ({
  hostStatus: () => host.status,
  sendToNativeHost: () => host.reply(),
}));

const { refreshSetupState, setPendingApprovalCount, BADGE_COLOR } =
  await import('../../packages/extension/src/background/setup-badge.ts');

interface Badge { text: string[]; color: string[]; title: string[] }

let badge: Badge;
beforeEach(() => {
  badge = { text: [], color: [], title: [] };
  host.status = { confirmed: true, portOpen: true, lastError: null };
  host.reply.mockReset();
  (globalThis as { browser?: unknown }).browser = {
    i18n: { getMessage: (key: string) => `msg:${key}` },
    browserAction: {
      setBadgeText: async ({ text }: { text: string }) => { badge.text.push(text); },
      setBadgeBackgroundColor: async ({ color }: { color: string }) => { badge.color.push(color); },
      setTitle: async ({ title }: { title: string }) => { badge.title.push(title); },
    },
  };
});
afterEach(() => {
  setPendingApprovalCount(0);
  vi.useRealTimers();
  delete (globalThis as { browser?: unknown }).browser;
});

describe('background/setup-badge.ts', () => {
  it('before the host answered: connecting, then hostMissing / hostError from the last error', async () => {
    host.status = { confirmed: false, portOpen: false, lastError: null };
    expect(await refreshSetupState()).toEqual({ kind: 'connecting' });
    expect(badge.text.at(-1)).toBe('');
    expect(badge.title.at(-1)).toBe('InariMCP');

    host.status.lastError = 'No such native application inari_mcp';
    expect(await refreshSetupState()).toMatchObject({ kind: 'hostMissing' });
    expect(badge.text.at(-1)).toBe('!');
    expect(badge.title.at(-1)).toBe('msg:badgeSetupNeeded');

    host.status.lastError = 'Native host has exited.';
    expect(await refreshSetupState()).toEqual({ kind: 'hostError', error: 'Native host has exited.' });
    expect(host.reply).not.toHaveBeenCalled();
  });

  it('maps the status reply to ready / noSession / daemonDown / hostOutdated', async () => {
    const url = 'http://127.0.0.1:1/';
    host.reply.mockResolvedValueOnce({ mcp_server: { url, available: true, relays: 2 } });
    expect(await refreshSetupState()).toEqual({ kind: 'ready', serverUrl: url, relays: 2 });
    expect(badge.text.at(-1)).toBe('');

    host.reply.mockResolvedValueOnce({ mcp_server: { url, available: true, relays: 0 }, claude_register_command: 'claude mcp add x' });
    expect(await refreshSetupState()).toEqual({ kind: 'noSession', serverUrl: url, registerCommand: 'claude mcp add x' });
    expect(badge.text.at(-1)).toBe('!');

    host.reply.mockResolvedValueOnce({ mcp_server: { url, available: false, relays: null } });
    expect(await refreshSetupState()).toEqual({ kind: 'daemonDown', serverUrl: url });

    // Native Hosts before 0.1.2 send no `relays` field at all
    host.reply.mockResolvedValueOnce({ mcp_server: { url, available: true } });
    expect(await refreshSetupState()).toEqual({ kind: 'hostOutdated', serverUrl: url });
    expect(badge.title.at(-1)).toBe('msg:badgeHostOutdated');
  });

  it('a failed or unanswered status request is a hostError', async () => {
    host.reply.mockRejectedValueOnce(new Error('Request timeout'));
    expect(await refreshSetupState()).toEqual({ kind: 'hostError', error: 'Request timeout' });

    vi.useFakeTimers();
    host.reply.mockReturnValueOnce(new Promise(() => {}));
    const pending = refreshSetupState();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ kind: 'hostError', error: 'Native host status timed out' });
  });

  it('pending approvals show their count on an amber badge, then the setup state returns', async () => {
    host.status = { confirmed: false, portOpen: false, lastError: 'No such native application' };
    await refreshSetupState();
    setPendingApprovalCount(2);
    expect(badge.text.at(-1)).toBe('2');
    expect(badge.color.at(-1)).not.toBe(BADGE_COLOR);
    expect(badge.title.at(-1)).toBe('msg:badgeApprovalPending');

    // a setup refresh meanwhile does not hide the count
    await refreshSetupState();
    expect(badge.text.at(-1)).toBe('2');

    setPendingApprovalCount(0);
    expect(badge.text.at(-1)).toBe('!');
    expect(badge.color.at(-1)).toBe(BADGE_COLOR);
  });

  it('falls back to the message key when the locale has no text (i18n.ts)', async () => {
    (globalThis as { browser: { i18n: unknown } }).browser.i18n = { getMessage: () => '' };
    host.status = { confirmed: false, portOpen: false, lastError: 'boom' };
    await refreshSetupState();
    expect(badge.title.at(-1)).toBe('badgeHostError');
  });
});
