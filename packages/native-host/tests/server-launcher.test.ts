import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerLauncher, daemonEnvNote } from '../src/server-launcher.js';
import {
  AUTH_HEADER,
  DAEMON_PROTOCOL_VERSION,
  MAC_LABEL,
  computeMac,
  newNonce,
  responseMac,
  evaluateHealth,
  isUsable,
  parsePort,
} from '@kitsune-mcp/shared/node';

function listen(): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => sock.destroy());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('ServerLauncher.isPortInUse', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const s of servers.splice(0)) s.close();
  });

  it('checks the given port, defaulting to the HTTP port', async () => {
    const http = await listen();
    servers.push(http);
    const httpPort = (http.address() as net.AddressInfo).port;
    vi.stubEnv('FOX_HOST', '127.0.0.1');
    vi.stubEnv('FOX_HTTP_PORT', String(httpPort));

    const launcher = new ServerLauncher();
    expect(await launcher.isPortInUse()).toBe(true);

    // a port that was just released is free
    const other = await listen();
    const freePort = (other.address() as net.AddressInfo).port;
    await new Promise<void>((r) => other.close(() => r()));
    expect(await launcher.isPortInUse(freePort)).toBe(false);
  });
});

describe('daemonEnvNote', () => {
  it('names the inherited policy settings but never their values', () => {
    const note = daemonEnvNote({ FOX_READ_ONLY: '1', FOX_SAFETY_CONFIG: 'C:\secret\path.json' });
    expect(note).toContain('FOX_READ_ONLY');
    expect(note).toContain('FOX_SAFETY_CONFIG');
    expect(note).not.toContain('secret');
  });

  it('reports when nothing is inherited', () => {
    expect(daemonEnvNote({})).toContain('inherits no');
  });
});


const TOKEN = 'c'.repeat(64);

describe('parsePort (4.A3)', () => {
  it.each([
    ['8765', 8765],
    ['1', 1],
    ['65535', 65535],
  ])('accepts %s', (raw, port) => {
    expect(parsePort(raw, 9)).toBe(port);
  });

  it.each(['0', '-1', '65536', '80.5', 'abc', '1e3x', ' '])('falls back on %j', (raw) => {
    expect(parsePort(raw, 9)).toBe(9);
  });

  it('falls back when unset', () => {
    expect(parsePort(undefined, 9)).toBe(9);
    expect(parsePort('', 9)).toBe(9);
  });
});

describe('evaluateHealth (4.A4)', () => {
  const nonce = newNonce();
  const good = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      status: 'ok',
      service: 'kitsune-mcp',
      version: '0.1.0',
      protocol: DAEMON_PROTOCOL_VERSION,
      proof: computeMac(TOKEN, MAC_LABEL.health, nonce),
      ...extra,
    });

  it('ok: our daemon, proof checked', () => {
    expect(evaluateHealth(200, good(), TOKEN, nonce)).toEqual({ kind: 'ok', version: '0.1.0' });
  });

  it('unverified: compatible, but no token to check the proof yet', () => {
    expect(evaluateHealth(200, good(), undefined, nonce).kind).toBe('unverified');
  });

  it('foreign: anything that merely contains "ok"', () => {
    expect(evaluateHealth(200, 'look, ok!', TOKEN, nonce).kind).toBe('foreign');
    expect(evaluateHealth(200, '{"status":"ok"}', TOKEN, nonce).kind).toBe('foreign');
    expect(evaluateHealth(200, '["ok"]', TOKEN, nonce).kind).toBe('foreign');
    expect(evaluateHealth(500, good(), TOKEN, nonce).kind).toBe('foreign');
  });

  it('incompatible: an older daemon without (or with another) protocol', () => {
    const old = JSON.stringify({ status: 'ok', service: 'kitsune-mcp', version: '0.0.9' });
    expect(evaluateHealth(200, old, TOKEN, nonce)).toEqual({ kind: 'incompatible', protocol: undefined, version: '0.0.9' });
    expect(evaluateHealth(200, good({ protocol: 99 }), TOKEN, nonce).kind).toBe('incompatible');
  });

  it('impostor: a proof that does not match our token / nonce', () => {
    expect(evaluateHealth(200, good({ proof: undefined }), TOKEN, nonce).kind).toBe('impostor');
    expect(evaluateHealth(200, good(), TOKEN, newNonce()).kind).toBe('impostor');
    expect(evaluateHealth(200, good(), 'd'.repeat(64), nonce).kind).toBe('impostor');
  });

  it('only ok / unverified are usable', () => {
    expect(isUsable({ kind: 'ok' })).toBe(true);
    expect(isUsable({ kind: 'unverified' })).toBe(true);
    for (const kind of ['down', 'foreign', 'impostor'] as const) expect(isUsable({ kind })).toBe(false);
    expect(isUsable({ kind: 'incompatible', protocol: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Against HTTP servers
// ---------------------------------------------------------------------------

let servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
});

async function serve(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  servers.push(s);
  return (s.address() as AddressInfo).port;
}

function launcherFor(port: number, token: () => string | undefined = () => TOKEN): ServerLauncher {
  return new ServerLauncher({ host: '127.0.0.1', httpPort: port, wsPort: port + 1, readToken: token });
}

/** A daemon-like server holding `serverToken`. */
function daemonLike(serverToken: string): http.RequestListener {
  return (req, res) => {
    const nonce = req.headers[AUTH_HEADER.nonce];
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'kitsune-mcp',
        protocol: DAEMON_PROTOCOL_VERSION,
        ...(typeof nonce === 'string' ? { proof: computeMac(serverToken, MAC_LABEL.health, nonce) } : {}),
      }));
      return;
    }
    const body = JSON.stringify({ relays: 2, version: '0.1.0' });
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
    if (typeof nonce === 'string') headers[AUTH_HEADER.signature] = responseMac(serverToken, nonce, 200, body);
    res.writeHead(200, headers);
    res.end(body);
  };
}

describe('ServerLauncher probes', () => {
  it('trusts a daemon that proves the token', async () => {
    const launcher = launcherFor(await serve(daemonLike(TOKEN)));
    expect((await launcher.probeHealth()).kind).toBe('ok');
    expect(await launcher.checkHealth()).toBe(true);
  });

  it('reports an impostor after re-reading the token once', async () => {
    let reads = 0;
    const launcher = launcherFor(await serve(daemonLike('e'.repeat(64))), () => { reads++; return TOKEN; });
    const before = reads;
    expect((await launcher.probeHealth()).kind).toBe('impostor');
    expect(reads).toBe(before + 1); // the token cache was dropped and re-read
    expect(await launcher.checkHealth()).toBe(false);
  });

  it('says down when nothing listens', async () => {
    // A port that was free a moment ago
    const port = await serve(() => undefined);
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    expect((await launcherFor(port).probeHealth()).kind).toBe('down');
  });

  it('fetchDaemonInfo accepts only signed answers and never sends the token', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const genuine = await serve((req, res) => { seen.push(req.headers); daemonLike(TOKEN)(req, res); });
    expect(await launcherFor(genuine).fetchDaemonInfo()).toEqual({ relays: 2, version: '0.1.0' });
    expect(JSON.stringify(seen)).not.toContain(TOKEN);

    const forged = await serve(daemonLike('e'.repeat(64)));
    expect(await launcherFor(forged).fetchDaemonInfo()).toBeNull();
  });
});
