/**
 * Contract: the Native Host's clients (ws-client.ts, server-launcher.ts)
 * authenticate against the daemon's real bridges (ws-bridge.ts,
 * http-bridge.ts) in both directions, and neither side accepts the other
 * when the tokens differ.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocketServer } from 'ws';
import { BrowserConnectionManager, getConnectionManager } from '../../packages/mcp-server/src/connection/manager.js';
import { startWebSocketServer } from '../../packages/mcp-server/src/transport/ws-bridge.js';
import { startHttpBridge } from '../../packages/mcp-server/src/transport/http-bridge.js';
import { ServerConnection } from '../../packages/native-host/src/ws-client.js';
import { ServerLauncher } from '../../packages/native-host/src/server-launcher.js';

const TOKEN = '1'.repeat(64);
const OTHER = '2'.repeat(64);

// HOME / USERPROFILE point at a temporary directory: tests/setup/isolate-home.ts

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function wsBridge(token: string, manager = new BrowserConnectionManager()): Promise<{ port: number; manager: BrowserConnectionManager }> {
  const wss: WebSocketServer = await startWebSocketServer({ host: '127.0.0.1', port: 0, apiToken: token, connectionManager: manager });
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const c of wss.clients) c.terminate();
    wss.close(() => resolve());
  }));
  return { port: (wss.address() as AddressInfo).port, manager };
}

async function httpBridge(token: string): Promise<number> {
  const s: http.Server = await startHttpBridge({ host: '127.0.0.1', port: 0, apiToken: token, connectionManager: getConnectionManager() });
  cleanups.push(() => new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  }));
  return (s.address() as AddressInfo).port;
}

function hostConnection(wsPort: number, token: string, commands: Record<string, unknown>[]): ServerConnection {
  const launcher = new ServerLauncher({ host: '127.0.0.1', httpPort: 1, wsPort, readToken: () => token });
  const c = new ServerConnection(launcher, (cmd) => {
    commands.push(cmd);
    c.send({ requestId: cmd['requestId'], success: true, data: { echoed: cmd['action'] } });
  });
  cleanups.push(() => c.stop());
  c.start();
  return c;
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('WebSocket: daemon ws-bridge ⇔ Native Host ws-client', () => {
  it('authenticate each other and carry a command round trip', async () => {
    const { port, manager } = await wsBridge(TOKEN);
    const commands: Record<string, unknown>[] = [];
    const c = hostConnection(port, TOKEN, commands);
    await waitFor(() => c.isConnected && manager.nativeHostCount === 1);
    const res = await manager.sendCommand({ action: 'get_tabs', requestId: 'x' }, 2_000);
    expect(res).toMatchObject({ success: true, data: { echoed: 'get_tabs' } });
    expect(String(commands[0]?.['requestId'])).toMatch(new RegExp(`^${manager.bootId}-`));
  });

  it('with different tokens neither side registers / connects', async () => {
    const { port, manager } = await wsBridge(TOKEN);
    const c = hostConnection(port, OTHER, []);
    await new Promise((r) => setTimeout(r, 200));
    expect(c.isConnected).toBe(false);
    expect(manager.browserCount).toBe(0);
  });
});

describe('HTTP: daemon http-bridge ⇔ Native Host server-launcher', () => {
  it('health proof and signed /daemon/info verify with the shared token', async () => {
    const port = await httpBridge(TOKEN);
    const launcher = new ServerLauncher({ host: '127.0.0.1', httpPort: port, wsPort: 1, readToken: () => TOKEN });
    expect((await launcher.probeHealth()).kind).toBe('ok');
    expect(await launcher.checkHealth()).toBe(true);
    expect(await launcher.fetchDaemonInfo()).toMatchObject({ relays: 0 });
  });

  it('a daemon with another token is reported as an impostor', async () => {
    const port = await httpBridge(OTHER);
    const launcher = new ServerLauncher({ host: '127.0.0.1', httpPort: port, wsPort: 1, readToken: () => TOKEN });
    expect((await launcher.probeHealth()).kind).toBe('impostor');
    expect(await launcher.fetchDaemonInfo()).toBeNull();
  });
});
