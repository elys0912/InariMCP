import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStdinLoop } from '../src/host.js';
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
