import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { type WebSocketServer } from 'ws';
import { BrowserConnectionManager } from '../src/connection/manager.js';
import { startWebSocketServer, type WsBridgeOptions } from '../src/transport/ws-bridge.js';
import { AUTH_PROTOCOL, MAC_LABEL, computeMac, newNonce } from '@kitsune-mcp/shared/node';
import { TOKEN, authenticate, closed, connect, nextFrame, sleep, waitFor } from './helpers/ws.js';

let servers: WebSocketServer[] = [];

async function startBridge(extra: Partial<WsBridgeOptions> = {}): Promise<{
  manager: BrowserConnectionManager;
  port: number;
}> {
  const manager = new BrowserConnectionManager();
  const wss = await startWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    apiToken: TOKEN,
    connectionManager: manager,
    ...extra,
  });
  servers.push(wss);
  return { manager, port: (wss.address() as AddressInfo).port };
}

afterEach(async () => {
  for (const wss of servers) {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
  servers = [];
});

/** Raw WebSocket upgrade over TCP, so we can write frames `ws` would never produce. */
function rawUpgrade(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    sock.once('data', (d) => {
      if (d.toString().startsWith('HTTP/1.1 101')) resolve(sock);
      else reject(new Error(d.toString()));
    });
    sock.on('error', () => { /* server may reset */ });
  });
}

describe('ws-bridge handshake (challenge-response)', () => {
  it('sends a challenge first and proves the token back in auth_ok', async () => {
    const { manager, port } = await startBridge();
    const { ws, ok, serverNonce, clientNonce } = await authenticate(port);
    expect(ok['type']).toBe('auth_ok');
    expect(ok['mac']).toBe(computeMac(TOKEN, MAC_LABEL.wsServer, serverNonce, clientNonce));
    await waitFor(() => manager.nativeHostCount === 1);
    ws.close();
  });

  it('challenge frames carry the protocol and a fresh nonce', async () => {
    const { port } = await startBridge();
    const a = await connect(port);
    const b = await connect(port);
    expect(a.challenge).toMatchObject({ type: 'auth_challenge', protocol: AUTH_PROTOCOL });
    expect(a.challenge['nonce']).not.toBe(b.challenge['nonce']);
    a.ws.close();
    b.ws.close();
  });

  it('rejects the old plaintext { token } frame with 1008, without registering', async () => {
    const { manager, port } = await startBridge();
    const { ws } = await connect(port);
    ws.send(JSON.stringify({ token: TOKEN }));
    expect(await closed(ws)).toBe(1008);
    expect(manager.browserCount).toBe(0);
  });

  it('rejects a MAC made with another token', async () => {
    const { manager, port } = await startBridge();
    const { ws } = await connect(port);
    await expect(authenticate(port, 'e'.repeat(64))).rejects.toThrow(/closed \(1008\)/);
    expect(manager.browserCount).toBe(0);
    ws.close();
  });

  it('rejects a MAC computed over a different server nonce (replay)', async () => {
    const { port } = await startBridge();
    const { ws, challenge } = await connect(port);
    const clientNonce = newNonce();
    const stale = newNonce(); // not the nonce this server sent
    expect(stale).not.toBe(challenge['nonce']);
    ws.send(JSON.stringify({
      type: 'auth',
      protocol: AUTH_PROTOCOL,
      nonce: clientNonce,
      mac: computeMac(TOKEN, MAC_LABEL.wsClient, stale, clientNonce),
    }));
    expect(await closed(ws)).toBe(1008);
  });

  it('closes with 1009 on an oversized auth frame', async () => {
    const { port } = await startBridge();
    const { ws } = await connect(port);
    ws.send('x'.repeat(10_000));
    expect(await closed(ws)).toBe(1009);
  });

  it('rejects a web page Origin before sending a challenge', async () => {
    const { manager, port } = await startBridge();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://evil.example' });
    const frames: string[] = [];
    ws.on('message', (raw) => frames.push(raw.toString()));
    ws.on('error', () => { /* surfaced through close */ });
    expect(await closed(ws)).toBe(1008);
    expect(frames).toEqual([]);
    expect(manager.browserCount).toBe(0);
  });
});

describe('ws-bridge unauthenticated connection cap', () => {
  it('refuses a 9th connection that is still waiting for auth with 1013', async () => {
    const { port } = await startBridge();
    const pending = await Promise.all(Array.from({ length: 8 }, () => connect(port)));
    const extra = new WebSocket(`ws://127.0.0.1:${port}`);
    extra.on('error', () => { /* surfaced through close */ });
    expect(await closed(extra)).toBe(1013);
    for (const p of pending) p.ws.close();
  });
  // TODO(test): a slot is freed after auth success / failure / close, and the 5 s auth timeout frees it too
});

/** Header of a masked client text frame announcing `length` payload bytes (mask key 0). */
function clientFrameHeader(length: number): Buffer {
  if (length < 126) return Buffer.from([0x81, 0x80 | length, 0, 0, 0, 0]);
  const h = Buffer.alloc(14);
  h[0] = 0x81;
  h[1] = 0x80 | 127;
  h.writeBigUInt64BE(BigInt(length), 2);
  return h; // bytes 10..13: mask key 0
}

