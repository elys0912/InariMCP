import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getConnectionManager } from '../src/connection/manager.js';
import { isAllowedHostHeader, startHttpBridge, type HttpBridgeOptions } from '../src/transport/http-bridge.js';
import {
  AUTH_HEADER,
  DAEMON_PROTOCOL_VERSION,
  MAC_LABEL,
  computeMac,
  newNonce,
  signRequest,
  verifyResponse,
} from '@kitsune-mcp/shared/node';
import { TOKEN, waitFor } from './helpers/ws.js';

// HOME / USERPROFILE point at a temporary directory: tests/setup/isolate-home.ts

let server: http.Server | undefined;
let port = 0;

async function start(extra: Partial<HttpBridgeOptions> = {}): Promise<void> {
  server = await startHttpBridge({
    host: '127.0.0.1',
    port: 0,
    apiToken: TOKEN,
    connectionManager: getConnectionManager(),
    ...extra,
  });
  port = (server.address() as AddressInfo).port;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  json: Record<string, unknown>;
}

function request(
  method: string,
  urlPath: string,
  headers: http.OutgoingHttpHeaders = {},
  body?: string | Buffer,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function signedGet(urlPath: string, token = TOKEN): Promise<Reply & { nonce: string }> {
  const s = signRequest(token, 'GET', urlPath);
  return request('GET', urlPath, s.headers).then((r) => ({ ...r, nonce: s.nonce }));
}

describe('signed requests', () => {
  it('accepts a signed request and signs the answer', async () => {
    await start();
    const r = await signedGet('/daemon/info');
    expect(r.status).toBe(200);
    expect(r.json['protocol']).toBe(DAEMON_PROTOCOL_VERSION);
    expect(verifyResponse(TOKEN, r.nonce, 200, r.raw, r.headers[AUTH_HEADER.signature])).toBe(true);
  });

  it('rejects a request signed with another token (403, unsigned)', async () => {
    await start();
    const r = await signedGet('/daemon/info', 'e'.repeat(64));
    expect(r.status).toBe(403);
    expect(r.headers[AUTH_HEADER.signature]).toBeUndefined();
  });

  it('rejects a replayed nonce', async () => {
    await start();
    const s = signRequest(TOKEN, 'GET', '/daemon/info');
    expect((await request('GET', '/daemon/info', s.headers)).status).toBe(200);
    expect((await request('GET', '/daemon/info', s.headers)).status).toBe(403);
  });

  it('rejects a stale timestamp', async () => {
    await start();
    const s = signRequest(TOKEN, 'GET', '/daemon/info', '', Date.now() - 5 * 60_000);
    expect((await request('GET', '/daemon/info', s.headers)).status).toBe(403);
  });

  it('rejects a signature made for another path or body', async () => {
    await start();
    const s = signRequest(TOKEN, 'GET', '/mcp/tools');
    expect((await request('GET', '/daemon/info', s.headers)).status).toBe(403);

    const body = JSON.stringify({ name: 'fox_safety_status', arguments: {} });
    const p = signRequest(TOKEN, 'POST', '/mcp/call', body);
    const tampered = JSON.stringify({ name: 'fox_get_tabs', arguments: {} });
    const r = await request('POST', '/mcp/call', { ...p.headers, 'Content-Type': 'application/json' }, tampered);
    expect(r.status).toBe(403);
  });

  it('signs error answers of authenticated requests too', async () => {
    await start();
    const r = await signedGet('/nope');
    expect(r.status).toBe(404);
    expect(verifyResponse(TOKEN, r.nonce, 404, r.raw, r.headers[AUTH_HEADER.signature])).toBe(true);
  });

  it('runs a signed tool call end to end', async () => {
    await start();
    const body = JSON.stringify({ name: 'fox_safety_status', arguments: {} });
    const s = signRequest(TOKEN, 'POST', '/mcp/call', body);
    const r = await request('POST', '/mcp/call', { ...s.headers, 'Content-Type': 'application/json' }, body);
    expect(r.status).toBe(200);
    expect(r.json['success']).toBe(true);
    expect(verifyResponse(TOKEN, s.nonce, 200, r.raw, r.headers[AUTH_HEADER.signature])).toBe(true);
  });

  it('still accepts X-API-Key for manual debugging, unsigned', async () => {
    await start();
    const r = await request('GET', '/daemon/info', { 'X-API-Key': TOKEN });
    expect(r.status).toBe(200);
    expect(r.headers[AUTH_HEADER.signature]).toBeUndefined();
  });
});

describe('/health', () => {
  it('reports service and protocol, and proves the token over a given nonce', async () => {
    await start();
    const nonce = newNonce();
    const r = await request('GET', '/health', { [AUTH_HEADER.nonce]: nonce });
    expect(r.json).toMatchObject({ status: 'ok', service: 'kitsune-mcp', protocol: DAEMON_PROTOCOL_VERSION });
    expect(r.json['proof']).toBe(computeMac(TOKEN, MAC_LABEL.health, nonce));
  });

  it('omits the proof without a (valid) nonce', async () => {
    await start();
    expect((await request('GET', '/health')).json['proof']).toBeUndefined();
    expect((await request('GET', '/health', { [AUTH_HEADER.nonce]: 'zz' })).json['proof']).toBeUndefined();
  });
});

describe('request hygiene', () => {
  it('rejects a DNS-rebinding Host header', async () => {
    await start();
    expect((await request('GET', '/health', { Host: `attacker.example:${port}` })).status).toBe(403);
    expect((await request('GET', '/health', { Host: `localhost:${port}` })).status).toBe(200);
    expect((await request('GET', '/health', { Host: `[::1]:${port}` })).status).toBe(200);
  });

  it('answers 400 to a request target new URL() cannot parse, and keeps serving', async () => {
    await start();
    const status = await new Promise<string>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => { data += d.toString(); });
      sock.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    });
    expect(status).toMatch(/^HTTP\/1\.1 400/);
    expect((await request('GET', '/health')).status).toBe(200);
  });

  it('answers 413 (not 500) to an oversized body', async () => {
    await start();
    const big = Buffer.alloc(1_048_577, 0x20);
    const r = await request('POST', '/mcp/call', { 'X-API-Key': TOKEN, 'Content-Type': 'application/json' }, big);
    expect(r.status).toBe(413);
  });

  it('answers 413 when the body grows past the limit without a Content-Length', async () => {
    await start();
    const r = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/mcp/call', headers: { 'X-API-Key': TOKEN, 'Transfer-Encoding': 'chunked' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      for (let i = 0; i < 20; i++) req.write(Buffer.alloc(65_536, 0x20));
      req.end();
    });
    expect(r).toBe(413);
  });

  it('cuts a signed request whose body does not arrive in time', async () => {
    await start({ bodyTimeoutMs: 300 });
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          'POST /mcp/call HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n' +
          `${AUTH_HEADER.signature}: ${'0'.repeat(64)}\r\n\r\n{"name":`,
        );
      });
      sock.on('error', () => { /* reset is fine */ });
      sock.on('close', () => resolve());
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
  // A slow answer after a body sent at once, and headersTimeout: 'body / header timeouts' at the end of the file.

  it('answers 400 to a JSON body that is not an object', async () => {
    await start();
    const r = await request('POST', '/mcp/call', { 'X-API-Key': TOKEN }, '[1,2]');
    expect(r.status).toBe(400);
  });
});

