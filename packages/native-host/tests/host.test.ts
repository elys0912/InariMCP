import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleServerCommand, processMessage, runStdinLoop } from '../src/host.js';
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
      httpPort: 8785,
      checkHealth: vi.fn(async () => true),
      fetchDaemonInfo: vi.fn(async () => ({ relays: 2, version: '9.9.9' })),
    } as unknown as ServerLauncher;
    const connected = { url: 'ws://127.0.0.1:8786', isConnected: true, send: vi.fn(() => true) } as unknown as ServerConnection;
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

// B-KM-04: every Extension answer to a server command passes through here.
describe('server command → Extension → response to the server', () => {
  const PNG_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64')}`;
  /** Above the 1 MB Native Messaging limit (host → extension). */
  const OVERSIZED_TEXT = 'x'.repeat(1024 * 1024 + 1);
  let out: CapturedStdout;
  let dir: string;
  let toServer: Record<string, unknown>[];
  let server: ServerConnection;

  beforeEach(() => {
    out = captureStdout();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-host-shots-'));
    vi.stubEnv('FOX_SCREENSHOTS_DIR', dir);
    toServer = [];
    server = {
      url: 'ws://127.0.0.1:1',
      isConnected: true,
      send: vi.fn((message: Record<string, unknown>) => {
        // A copy as sent: later changes to the object must not show here.
        toServer.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
        return true;
      }),
    } as unknown as ServerConnection;
  });
  afterEach(() => {
    out.restore();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a screenshot answer reaches the server as a file under the requested name, never as base64', () => {
    const command = { requestId: 'shot-1', action: 'screenshot', data: { filename: 'my-shot' } };
    handleServerCommand(command, server);
    expect(decodeFrames(out)).toEqual([command]); // forwarded unmodified

    processMessage({ requestId: 'shot-1', success: true, data: { imageData: PNG_URL } }, launcher, server);
    expect(toServer).toHaveLength(1);
    const data = toServer[0]!['data'] as Record<string, unknown>;
    expect(toServer[0]).toMatchObject({ requestId: 'shot-1', success: true });
    expect(data['imageData']).toBeUndefined();
    expect(data['imagePath']).toBe(path.join(dir, 'my-shot.png'));
    expect(fs.existsSync(path.join(dir, 'my-shot.png'))).toBe(true);
    expect(JSON.stringify(toServer)).not.toContain('base64');
  });

  it('the requested name belongs to its requestId only', () => {
    handleServerCommand({ requestId: 'shot-2', action: 'screenshot', data: { filename: 'named' } }, server);
    processMessage({ requestId: 'shot-3', success: true, data: { imageData: PNG_URL } }, launcher, server);
    processMessage({ requestId: 'shot-2', success: true, data: { imageData: PNG_URL } }, launcher, server);
    const paths = toServer.map((m) => (m['data'] as Record<string, unknown>)['imagePath']);
    expect(path.basename(String(paths[0]))).toMatch(/^screenshot_\d+_[a-z0-9]+\.png$/);
    expect(paths[1]).toBe(path.join(dir, 'named.png'));
  });

  it('a command over the 1 MB limit is answered to the server as a failure, not forwarded', () => {
    handleServerCommand({ requestId: 'big-1', action: 'type', data: { text: OVERSIZED_TEXT } }, server);
    expect(decodeFrames(out)).toEqual([]);
    expect(toServer).toEqual([
      { requestId: 'big-1', success: false, error: 'Command exceeds the 1 MB Native Messaging limit (host → extension)' },
    ]);
  });
});
