import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_PROTOCOL_VERSION } from '@kitsune-mcp/shared/node';
import { getConnectionManager } from '../src/connection/manager.js';
import { probeExistingDaemon } from '../src/daemon/probe.js';
import { startHttpBridge } from '../src/transport/http-bridge.js';
import { TOKEN } from './helpers/ws.js';

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

describe('probeExistingDaemon (singleton check, Q1)', () => {
  it('a daemon holding our token proves it', async () => {
    const s = await startHttpBridge({ host: '127.0.0.1', port: 0, apiToken: TOKEN, connectionManager: getConnectionManager() });
    servers.push(s);
    expect((await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).kind).toBe('ok');
  });

  it('a port that only claims to be the daemon is not taken for one', async () => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'kitsune-mcp', protocol: DAEMON_PROTOCOL_VERSION }));
    });
    servers.push(s);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    expect((await probeExistingDaemon('127.0.0.1', portOf(s), TOKEN)).kind).toBe('impostor');
  });
  // TODO(test): incompatible protocol, foreign answer, timeout → down; runDaemon exit codes per verdict
});