describe('client abort (5.5)', () => {
  it('cancels the browser command when the caller hangs up', async () => {
    await start();
    const manager = getConnectionManager();
    const sent: { action: string; requestId: string; data?: Record<string, unknown> }[] = [];
    manager.registerBrowser('silent', (m) => { sent.push(m as (typeof sent)[number]); }, 'native-host');
    try {
      const body = JSON.stringify({ name: 'fox_request_approval', arguments: { message: 'ok?' } });
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp/call',
        headers: { 'X-API-Key': TOKEN, 'Content-Type': 'application/json' },
      });
      req.on('error', () => { /* we abort it */ });
      req.end(body);

      await waitFor(() => sent.some((s) => s.action === 'request_approval'));
      req.destroy();
      await waitFor(() => sent.some((s) => s.action === 'cancel_human_wait'));
      const approval = sent.find((s) => s.action === 'request_approval');
      expect(sent.find((s) => s.action === 'cancel_human_wait')?.data).toEqual({ requestId: approval?.requestId });
    } finally {
      manager.unregisterBrowser('silent');
    }
  });
});

describe('POST /daemon/shutdown', () => {
  async function startWithShutdown(): Promise<{ prepared: { force: boolean }[]; exited: () => number }> {
    const prepared: { force: boolean }[] = [];
    let exits = 0;
    server = await startHttpBridge({
      host: '127.0.0.1',
      port: 0,
      apiToken: TOKEN,
      connectionManager: getConnectionManager(),
      shutdown: {
        prepare: async (opts) => { prepared.push(opts); return { waitedMs: 0, drained: true }; },
        exit: () => { exits++; },
      },
    });
    port = (server.address() as AddressInfo).port;
    return { prepared, exited: () => exits };
  }

  it('refuses X-API-Key (403) and never runs the shutdown', async () => {
    const { prepared, exited } = await startWithShutdown();
    const r = await request('POST', '/daemon/shutdown', { 'X-API-Key': TOKEN, 'Content-Type': 'application/json' }, '{}');
    expect(r.status).toBe(403);
    expect(prepared).toEqual([]);
    expect(exited()).toBe(0);
  });

  it('runs the shutdown for a signed request, signs the answer, exits after it', async () => {
    const { prepared, exited } = await startWithShutdown();
    const body = JSON.stringify({ force: true });
    const s = signRequest(TOKEN, 'POST', '/daemon/shutdown', body);
    const r = await request('POST', '/daemon/shutdown', { ...s.headers, 'Content-Type': 'application/json' }, body);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'stopping', pid: process.pid, force: true, drained: true });
    expect(verifyResponse(TOKEN, s.nonce, 200, r.raw, r.headers[AUTH_HEADER.signature])).toBe(true);
    expect(prepared).toEqual([{ force: true }]);
    await waitFor(() => exited() > 0);
    expect(exited()).toBe(1);

    // Tool calls are refused while stopping.
    const call = await request('POST', '/mcp/call', { 'X-API-Key': TOKEN, 'Content-Type': 'application/json' },
      JSON.stringify({ name: 'fox_safety_status', arguments: {} }));
    expect(call.status).toBe(503);
  });

  it('answers 501 when the daemon gave no shutdown hooks', async () => {
    await start();
    const s = signRequest(TOKEN, 'POST', '/daemon/shutdown', '{}');
    expect((await request('POST', '/daemon/shutdown', { ...s.headers, 'Content-Type': 'application/json' }, '{}')).status).toBe(501);
  });

  // TODO(test): a second shutdown request while the first is preparing shares it (repeated: true); non-boolean force → 400;
  //             daemon/main.ts prepareShutdown waits for in-flight calls (activity.waitForIdle) and closes WS clients with 1001
});

