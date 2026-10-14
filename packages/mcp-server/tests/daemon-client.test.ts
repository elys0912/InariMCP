import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../src/relay/daemon-client.js';
import { getConnectionManager } from '../src/connection/manager.js';
import { startHttpBridge } from '../src/transport/http-bridge.js';
import { AUTH_HEADER, DAEMON_PROTOCOL_VERSION } from '@inari-mcp/shared/node';
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
          ? JSON.stringify({ status: 'ok', service: 'inari-mcp', ...(protocol === 'omit' ? {} : { protocol }) })
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
  // The call body (arguments, approval token) must not go out before the answer is checked.
  it('sends no call to a /health without a valid proof: only nonce-carrying /health requests', async () => {
    const { port, seen } = await impostor();
    const c = client(port);
    expect(await c.checkHealth()).toBe(true);
    const result = await c.callTool('fox_type', { text: 'secret input' }, undefined, 'kat_' + 'x'.repeat(43));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot prove it holds this session's API token/);
    expect(JSON.stringify(result.content)).toMatch(/The call was not sent/);
    expect(JSON.stringify(result.content)).not.toContain('forged');
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(JSON.stringify(headers)).not.toContain(TOKEN);
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers[AUTH_HEADER.signature]).toBeUndefined();
      expect(typeof headers[AUTH_HEADER.nonce]).toBe('string');
      expect(headers['content-length']).toBeUndefined();
    }
  });

  it('sends no call to a program whose /health is not that of the daemon', async () => {
    const seen: string[] = [];
    const s = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello');
      });
    });
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    servers.push(s);
    const result = await client(portOf(s)).callTool('fox_safety_status', {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/is not the InariMCP daemon/);
    expect(seen.every((line) => line === 'GET /health')).toBe(true);
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

  it('tool call: the proof of /health fails for another token, so nothing is sent', async () => {
    const c = client(await realDaemon(), other);
    await c.checkHealth();
    const text = JSON.stringify((await c.callTool('fox_safety_status', {})).content);
    expect(text).toMatch(/api_token was replaced since the daemon started/);
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
    expect(reply.error).toMatch(/api_token was replaced since the daemon started/);
  });

  it('approval: reads the token again once when the proof fails for the first one, then reaches the daemon', async () => {
    const port = await realDaemon();
    let reads = 0;
    const c = new DaemonClient('test', {
      host: '127.0.0.1',
      port,
      readToken: () => (reads++ === 0 ? other : TOKEN),
    });
    const reply = await c.reportElicitation('req-x', true);
    // Signed by the daemon: it does not know the request.
    expect(reply.error).not.toMatch(/api_token was replaced|refused this session's signature/);
    expect(reads).toBe(2);
  });
});

describe('DaemonClient: approvals to an impostor (nothing is sent before the daemon proves the token)', () => {
  it('sends neither the elicitation answer nor the browser request to a /health without a valid proof', async () => {
    const { port, seen } = await impostor();
    const c = client(port);
    for (const reply of [await c.reportElicitation('req-x', true), await c.askBrowser('req-x')]) {
      expect(reply).toMatchObject({ success: false, approved: false });
      expect(reply.error).toMatch(/cannot prove it holds this session's API token/);
      expect(reply.error).toMatch(/The answer was not sent/);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers[AUTH_HEADER.signature]).toBeUndefined();
      expect(headers['content-length']).toBeUndefined();
    }
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

  // The signed stop request must not go out before the proof is checked.
  it('sends no stop request to a /health without a valid proof', async () => {
    const { port, seen } = await impostor();
    const r = await client(port).stopDaemon();
    expect(r).toMatchObject({ ok: false, stopped: false });
    expect(r.message).toMatch(/cannot prove it holds this session's API token/);
    expect(r.message).toMatch(/The stop request was not sent/);
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers[AUTH_HEADER.signature]).toBeUndefined();
      expect(headers['content-length']).toBeUndefined();
    }
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

/**
 * Forwards every request to the daemon on `target`, holding the first
 * /health back for `delayMs` (a daemon busy for a moment).
 */
async function slowFirstHealth(target: number, delayMs: number): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  let delayed = false;
  const s = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.on('error', () => undefined);
    const forward = (): void => {
      const upstream = http.request(
        { host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    };
    if (req.url === '/health' && !delayed) {
      delayed = true;
      setTimeout(forward, delayMs);
    } else {
      forward();
    }
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return { port: portOf(s), seen };
}

describe('DaemonClient: slow /health (a busy daemon is not taken for a missing one)', () => {
  // Longer than the first wait for /health (HEALTH_PROBE_TIMEOUT_MS, 2 s), shorter than the second.
  const BUSY_DELAY_MS = 2_500;

  it('asks /health once more with a longer wait instead of starting a daemon and failing the call', async () => {
    const { port, seen } = await slowFirstHealth(await realDaemon(), BUSY_DELAY_MS);
    const c = client(port);
    const ensure = vi.spyOn(c, 'ensureDaemon').mockResolvedValue(false);

    const result = await c.callTool('fox_safety_status', {});

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('readOnly');
    expect(ensure).not.toHaveBeenCalled();
    expect(seen).toEqual(['GET /health', 'GET /health', 'POST /mcp/call']);
  }, 15_000);
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
