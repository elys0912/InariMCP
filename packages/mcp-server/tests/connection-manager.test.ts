import { describe, expect, it } from 'vitest';
import { BrowserConnectionManager, runWithCallSignal } from '../src/connection/manager.js';

interface Sent {
  action: string;
  requestId: string;
  data?: Record<string, unknown>;
}

/** A browser that records commands and never answers. */
function silentBrowser(manager: BrowserConnectionManager, id = 'b1'): Sent[] {
  const sent: Sent[] = [];
  manager.registerBrowser(id, (m) => { sent.push(m as Sent); }, 'native-host');
  return sent;
}

describe('requestId (5.6)', () => {
  it('is prefixed with a per-process random boot id', async () => {
    const manager = new BrowserConnectionManager();
    const sent = silentBrowser(manager);
    void manager.sendCommand({ action: 'get_tabs', requestId: 'ignored' }, 1_000);
    void manager.sendCommand({ action: 'get_tabs', requestId: 'ignored' }, 1_000);
    expect(sent.map((s) => s.requestId)).toEqual([`${manager.bootId}-1`, `${manager.bootId}-2`]);
    expect(manager.bootId).toMatch(/^[a-z0-9]+$/);
    manager.shutdown();
  });

  it('does not repeat across daemon restarts (new manager instances)', () => {
    const ids = new Set(Array.from({ length: 20 }, () => new BrowserConnectionManager().bootId));
    expect(ids.size).toBe(20);
  });
});

describe('connection choice', () => {
  it('prefers the earliest registered Native Host', () => {
    const manager = new BrowserConnectionManager();
    silentBrowser(manager, 'first');
    silentBrowser(manager, 'second');
    expect(manager.getActiveBrowser()?.id).toBe('first');
    manager.unregisterBrowser('first');
    expect(manager.getActiveBrowser()?.id).toBe('second');
  });
});

describe('client abort (5.5)', () => {
  it('cancels the pending command when the call signal aborts', async () => {
    const manager = new BrowserConnectionManager();
    silentBrowser(manager);
    const abort = new AbortController();
    const pending = runWithCallSignal(abort.signal, () =>
      manager.sendCommand({ action: 'get_tabs', requestId: 'x' }, 10_000),
    );
    abort.abort();
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Cancelled/);
  });

  it('follows the signal through awaits in between (AsyncLocalStorage)', async () => {
    const manager = new BrowserConnectionManager();
    silentBrowser(manager);
    const abort = new AbortController();
    const pending = runWithCallSignal(abort.signal, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return manager.sendCommand({ action: 'get_tabs', requestId: 'x' }, 10_000);
    });
    setTimeout(() => abort.abort(), 20);
    expect((await pending).error).toMatch(/Cancelled/);
  });

  it('asks the Extension to withdraw the banner of a cancelled human wait', async () => {
    const manager = new BrowserConnectionManager();
    const sent = silentBrowser(manager);
    const abort = new AbortController();
    const pending = runWithCallSignal(abort.signal, () =>
      manager.sendCommand({ action: 'request_approval', requestId: 'x' }, 10_000),
    );
    abort.abort();
    await pending;
    expect(sent.map((s) => s.action)).toEqual(['request_approval', 'cancel_human_wait']);
    expect(sent[1]?.data).toEqual({ requestId: sent[0]?.requestId });
  });

  it('does not send a command at all when already aborted', async () => {
    const manager = new BrowserConnectionManager();
    const sent = silentBrowser(manager);
    const abort = new AbortController();
    abort.abort();
    const res = await runWithCallSignal(abort.signal, () =>
      manager.sendCommand({ action: 'get_tabs', requestId: 'x' }, 10_000),
    );
    expect(res.success).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('an answer before the abort wins; the later abort is a no-op', async () => {
    const manager = new BrowserConnectionManager();
    const sent = silentBrowser(manager);
    const abort = new AbortController();
    const pending = runWithCallSignal(abort.signal, () =>
      manager.sendCommand({ action: 'request_approval', requestId: 'x' }, 10_000),
    );
    manager.handleResponse({ requestId: sent[0]!.requestId, success: true });
    abort.abort();
    expect((await pending).success).toBe(true);
    expect(sent).toHaveLength(1); // no cancel_human_wait
  });
});
