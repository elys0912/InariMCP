import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV } from '@inari-mcp/shared';
import { DAEMON_PROTOCOL_VERSION, loadOrCreateApiToken } from '@inari-mcp/shared/node';
import { getConnectionManager } from '../src/connection/manager.js';
import { probeExistingDaemon } from '../src/daemon/probe.js';
import { occupiedPortExit, runDaemon } from '../src/daemon/main.js';
import { startHttpBridge } from '../src/transport/http-bridge.js';
import { TOKEN } from './helpers/ws.js';

let servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
  for (const name of [ENV.FOX_HOST, ENV.FOX_HTTP_PORT, ENV.FOX_WS_PORT]) delete process.env[name];
  vi.restoreAllMocks();
});

function portOf(s: http.Server): number {
  return (s.address() as AddressInfo).port;
}

/** A listening HTTP server (registered for cleanup) with the given handler. */
async function listen(handler: http.RequestListener): Promise<http.Server> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  return s;
}

/** A port nobody listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe('probeExistingDaemon (singleton check, Q1)', () => {
  it('a daemon holding our token proves it', async () => {
    const s = await startHttpBridge({ host: '127.0.0.1', port: 0, apiToken: TOKEN, connectionManager: getConnectionManager() });
    servers.push(s);
    expect((await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).kind).toBe('ok');
  });

  it('a port that only claims to be the daemon is not taken for one', async () => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'inari-mcp', protocol: DAEMON_PROTOCOL_VERSION }));
    });
    servers.push(s);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    expect((await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).kind).toBe('impostor');
  });

  it('a daemon of another protocol is incompatible, with its protocol and version', async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'inari-mcp',
        protocol: DAEMON_PROTOCOL_VERSION + 1,
        version: '0.0.1',
      }));
    });
    expect(await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).toEqual({
      kind: 'incompatible',
      protocol: DAEMON_PROTOCOL_VERSION + 1,
      version: '0.0.1',
    });
  });

  it('an answer from another program is foreign', async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>some other server</html>');
    });
    expect((await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).kind).toBe('foreign');
  });

  it('a non-200 answer is foreign', async () => {
    const s = await listen((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'inari-mcp', protocol: DAEMON_PROTOCOL_VERSION }));
    });
    expect((await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).kind).toBe('foreign');
  });

  it('nothing listening is down', async () => {
    expect((await probeExistingDaemon('127.0.0.1', await closedPort(), TOKEN)).kind).toBe('down');
  });

  it('a port that never answers is down (probe timeout)', async () => {
    const s = await listen(() => { /* never answers */ });
    expect((await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).kind).toBe('down');
  }, 10_000);
});

/** Run the daemon against a taken HTTP port and report the exit code it chose (exit injected). */
async function exitCodeFor(port: number): Promise<number | undefined> {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.env[ENV.FOX_HOST] = '127.0.0.1';
  process.env[ENV.FOX_HTTP_PORT] = String(port);
  process.env[ENV.FOX_WS_PORT] = String(port);
  const codes: number[] = [];
  await runDaemon({ exit: (code) => { codes.push(code); } });
  expect(codes).toHaveLength(1);
  return codes[0];
}

describe('occupiedPortExit (R-11: the decision, without exiting)', () => {
  it('0 only for a daemon that proved our token', () => {
    expect(occupiedPortExit({ kind: 'ok' }, 'h', 1).code).toBe(0);
    for (const occupant of [
      { kind: 'impostor' },
      { kind: 'incompatible', protocol: 9, version: '0.0.1' },
      { kind: 'foreign' },
      { kind: 'down' },
      { kind: 'unverified' },
    ] as const) {
      expect(occupiedPortExit(occupant, 'h', 1).code, occupant.kind).toBe(1);
    }
  });

  it('names the occupant and what to do', () => {
    expect(occupiedPortExit({ kind: 'impostor' }, 'h', 1).message).toMatch(/cannot prove it holds .*Stop it, or set FOX_HTTP_PORT/);
    expect(occupiedPortExit({ kind: 'incompatible', protocol: 9, version: '0.0.1' }, 'h', 1).message).toContain('(9, v0.0.1)');
    expect(occupiedPortExit({ kind: 'foreign' }, 'h', 1).message).toMatch(/another program\. Set FOX_HTTP_PORT/);
  });
});

describe('runDaemon when the HTTP port is already taken (singleton lock)', () => {
  it('exits 0 when the port belongs to a daemon holding our token', async () => {
    const s = await startHttpBridge({
      host: '127.0.0.1',
      port: 0,
      apiToken: loadOrCreateApiToken(),
      connectionManager: getConnectionManager(),
    });
    servers.push(s);
    expect(await exitCodeFor(portOf(s))).toBe(0);
  });

  it('exits 1 when the occupant cannot prove it holds our token', async () => {
    loadOrCreateApiToken();
    const s = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'inari-mcp', protocol: DAEMON_PROTOCOL_VERSION }));
    });
    expect(await exitCodeFor(portOf(s))).toBe(1);
  });

  it('exits 1 when the occupant is a daemon of another protocol', async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'inari-mcp', protocol: DAEMON_PROTOCOL_VERSION + 1 }));
    });
    expect(await exitCodeFor(portOf(s))).toBe(1);
  });

  it('exits 1 when the port is held by another program', async () => {
    const s = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not a daemon');
    });
    expect(await exitCodeFor(portOf(s))).toBe(1);
  });
});
