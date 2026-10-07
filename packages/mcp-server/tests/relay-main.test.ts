import { describe, expect, it } from 'vitest';
import { instructionsFor, precheckDaemon, type PrecheckClient } from '../src/relay/main.js';

function fakeClient(opts: {
  healthy?: boolean;
  mismatch?: string;
  settings?: string[] | null;
  /** How long checkSettings takes. */
  settingsDelayMs?: number;
}): PrecheckClient & { settingsAsked: number } {
  const c = {
    settingsAsked: 0,
    checkHealth: (): Promise<boolean> => Promise.resolve(opts.healthy ?? true),
    protocolMismatch: (): string | undefined => opts.mismatch,
    checkSettings: (): Promise<string[] | null> => {
      c.settingsAsked += 1;
      return new Promise((resolve) => setTimeout(() => resolve(opts.settings ?? []), opts.settingsDelayMs ?? 0));
    },
  };
  return c;
}

describe('runRelay precheck (precheckDaemon)', () => {
  it('no daemon answers: null (the first tool call carries any warning)', async () => {
    await expect(precheckDaemon(fakeClient({ healthy: false }))).resolves.toBeNull();
  });

  it('a daemon of another protocol: its message, without asking for settings', async () => {
    const c = fakeClient({ mismatch: 'another version' });
    await expect(precheckDaemon(c)).resolves.toEqual(['another version']);
    expect(c.settingsAsked).toBe(0);
  });

  it('settings warnings within the budget are returned', async () => {
    await expect(precheckDaemon(fakeClient({ settings: ['FOX_READ_ONLY differs'] }))).resolves.toEqual(['FOX_READ_ONLY differs']);
  });

  it('an answer later than the budget is dropped (null)', async () => {
    await expect(precheckDaemon(fakeClient({ settings: ['late'], settingsDelayMs: 200 }), 20)).resolves.toBeNull();
  });
});

describe('instructionsFor', () => {
  it('puts the precheck warnings (e.g. a protocol mismatch) into the server instructions', () => {
    expect(instructionsFor(['a', 'b'])).toEqual({ instructions: 'a\nb' });
  });

  it('adds nothing when the check found nothing or did not finish', () => {
    expect(instructionsFor([])).toEqual({});
    expect(instructionsFor(null)).toEqual({});
  });
});
