import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processMessage, runStdinLoop } from '../src/host.js';
import type { ServerLauncher } from '../src/server-launcher.js';
import type { ServerConnection } from '../src/ws-client.js';
import {
  captureStdout,
  fakeStdin,
  frame,
  type CapturedStdout,
  type FakeStdin,
} from './helpers/stdio.js';

/** Decode every frame written to stdout so far. */
function decodeFrames(out: CapturedStdout): Record<string, unknown>[] {
  const all = Buffer.concat(out.chunks);
  const frames: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset + 4 <= all.length) {
    const len = all.readUInt32LE(offset);
    frames.push(JSON.parse(all.subarray(offset + 4, offset + 4 + len).toString('utf-8')));
    offset += 4 + len;
  }
  return frames;
}

// A daemon that is not (yet) running: /health does not answer, no daemon info.
const launcher = {
  host: '127.0.0.1',
  httpPort: 1,
  checkHealth: vi.fn(async () => false),
  fetchDaemonInfo: vi.fn(async () => null),
} as unknown as ServerLauncher;

const connection = {
  url: 'ws://127.0.0.1:1',
  isConnected: false,
  send: vi.fn(() => false),
} as unknown as ServerConnection;

describe('runStdinLoop (Extension → host)', () => {
  let stdin: FakeStdin;
  let out: CapturedStdout;
  beforeEach(() => {
    stdin = fakeStdin();
    out = captureStdout();
  });
  afterEach(() => {
    out.restore();
    stdin.restore();
  });

  it('answers ping without any daemon or WebSocket connection', async () => {
    const loop = runStdinLoop(launcher, connection, () => true);
    stdin.stream.write(frame({ action: 'ping', requestId: 'p1' }));
    await vi.waitFor(() => expect(decodeFrames(out)).toHaveLength(1));

    expect(decodeFrames(out)[0]).toMatchObject({ action: 'pong', pong: true, success: true, requestId: 'p1' });

    stdin.stream.end();
    await loop;
  });

  it('answers status right away while the daemon is unavailable', async () => {
    const loop = runStdinLoop(launcher, connection, () => true);
    stdin.stream.write(frame({ action: 'status', requestId: 's1' }));
    await vi.waitFor(() => expect(decodeFrames(out)).toHaveLength(1));

    const reply = decodeFrames(out)[0] as { success: boolean; requestId: string; mcp_server: { available: boolean; ws: { connected: boolean } } };
    expect(reply.requestId).toBe('s1');
    expect(reply.mcp_server.available).toBe(false);
    expect(reply.mcp_server.ws.connected).toBe(false);

    stdin.stream.end();
    await loop;
  });

  it('returns when stdin closes', async () => {
    const loop = runStdinLoop(launcher, connection, () => true);
    stdin.stream.end();
    await expect(loop).resolves.toBeUndefined();
  });
});

describe('processMessage replies (shared/host-messages.ts)', () => {
  let out: CapturedStdout;
  beforeEach(() => {
    out = captureStdout();
  });
  afterEach(() => {
    out.restore();
  });

  it("a screenshot message without image data gets 'no image data', and nothing is saved", () => {
    processMessage({ action: 'saveScreenshot', requestId: 'x1', data: {} }, launcher, connection);
    processMessage({ action: 'screenshotTaken', requestId: 'x2', data: 42 }, launcher, connection);
    expect(decodeFrames(out)).toEqual([
      { success: false, error: 'no image data', requestId: 'x1' },
      { success: false, error: 'no image data', requestId: 'x2' },
    ]);
  });

  it('status reports a running daemon with its relays and version', async () => {
    const up = {
      host: '127.0.0.1',
      httpPort: 8765,
      checkHealth: vi.fn(async () => true),
      fetchDaemonInfo: vi.fn(async () => ({ relays: 2, version: '9.9.9' })),
    } as unknown as ServerLauncher;
    const connected = { url: 'ws://127.0.0.1:8766', isConnected: true, send: vi.fn(() => true) } as unknown as ServerConnection;
    processMessage({ action: 'status', requestId: 's2' }, up, connected);
    await vi.waitFor(() => expect(decodeFrames(out)).toHaveLength(1));
    expect(decodeFrames(out)[0]).toMatchObject({
      success: true,
      requestId: 's2',
      mcp_server: { available: true, relays: 2, version: '9.9.9', ws: { connected: true } },
      native_host: { pid: process.pid },
    });
  });

  it('an action the host does not handle is refused when a reply is expected, ignored otherwise', () => {
    processMessage({ action: 'click', requestId: 'c1' }, launcher, connection);
    processMessage({ action: 'click' }, launcher, connection);
    expect(decodeFrames(out)).toEqual([
      { success: false, error: "Native Host does not handle action 'click'", requestId: 'c1' },
    ]);
  });
});
