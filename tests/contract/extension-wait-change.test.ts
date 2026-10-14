/**
 * Extension content script: what waitForChange (content/wait.ts) answers,
 * kept as it was when the wait was split into small functions for the pause
 * switch: the first change of the changeType ends it, waitForAll collects
 * until the timeout, no change times out, and the observer is disconnected
 * in every case. Runs the module with a fake MutationObserver (no real
 * browser); the real-DOM checks are in extension-content.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MutationCallback = (records: Partial<MutationRecord>[]) => void;

/** MutationObserver whose changes the test reports (emit); records its disconnect. */
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: MutationCallback) { FakeMutationObserver.instances.push(this); }
  observe(): void {}
  disconnect(): void { this.disconnected = true; }
  emit(...types: MutationRecordType[]): void {
    this.callback(types.map((type) => ({
      type,
      target: { tagName: 'P' } as unknown as Node,
      addedNodes: [] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    })));
  }
}

beforeEach(() => {
  vi.resetModules();
  FakeMutationObserver.instances = [];
  vi.stubGlobal('document', { body: {} });
  vi.stubGlobal('MutationObserver', FakeMutationObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function startWait(options: Record<string, unknown>) {
  const { waitForChange } = await import('../../packages/extension/src/content/wait.ts');
  const waiting = waitForChange(options);
  return { waiting, observer: FakeMutationObserver.instances[0]! };
}

describe('content/wait.ts waitForChange', () => {
  it('the first change of the changeType ends it', async () => {
    const { waiting, observer } = await startWait({ changeType: 'childList', timeout: 60_000 });
    observer.emit('attributes', 'childList', 'childList');
    await expect(waiting).resolves.toMatchObject({ changed: true, changes: [{ type: 'childList', target: 'p' }] });
    expect(observer.disconnected).toBe(true);
  });

  it('waitForAll collects the changes until the timeout', async () => {
    vi.useFakeTimers();
    const { waiting, observer } = await startWait({ waitForAll: true, timeout: 1_000 });
    observer.emit('attributes');
    observer.emit('characterData');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({
      changed: true,
      changes: [expect.objectContaining({ type: 'attributes' }), expect.objectContaining({ type: 'characterData' })],
      waitedMs: 1_000,
    });
  });

  it('no change until the timeout: timedOut', async () => {
    vi.useFakeTimers();
    const { waiting, observer } = await startWait({ timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({ changed: false, changes: [], waitedMs: 1_000, timedOut: true });
    expect(observer.disconnected).toBe(true);
  });
});
