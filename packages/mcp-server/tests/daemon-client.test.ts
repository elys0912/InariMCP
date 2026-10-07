import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../src/relay/daemon-client.js';
import { getConnectionManager } from '../src/connection/manager.js';
import { startHttpBridge } from '../src/transport/http-bridge.js';
import { AUTH_HEADER, DAEMON_PROTOCOL_VERSION } from '@kitsune-mcp/shared/node';
import { effectiveDaemonSettings, snapshotDaemonSettings } from '../src/utils/endpoint.js';
import { TOKEN, waitFor } from './helpers/ws.js';

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

/** The HTTP bridge as the daemon runs it; `info` as daemon/main.ts gives it when wanted. */
async function realDaemon(withInfo = false): Promise<number> {
  const info = withInfo
    ? () => ({ settings: snapshotDaemonSettings(), effectiveSettings: effectiveDaemonSettings(process.env) })
    : undefined;
  const s = await startHttpBridge({ host: '127.0.0.1', port: 0, apiToken: TOKEN, connectionManager: getConnectionManager(), info });
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

/** `null`: no token to sign with (`undefined` would take the default). */
function client(port: number, token: string | null = TOKEN): DaemonClient {
  return new DaemonClient('test', { host: '127.0.0.1', port, readToken: () => token ?? undefined });
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

  it('reads /daemon/info (checkSettings) over a signed request', async () => {
    const c = client(await realDaemon(true));
    // Same process, same settings: no difference.
    await expect(c.checkSettings()).resolves.toEqual([]);
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

  it('ignores unsigned /daemon/info settings (unknown: null)', async () => {
    const { port } = await impostor();
    await expect(client(port).checkSettings()).resolves.toBeNull();
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
    // Without a token there is nothing to verify with: also unknown.
    await expect(client(portOf(s), null).checkSettings()).resolves.toBeNull();
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

describe('DaemonClient: refused signature (X-3 / L-4)', () => {
  const other = 'e'.repeat(64);

  it('tool call: one fixed message, the unsigned body is not passed on', async () => {
    const c = client(await realDaemon(), other);
    await c.checkHealth();
    const text = JSON.stringify((await c.callTool('fox_safety_status', {})).content);
    expect(text).toMatch(/refused this session's signature/);
    expect(text).not.toContain('Unauthorized');
  });

  it('tool call: reads the token again once after an unsigned 403, then succeeds', async () => {
    const port = await realDaemon();
    let reads = 0;
    const c = new DaemonClient('test', {
      host: '127.0.0.1',
      port,
      readToken: () => (reads++ === 0 ? other : TOKEN),
    });
    await c.checkHealth();
    const result = await c.callTool('fox_safety_status', {});
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('readOnly');
    expect(reads).toBe(2);
  });

  it('approval: the same message as the tool call', async () => {
    const c = client(await realDaemon(), other);
    const reply = await c.reportElicitation('req-x', true);
    expect(reply).toMatchObject({ success: false, approved: false });
    expect(reply.error).toMatch(/refused this session's signature/);
  });
});

describe('DaemonClient: elicitation answer refused by the daemon (X-1)', () => {
  it('keeps reason elicitation_disabled from the signed 403', async () => {
    vi.stubEnv('FOX_APPROVAL_ELICITATION', '0');
    try {
      const c = client(await realDaemon());
      const reply = await c.reportElicitation('req-x', true);
      expect(reply).toMatchObject({ success: false, approved: false, reason: 'elicitation_disabled' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('DaemonClient.stopDaemon: failures', () => {
  it('nothing answers: ok, nothing stopped', async () => {
    const { port } = await impostor();
    const s = servers.pop();
    s?.closeAllConnections();
    await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
    await expect(client(port).stopDaemon()).resolves.toMatchObject({ ok: true, stopped: false });
  });

  it('no token to sign with', async () => {
    const r = await client(await realDaemon(), null).stopDaemon();
    expect(r).toMatchObject({ ok: false, stopped: false });
    expect(r.message).toMatch(/no API token at .*api_token/);
  });

  it('an unsigned answer is not trusted', async () => {
    const { port } = await impostor();
    const r = await client(port).stopDaemon();
    expect(r).toMatchObject({ ok: false, stopped: false });
    expect(r.message).toMatch(/not signed by the KitsuneMCP daemon/);
  });

  it('a signed refusal (not 200) is reported with its error', async () => {
    // No shutdown hooks: the route answers 501.
    const r = await client(await realDaemon()).stopDaemon();
    expect(r).toMatchObject({ ok: false, stopped: false });
    expect(r.message).toBe('the daemon refused to stop: This daemon cannot be stopped over HTTP');
  });

  it('a daemon that accepted but still answers after waitMs', async () => {
    const s = await startHttpBridge({
      host: '127.0.0.1', port: 0, apiToken: TOKEN, connectionManager: getConnectionManager(),
      shutdown: { prepare: () => Promise.resolve({}), exit: () => undefined },
    });
    servers.push(s);
    const r = await client(portOf(s)).stopDaemon(false, 500);
    expect(r).toMatchObject({ ok: false, stopped: false, pid: process.pid });
    expect(r.message).toMatch(/accepted the stop request but still answers after 0\.5s/);
  });
});

describe('DaemonClient: daemon shutting down (Q-6)', () => {
  it('waits for the stopping daemon to go away and sends the call once more', async () => {
    let releaseShutdown: ((v: Record<string, unknown>) => void) | undefined;
    const stopping = await startHttpBridge({
      host: '127.0.0.1', port: 0, apiToken: TOKEN, connectionManager: getConnectionManager(),
      shutdown: {
        prepare: () => new Promise((resolve) => { releaseShutdown = resolve; }),
        exit: () => undefined,
      },
    });
    servers.push(stopping);
    const port = portOf(stopping);
    const c = client(port);
    await c.checkHealth();
    // Put the daemon into "shutting down" (the answer waits for prepare).
    const stopRequest = c.stopDaemon(false, 5_000);
    await waitFor(() => releaseShutdown !== undefined);

    // The next daemon comes up on the same port once the old one is gone.
    const ensure = vi.spyOn(c, 'ensureDaemon').mockImplementation(async () => {
      servers.push(await startHttpBridge({ host: '127.0.0.1', port, apiToken: TOKEN, connectionManager: getConnectionManager() }));
      return true;
    });
    setTimeout(() => {
      releaseShutdown?.({});
      servers.splice(servers.indexOf(stopping), 1);
      stopping.closeAllConnections();
      stopping.close();
    }, 300);

    const result = await c.callTool('fox_safety_status', {});
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('readOnly');
    expect(ensure).toHaveBeenCalledTimes(1);
    await stopRequest;
  });
});
