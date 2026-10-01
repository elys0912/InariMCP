import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/relay/daemon-client.js';
import { getConnectionManager } from '../src/connection/manager.js';
import { startHttpBridge } from '../src/transport/http-bridge.js';
import { AUTH_HEADER, DAEMON_PROTOCOL_VERSION } from '@kitsune-mcp/shared/node';
import { TOKEN } from './helpers/ws.js';

// HOME / USERPROFILE point at a temporary directory: tests/setup/isolate-home.ts

let servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
});

function portOf(s: http.Server): number {
  return (s.address() as AddressInfo).port;
}

async function realDaemon(): Promise<number> {
  const s = await startHttpBridge({ host: '127.0.0.1', port: 0, apiToken: TOKEN, connectionManager: getConnectionManager() });
  servers.push(s);
  return portOf(s);
}

/** A program on the port that looks like the daemon but has no token. */
async function impostor(protocol: number | 'omit' = DAEMON_PROTOCOL_VERSION): Promise<{ port: number; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const s = http.createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => {
      const body =
        req.url === '/health'
          ? JSON.stringify({ status: 'ok', service: 'kitsune-mcp', ...(protocol === 'omit' ? {} : { protocol }) })
          : JSON.stringify({ success: true, result: { content: [{ type: 'text', text: 'forged' }] } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return { port: portOf(s), seen };
}

function client(port: number, token: string | undefined = TOKEN): DaemonClient {
  return new DaemonClient('test', { host: '127.0.0.1', port, readToken: () => token });
}

describe('DaemonClient against the real daemon', () => {
  it('runs a tool call over a signed request and accepts the signed answer', async () => {
    const c = client(await realDaemon());
    expect(await c.checkHealth()).toBe(true);
    expect(c.protocolMismatch()).toBeUndefined();
    const result = await c.callTool('fox_safety_status', {});
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('readOnly');
  });

  it('reads /daemon/info (settingsMismatch) over a signed request', async () => {
    const c = client(await realDaemon());
    await expect(c.settingsMismatch()).resolves.toEqual(expect.any(Array));
  });
});

describe('DaemonClient against an impostor', () => {
  it('never sends the token, and discards the unsigned answer', async () => {
    const { port, seen } = await impostor();
    const c = client(port);
    expect(await c.checkHealth()).toBe(true);
    const result = await c.callTool('fox_safety_status', {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not signed by the KitsuneMCP daemon/);
    expect(JSON.stringify(result.content)).not.toContain('forged');
    for (const headers of seen) {
      expect(JSON.stringify(headers)).not.toContain(TOKEN);
      expect(headers['x-api-key']).toBeUndefined();
    }
    expect(seen.some((h) => typeof h[AUTH_HEADER.signature] === 'string')).toBe(true);
  });

  it('ignores unsigned /daemon/info settings', async () => {
    const { port } = await impostor();
    await expect(client(port).settingsMismatch()).resolves.toEqual([]);
  });

  it('unsigned /daemon/info that reports other settings is unknown (null), not a mismatch', async () => {
    // Settings that would differ from this session's if they were believed.
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          pid: 1,
          settings: { FOX_READ_ONLY: '1', FOX_SAFETY_CONFIG: 'forged.json' },
          effectiveSettings: { FOX_READ_ONLY: 'on', FOX_SAFETY_CONFIG: 'forged.json' },
        }));
      });
    });
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    servers.push(s);
    const c = client(portOf(s));
    await expect(c.checkSettings()).resolves.toBeNull();
    await expect(c.settingsMismatch()).resolves.toEqual([]);
    // Without a token there is nothing to verify with: also unknown.
    await expect(client(portOf(s), undefined).checkSettings()).resolves.toBeNull();
  });
});

describe('DaemonClient against an older daemon', () => {
  it('reports the protocol mismatch instead of calling (no token fallback)', async () => {
    const { port, seen } = await impostor('omit'); // old /health: no protocol field
    const c = client(port);
    expect(await c.checkHealth()).toBe(true);
    expect(c.protocolMismatch()).toMatch(/another version/);
    const result = await c.callTool('fox_safety_status', {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Stop that daemon/);
    expect(seen.every((h) => h[AUTH_HEADER.signature] === undefined)).toBe(true); // /health only
  });

  it('recovers once the old daemon is gone and a matching one answers', async () => {
    const old = await impostor('omit');
    const c = client(old.port);
    await c.checkHealth();
    expect(c.protocolMismatch()).toBeDefined();

    // The user stops the old daemon: nothing answers any more.
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    expect(await c.checkHealth()).toBe(false);
    expect(c.protocolMismatch()).toBeUndefined();
  });

  it('re-checks /health before refusing a call', async () => {
    const old = await impostor('omit');
    const c = client(old.port);
    await c.checkHealth();
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    // No mismatch error any more; the call now fails for the real reason
    // (nothing listens — in a live relay ensureDaemon() would start one).
    const result = await c.callTool('fox_safety_status', {});
    expect(JSON.stringify(result.content)).not.toMatch(/another version/);
  });
});

describe('DaemonClient and oversized calls', () => {
  it('reports the size limit for an (unsigned) 413 instead of blaming an impostor', async () => {
    const c = client(await realDaemon());
    await c.checkHealth();
    const result = await c.callTool('fox_type', { text: 'x'.repeat(1_100_000) });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/request size limit/);
  });
});
