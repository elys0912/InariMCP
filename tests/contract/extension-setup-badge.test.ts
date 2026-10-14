/**
 * Extension background/setup-badge.ts: the setup state shown in the popup
 * and on the toolbar badge, from the Native Host connection state and its
 * `status` reply (native-connection.ts and control-state.ts replaced by
 * mocks). The badge shows one state at a time: not allowed yet, paused,
 * pending approvals, a running command, then the setup state.
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

const control = vi.hoisted(() => ({
  view: { consent: 'granted', paused: false } as { consent: 'undecided' | 'granted' | 'denied'; paused: boolean },
}));

vi.mock('../../packages/extension/src/background/control-state', () => ({
  controlView: () => control.view,
}));

const { refreshSetupState, setPendingApprovalCount, startHostCommand, refreshBadge, badgeFor, SETUP_BADGE_COLOR } =
  await import('../../packages/extension/src/background/setup-badge.ts');

interface Badge { text: string[]; color: string[]; title: string[] }

let badge: Badge;
beforeEach(() => {
  badge = { text: [], color: [], title: [] };
  host.status = { confirmed: true, portOpen: true, lastError: null };
  host.reply.mockReset();
  control.view = { consent: 'granted', paused: false };
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
  describe('before the host answered', () => {
    it('without an error it is connecting, with a plain badge', async () => {
      host.status = { confirmed: false, portOpen: false, lastError: null };
      expect(await refreshSetupState()).toEqual({ kind: 'connecting' });
      expect(badge.text.at(-1)).toBe('');
      expect(badge.title.at(-1)).toBe('InariMCP');
    });

    it('a missing native application is hostMissing, with the setup badge', async () => {
      host.status = { confirmed: false, portOpen: false, lastError: 'No such native application inari_mcp' };
      expect(await refreshSetupState()).toMatchObject({ kind: 'hostMissing' });
      expect(badge.text.at(-1)).toBe('!');
      expect(badge.title.at(-1)).toBe('msg:badgeSetupNeeded');
    });

    it('another error is a hostError, without asking the host', async () => {
      host.status = { confirmed: false, portOpen: false, lastError: 'Native host has exited.' };
      expect(await refreshSetupState()).toEqual({ kind: 'hostError', error: 'Native host has exited.' });
      expect(host.reply).not.toHaveBeenCalled();
    });
  });

  describe('the status reply', () => {
    const url = 'http://127.0.0.1:1/';

    it.each([
      ['ready', { mcp_server: { url, available: true, relays: 2 } }, { kind: 'ready', serverUrl: url, relays: 2 }],
      [
        'noSession',
        { mcp_server: { url, available: true, relays: 0 }, claude_register_command: 'claude mcp add x' },
        { kind: 'noSession', serverUrl: url, registerCommand: 'claude mcp add x' },
      ],
      ['daemonDown', { mcp_server: { url, available: false, relays: null } }, { kind: 'daemonDown', serverUrl: url }],
      // Native Hosts before 0.1.2 send no `relays` field at all
      ['hostOutdated', { mcp_server: { url, available: true } }, { kind: 'hostOutdated', serverUrl: url }],
    ])('maps to %s', async (_kind, reply, expected) => {
      host.reply.mockResolvedValueOnce(reply);
      expect(await refreshSetupState()).toEqual(expected);
    });

    it.each([
      ['ready', { mcp_server: { url, available: true, relays: 2 } }, 'text', ''],
      ['noSession', { mcp_server: { url, available: true, relays: 0 }, claude_register_command: 'claude mcp add x' }, 'text', '!'],
      ['hostOutdated', { mcp_server: { url, available: true } }, 'title', 'msg:badgeHostOutdated'],
    ] as const)('%s draws the badge %s %j', async (_kind, reply, part, expected) => {
      host.reply.mockResolvedValueOnce(reply);
      await refreshSetupState();
      expect(badge[part].at(-1)).toBe(expected);
    });
  });

  it('a failed status request is a hostError', async () => {
    host.reply.mockRejectedValueOnce(new Error('Request timeout'));
    expect(await refreshSetupState()).toEqual({ kind: 'hostError', error: 'Request timeout' });
  });

  it('an unanswered status request times out as a hostError', async () => {
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
    expect(badge.color.at(-1)).not.toBe(SETUP_BADGE_COLOR);
    expect(badge.title.at(-1)).toBe('msg:badgeApprovalPending');

    // a setup refresh meanwhile does not hide the count
    await refreshSetupState();
    expect(badge.text.at(-1)).toBe('2');

    setPendingApprovalCount(0);
    expect(badge.text.at(-1)).toBe('!');
    expect(badge.color.at(-1)).toBe(SETUP_BADGE_COLOR);
  });

  it('falls back to the message key when the locale has no text (i18n.ts)', async () => {
    (globalThis as { browser: { i18n: unknown } }).browser.i18n = { getMessage: () => '' };
    host.status = { confirmed: false, portOpen: false, lastError: 'boom' };
    await refreshSetupState();
    expect(badge.title.at(-1)).toBe('badgeHostError');
  });
});

describe('background/setup-badge.ts: badge priority', () => {
  const READY = { kind: 'ready', relays: 1 } as const;
  const HOST_MISSING = { kind: 'hostMissing', error: 'No such native application' } as const;
  const inputs = (overrides: Partial<Parameters<typeof badgeFor>[0]> = {}): Parameters<typeof badgeFor>[0] => ({
    control: { consent: 'granted', paused: false },
    pendingApprovals: 0,
    activeHostCommands: 0,
    setup: READY,
    ...overrides,
  });

  it.each(['undecided', 'denied'] as const)('not allowed yet (%s) comes before everything else', (consent) => {
    const all = inputs({ control: { consent, paused: true }, pendingApprovals: 2, activeHostCommands: 1, setup: HOST_MISSING });
    expect(badgeFor(all)).toMatchObject({ text: 'msg:badgeTextNoConsent', title: 'msg:badgeNoConsent' });
  });

  it('paused comes before approvals, a running command and the setup state', () => {
    const paused = inputs({ control: { consent: 'granted', paused: true }, pendingApprovals: 2, activeHostCommands: 1, setup: HOST_MISSING });
    expect(badgeFor(paused)).toMatchObject({ text: 'msg:badgeTextPaused', title: 'msg:badgePaused' });
  });

  it('pending approvals come before a running command (request_approval is one)', () => {
    expect(badgeFor(inputs({ pendingApprovals: 1, activeHostCommands: 1 }))).toMatchObject({ text: '1', title: 'msg:badgeApprovalPending' });
  });

  it('a running command comes before the setup state', () => {
    expect(badgeFor(inputs({ activeHostCommands: 1, setup: HOST_MISSING }))).toMatchObject({ text: '●', title: 'msg:badgeActive' });
  });

  it('the setup state shows last, when nothing else does', () => {
    expect(badgeFor(inputs({ setup: HOST_MISSING }))).toEqual({ text: '!', color: SETUP_BADGE_COLOR, title: 'msg:badgeSetupNeeded' });
  });

  it('a ready setup with nothing else shows no badge text', () => {
    expect(badgeFor(inputs())).toEqual({ text: '', color: SETUP_BADGE_COLOR, title: 'InariMCP' });
  });

  it('each state has its own color', () => {
    const colors = [
      badgeFor(inputs({ control: { consent: 'undecided', paused: false } })).color,
      badgeFor(inputs({ control: { consent: 'granted', paused: true } })).color,
      badgeFor(inputs({ pendingApprovals: 1 })).color,
      badgeFor(inputs({ activeHostCommands: 1 })).color,
      badgeFor(inputs({ setup: HOST_MISSING })).color,
    ];
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('a running command shows while it runs, then the badge goes back; finishing twice counts once', async () => {
    host.status = { confirmed: false, portOpen: false, lastError: null };
    await refreshSetupState();
    const finishFirst = startHostCommand();
    const finishSecond = startHostCommand();
    expect(badge.text.at(-1)).toBe('●');
    expect(badge.title.at(-1)).toBe('msg:badgeActive');

    finishFirst();
    finishFirst();
    expect(badge.text.at(-1)).toBe('●');
    finishSecond();
    expect(badge.text.at(-1)).toBe('');
    expect(badge.title.at(-1)).toBe('InariMCP');
  });

  it('refreshBadge draws a change of the consent or the pause switch', () => {
    control.view = { consent: 'denied', paused: false };
    refreshBadge();
    expect(badge.text.at(-1)).toBe('msg:badgeTextNoConsent');

    control.view = { consent: 'granted', paused: true };
    refreshBadge();
    expect(badge.text.at(-1)).toBe('msg:badgeTextPaused');
  });

  it('a badge that cannot be drawn does not throw into the caller', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete (globalThis as { browser?: { i18n?: unknown } }).browser!.i18n;
    control.view = { consent: 'undecided', paused: false };
    expect(() => startHostCommand()()).not.toThrow();
  });
});
