import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ServerConnection, type ConnectionTarget } from '../src/ws-client.js';
import { AUTH_PROTOCOL, MAC_LABEL, computeMac, newNonce } from '../src/auth.js';

const TOKEN = 'b'.repeat(64);

let servers: WebSocketServer[] = [];
let tcpServers: net.Server[] = [];
let connections: ServerConnection[] = [];

afterEach(async () => {
  for (const c of connections) c.stop();
  connections = [];
  for (const srv of tcpServers) srv.close();
  tcpServers = [];
  for (const wss of servers) {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
  servers = [];
});

/** Scripted daemon side. `serverToken` is what it proves with. */
type Script = (ws: WebSocket, received: string[]) => void;

async function scriptedServer(script: Script): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => received.push(raw.toString()));
    script(ws, received);
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  servers.push(wss);
  return { port: (wss.address() as AddressInfo).port, received };
}

/** Daemon behaviour: challenge, check the client MAC, answer with a MAC made from `serverToken`. */
function daemonScript(serverToken: string, afterAuth?: (ws: WebSocket) => void): Script {
  return (ws) => {
    const serverNonce = newNonce();
    ws.send(JSON.stringify({ type: 'auth_challenge', protocol: AUTH_PROTOCOL, nonce: serverNonce }));
    ws.once('message', (raw) => {
      const auth = JSON.parse(raw.toString()) as { nonce: string; mac: string };
      if (auth.mac !== computeMac(TOKEN, MAC_LABEL.wsClient, serverNonce, auth.nonce)) {
        ws.close(1008, 'auth failed');
        return;
      }
      ws.send(JSON.stringify({ type: 'auth_ok', mac: computeMac(serverToken, MAC_LABEL.wsServer, serverNonce, auth.nonce) }));
      afterAuth?.(ws);
    });
  };
}

function target(port: number): ConnectionTarget & { reloads: number } {
  const t = {
    host: '127.0.0.1',
    wsPort: port,
    reloads: 0,
    getApiToken: () => TOKEN,
    reloadApiToken: () => { t.reloads++; },
  };
  return t;
}

function open(
  t: ConnectionTarget,
  commands: Record<string, unknown>[] = [],
  options: ConstructorParameters<typeof ServerConnection>[2] = {},
): ServerConnection {
  const c = new ServerConnection(t, (cmd) => commands.push(cmd), options);
  connections.push(c);
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ServerConnection handshake (7.High)', () => {
  it('connects to a daemon that proves the token, then takes commands', async () => {
    const command = { action: 'get_tabs', requestId: 'r-1' };
    const { port, received } = await scriptedServer(daemonScript(TOKEN, (ws) => ws.send(JSON.stringify(command))));
    const commands: Record<string, unknown>[] = [];
    const c = open(target(port), commands);
    await waitFor(() => commands.length === 1);
    expect(c.isConnected).toBe(true);
    expect(commands[0]).toEqual(command);
    expect(received.join('')).not.toContain(TOKEN); // the token itself never travels
  });

  it('refuses a server whose auth_ok MAC is wrong (fake daemon) and ignores its commands', async () => {
    const { port } = await scriptedServer(
      daemonScript('e'.repeat(64), (ws) => ws.send(JSON.stringify({ action: 'get_tabs', requestId: 'evil' }))),
    );
    const t = target(port);
    const commands: Record<string, unknown>[] = [];
    const c = open(t, commands);
    await waitFor(() => t.reloads > 0);
    await sleep(50);
    expect(c.isConnected).toBe(false);
    expect(commands).toEqual([]);
  });

  it('refuses a server that skips the challenge', async () => {
    const { port } = await scriptedServer((ws) => ws.send(JSON.stringify({ type: 'auth_ok' })));
    const t = target(port);
    const c = open(t);
    await waitFor(() => t.reloads > 0);
    expect(c.isConnected).toBe(false);
  });

  it('gives up on a server that never sends a challenge (older daemon), without sending the token', async () => {
    const { port, received } = await scriptedServer(() => { /* old daemon waits for { token } */ });
    const c = open(target(port), [], { authTimeoutMs: 100 });
    await sleep(250);
    expect(c.isConnected).toBe(false);
    expect(received).toEqual([]);
  });
});

describe('ServerConnection upgrade timeout', () => {
  it('gives up on a program that accepts TCP but never answers the upgrade', async () => {
    const sockets: net.Socket[] = [];
    const clientClosed = new Promise<void>((resolve) => {
      const srv = net.createServer((sock) => {
        sockets.push(sock);
        sock.resume(); // read (and ignore) the upgrade request, so the client's FIN is seen
        sock.on('close', () => resolve());
        sock.on('error', () => { /* reset by the client */ });
      });
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as AddressInfo).port;
        open(target(port), [], { authTimeoutMs: 100 });
      });
      tcpServers.push(srv);
    });
    await clientClosed; // the client hung up instead of waiting forever
    expect(sockets).toHaveLength(1);
  });
});

describe('ServerConnection half-open detection', () => {
  it('drops the connection when the server stops pinging', async () => {
    let serverSide: WebSocket | undefined;
    const { port } = await scriptedServer(daemonScript(TOKEN, (ws) => { serverSide = ws; }));
    const c = open(target(port), [], { serverSilenceMs: 100 });
    await waitFor(() => c.isConnected);
    const closedOnServer = new Promise<void>((resolve) => serverSide!.once('close', () => resolve()));
    await closedOnServer;
    expect(c.isConnected).toBe(false);
  });

  it('stays connected while the server pings', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const { port } = await scriptedServer(daemonScript(TOKEN, (ws) => { timer = setInterval(() => ws.ping(), 30); }));
    const c = open(target(port), [], { serverSilenceMs: 100 });
    await waitFor(() => c.isConnected);
    await sleep(300);
    expect(c.isConnected).toBe(true);
    clearInterval(timer);
  });
});