function socketClosed(sock: net.Socket): Promise<void> {
  return new Promise((resolve) => sock.once('close', () => resolve()));
}

describe('ws-bridge refused connections are cut', () => {
  it('cuts a refused peer that never answers the close frame', async () => {
    const { port } = await startBridge();
    const sock = await rawUpgrade(port);
    const payload = Buffer.from('{}'); // mask key 0: payload as is
    sock.write(Buffer.concat([clientFrameHeader(payload.length), payload]));
    const t0 = Date.now();
    await socketClosed(sock); // we never send a close frame back
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('cuts a peer that streams more than 64 KB before auth, before its frame ends', async () => {
    const { port } = await startBridge();
    const sock = await rawUpgrade(port);
    const done = socketClosed(sock);
    sock.write(clientFrameHeader(1_048_576));
    let sent = 0;
    let open = true;
    void done.then(() => { open = false; });
    while (open && sent < 1_048_576) {
      sock.write(Buffer.alloc(16_384));
      sent += 16_384;
      await sleep(5);
    }
    await done;
    expect(sent).toBeLessThan(1_048_576);
  });
  // TODO(test): the byte count stops after auth (large frames from an authenticated host pass); auth timeout is also cut after the grace period
});

describe('ws-bridge robustness', () => {
  it('survives an invalid frame before auth and keeps serving', async () => {
    const { port } = await startBridge();
    const sock = await rawUpgrade(port);
    sock.write(Buffer.from([0xff, 0xff, 0x00, 0x00])); // reserved opcode + RSV bits
    await new Promise<void>((resolve) => sock.once('close', () => resolve()));
    const { ws, ok } = await authenticate(port);
    expect(ok['type']).toBe('auth_ok');
    ws.close();
  });

  it('drops invalid JSON after auth without closing the connection', async () => {
    const { manager, port } = await startBridge();
    const { ws } = await authenticate(port);
    await waitFor(() => manager.nativeHostCount === 1);
    ws.send('{not json');
    ws.send('[]');
    await sleep(50);
    expect(ws.readyState).toBe(ws.OPEN);
    expect(manager.nativeHostCount).toBe(1);
    ws.close();
  });

  it('routes responses to the pending command', async () => {
    const { manager, port } = await startBridge();
    const { ws } = await authenticate(port);
    await waitFor(() => manager.nativeHostCount === 1);
    ws.on('message', (raw) => {
      const cmd = JSON.parse(raw.toString()) as { requestId: string };
      ws.send(JSON.stringify({ requestId: cmd.requestId, success: true, data: { ok: 1 } }));
    });
    const res = await manager.sendCommand({ action: 'get_tabs', requestId: 'x' }, 2_000);
    expect(res.success).toBe(true);
    ws.close();
  });
});

describe('ws-bridge liveness and connection choice', () => {
  it('terminates a socket that stops answering pings (half-open)', async () => {
    const { manager, port } = await startBridge({ heartbeatIntervalMs: 40 });
    const { ws } = await authenticate(port, TOKEN, { autoPong: false });
    await waitFor(() => manager.nativeHostCount === 1);
    await closed(ws);
    await waitFor(() => manager.nativeHostCount === 0);
  });

  it('keeps a socket that answers pings', async () => {
    const { manager, port } = await startBridge({ heartbeatIntervalMs: 150 });
    const { ws } = await authenticate(port);
    await sleep(500); // three ping rounds
    expect(ws.readyState).toBe(ws.OPEN);
    expect(manager.nativeHostCount).toBe(1);
    ws.close();
  });

  it('sends commands to the earliest live Native Host, not the newest', async () => {
    const { manager, port } = await startBridge({ probeTimeoutMs: 50 });
    const first = await authenticate(port);
    await waitFor(() => manager.nativeHostCount === 1);
    const firstId = manager.getActiveBrowser()?.id;
    const second = await authenticate(port);
    await waitFor(() => manager.nativeHostCount === 2);
    await sleep(100); // the probe of the first one succeeds
    expect(manager.nativeHostCount).toBe(2);
    expect(manager.getActiveBrowser()?.id).toBe(firstId);
    first.ws.close();
    second.ws.close();
  });

  it('drops an older Native Host that fails the probe when a new one connects', async () => {
    const { manager, port } = await startBridge({ probeTimeoutMs: 50 });
    const stale = await authenticate(port, TOKEN, { autoPong: false });
    await waitFor(() => manager.nativeHostCount === 1);
    const fresh = await authenticate(port);
    await closed(stale.ws);
    await waitFor(() => manager.nativeHostCount === 1);
    // The survivor is the fresh one: a command reaches it.
    const got = nextFrame(fresh.ws);
    void manager.sendCommand({ action: 'get_tabs', requestId: 'x' }, 200);
    expect((await got)['action']).toBe('get_tabs');
    fresh.ws.close();
  });
});
