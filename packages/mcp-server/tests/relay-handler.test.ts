import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from '../src/relay/daemon-client.js';
import { createRelayHandlers, type RelayClient } from '../src/relay/handler.js';

const ok = (text = 'done'): CallToolResult => ({ content: [{ type: 'text', text }] });
const failed: CallToolResult = { content: [{ type: 'text', text: 'nope' }], isError: true };

function fakeClient(over: Partial<RelayClient> = {}): RelayClient & {
  ready: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  settingsMismatch: ReturnType<typeof vi.fn>;
} {
  return {
    baseUrl: 'http://daemon.test',
    ready: vi.fn(async () => true),
    callTool: vi.fn(async () => ok()),
    settingsMismatch: vi.fn(async () => []),
    ...over,
  } as never;
}

const texts = (r: CallToolResult): string[] =>
  r.content.map((c) => (c.type === 'text' ? c.text : ''));

describe('DaemonClient.ready', () => {
  it('runs one ensureDaemon for concurrent callers and remembers success', async () => {
    const client = new DaemonClient('t1');
    const ensure = vi.spyOn(client, 'ensureDaemon').mockImplementation(
      () => new Promise((r) => setTimeout(() => r(true), 30)),
    );
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => client.ready()));
    expect(results).toEqual([true, true, true, true, true]);
    expect(await client.ready()).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failure: the next call tries again', async () => {
    const client = new DaemonClient('t2');
    const ensure = vi.spyOn(client, 'ensureDaemon')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(await client.ready()).toBe(false);
    expect(await client.ready()).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});

describe('relay tool handler', () => {
  const call = (h: ReturnType<typeof createRelayHandlers>, tool = 'fox_click') =>
    h.handlerFor(tool)({}, {});

  it('waits for the daemon before the first call, and returns an error when it never comes up', async () => {
    const client = fakeClient({ ready: vi.fn(async () => false) });
    const handlers = createRelayHandlers(client, null, () => {});
    const result = await call(handlers);
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain('daemon unavailable');
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('does not block on a slow daemon start when creating the handlers', async () => {
    const client = fakeClient({ ready: vi.fn(() => new Promise<boolean>(() => {})) });
    const handlers = createRelayHandlers(client, null, () => {});
    handlers.startNotice(); // must not throw or wait
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('adds the mismatch warning to the first successful result only', async () => {
    const client = fakeClient();
    client.settingsMismatch.mockResolvedValue(['settings differ']);
    const logs: string[] = [];
    const handlers = createRelayHandlers(client, null, (m) => logs.push(m));
    handlers.startNotice();

    const first = await call(handlers);
    expect(texts(first)).toEqual(['done', 'WARNING: settings differ']);
    const second = await call(handlers);
    expect(texts(second)).toEqual(['done']);
    expect(client.settingsMismatch).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['WARNING: settings differ']);
  });

  it('still delivers the warning when the daemon was not up at the background check', async () => {
    const client = fakeClient();
    client.ready
      .mockResolvedValueOnce(false) // startNotice(): no daemon yet
      .mockResolvedValue(true); //     first tool call: it is up by now
    client.settingsMismatch.mockResolvedValue(['settings differ']);
    const handlers = createRelayHandlers(client, null, () => {});
    handlers.startNotice();
    await new Promise((r) => setTimeout(r, 0));
    expect(texts(await call(handlers))).toEqual(['done', 'WARNING: settings differ']);
  });

  it('carries the warning over a failed first call to the next successful one', async () => {
    const client = fakeClient();
    client.callTool.mockResolvedValueOnce(failed);
    client.settingsMismatch.mockResolvedValue(['settings differ']);
    const handlers = createRelayHandlers(client, null, () => {});
    expect(texts(await call(handlers))).toEqual(['nope']);
    expect(texts(await call(handlers))).toEqual(['done', 'WARNING: settings differ']);
  });

  it('adds nothing when the warnings were already given as instructions', async () => {
    const client = fakeClient();
    const handlers = createRelayHandlers(client, ['settings differ'], () => {});
    expect(texts(await call(handlers))).toEqual(['done']);
    expect(client.settingsMismatch).not.toHaveBeenCalled();
  });

  it('re-checks on every fox_safety_status call', async () => {
    const client = fakeClient();
    client.settingsMismatch.mockResolvedValue(['settings differ']);
    const handlers = createRelayHandlers(client, [], () => {});
    const a = await call(handlers, 'fox_safety_status');
    const b = await call(handlers, 'fox_safety_status');
    expect(texts(a)).toEqual(['done', 'WARNING: settings differ']);
    expect(texts(b)).toEqual(['done', 'WARNING: settings differ']);
    expect(client.settingsMismatch).toHaveBeenCalledTimes(2);
  });

  it('five parallel first calls all succeed and the daemon is checked once', async () => {
    const client = fakeClient();
    client.settingsMismatch.mockResolvedValue(['settings differ']);
    const handlers = createRelayHandlers(client, null, () => {});
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => call(handlers)));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.filter((r) => texts(r).length === 2)).toHaveLength(1);
    expect(client.settingsMismatch).toHaveBeenCalledTimes(1);
  });
});
