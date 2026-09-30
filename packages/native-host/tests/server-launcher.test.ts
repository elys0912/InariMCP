import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerLauncher, daemonEnvNote } from '../src/server-launcher.js';

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