describe('isAllowedHostHeader', () => {
  it.each([
    ['127.0.0.1:8765', true],
    ['localhost', true],
    ['LOCALHOST:1', true],
    ['[::1]:8765', true],
    ['10.0.0.5:8765', true],
    ['myhost.local:8765', false],
    ['127.0.0.1.nip.io', false],
    ['[::1', false],
  ])('%s → %s', (hostHeader, allowed) => {
    expect(isAllowedHostHeader(hostHeader, '127.0.0.1')).toBe(allowed);
  });

  it('accepts the configured host name and a missing header', () => {
    expect(isAllowedHostHeader('myhost.local:8765', 'myhost.local')).toBe(true);
    expect(isAllowedHostHeader(undefined, '127.0.0.1')).toBe(true);
  });
});

describe('body / header timeouts', () => {
  it('a body sent at once is not cut while the answer takes longer than the body timeout', async () => {
    await start({ bodyTimeoutMs: 200 });
    const manager = getConnectionManager();
    // A browser that answers every command after 600 ms (3x the body timeout).
    manager.registerBrowser('slow', (m) => {
      setTimeout(() => manager.handleResponse({ requestId: m.requestId, success: true, data: { tabs: [] } }), 600);
    }, 'native-host');
    try {
      const t0 = Date.now();
      const r = await request(
        'POST', '/mcp/call', { 'X-API-Key': TOKEN, 'Content-Type': 'application/json' },
        JSON.stringify({ name: 'fox_get_tabs', arguments: {} }),
      );
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
      expect(r.status).toBe(200);
    } finally {
      manager.unregisterBrowser('slow');
    }
  });

  it('requests may take as long as they need (requestTimeout 0); headers have 10 s', async () => {
    // Node enforces headersTimeout on its connectionsCheckingInterval (30 s),
    // too slow to observe here: the configuration is what is checked.
    await start();
    expect(server!.requestTimeout).toBe(0);
    expect(server!.headersTimeout).toBe(10_000);
  });
});
