/**
 * Contract: one version for the whole repository. The root package.json,
 * every workspace package.json and the Extension's manifest.json carry the
 * same version, and the runtime constants are read from package.json (no
 * literal copies in the sources).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { signRequest } from '@inari-mcp/shared/node';
import { PACKAGE_VERSION } from '../../packages/mcp-server/src/version.js';
import { HOST_VERSION } from '../../packages/native-host/src/version.js';
import { startHttpBridge } from '../../packages/mcp-server/src/transport/http-bridge.js';
import { getConnectionManager } from '../../packages/mcp-server/src/connection/manager.js';
import { runStdinLoop } from '../../packages/native-host/src/host.js';
import type { ServerLauncher } from '../../packages/native-host/src/server-launcher.js';
import type { ServerConnection } from '../../packages/native-host/src/ws-client.js';
import { captureStdout, fakeStdin, frame } from '../../packages/native-host/tests/helpers/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function versionOf(rel: string): unknown {
  return (JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8')) as Record<string, unknown>)['version'];
}

const FILES = [
  'package.json',
  'packages/shared/package.json',
  'packages/mcp-server/package.json',
  'packages/native-host/package.json',
  'packages/extension/package.json',
  'packages/extension/manifest.json',
];

describe('versions', () => {
  it('all package.json files and manifest.json agree', () => {
    const versions = Object.fromEntries(FILES.map((f) => [f, versionOf(f)]));
    const expected = versionOf('packages/extension/manifest.json');
    expect(versions).toEqual(Object.fromEntries(FILES.map((f) => [f, expected])));
  });

  it('runtime constants come from package.json', () => {
    expect(PACKAGE_VERSION).toBe(versionOf('packages/mcp-server/package.json'));
    expect(HOST_VERSION).toBe(versionOf('packages/native-host/package.json'));
  });

  it('no version literal is left in packages/*/src outside version.ts', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && entry.name !== 'version.ts') {
          const text = fs.readFileSync(full, 'utf-8');
          for (const m of text.matchAll(/(['"`])v?\d+\.\d+\.\d+\1/g)) found.push(`${path.relative(root, full)}: ${m[0]}`);
        }
      }
    };
    for (const pkg of fs.readdirSync(path.join(root, 'packages'))) {
      const src = path.join(root, 'packages', pkg, 'src');
      if (fs.existsSync(src)) walk(src);
    }
    expect(found).toEqual([]);
  });

  it('GET /health and /daemon/info report PACKAGE_VERSION', async () => {
    const token = 'e'.repeat(64);
    const server = await startHttpBridge({ host: '127.0.0.1', port: 0, apiToken: token, connectionManager: getConnectionManager() });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      expect(health['version']).toBe(PACKAGE_VERSION);
      const info = await (await fetch(`${base}/daemon/info`, { headers: signRequest(token, 'GET', '/daemon/info').headers })).json() as Record<string, unknown>;
      expect(info['version']).toBe(PACKAGE_VERSION);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the Native Host status reports HOST_VERSION', async () => {
    const launcher = { host: '127.0.0.1', httpPort: 1, checkHealth: async () => false, fetchDaemonInfo: async () => null } as unknown as ServerLauncher;
    const connection = { url: 'ws://127.0.0.1:1', isConnected: false, send: () => false } as unknown as ServerConnection;
    const stdin = fakeStdin();
    const out = captureStdout();
    try {
      const loop = runStdinLoop(launcher, connection, () => true);
      stdin.stream.write(frame({ action: 'status', requestId: 'v1' }));
      await vi.waitFor(() => expect(Buffer.concat(out.chunks).length).toBeGreaterThan(4));
      const all = Buffer.concat(out.chunks);
      const reply = JSON.parse(all.subarray(4, 4 + all.readUInt32LE(0)).toString('utf-8')) as { native_host: { version: string } };
      expect(reply.native_host.version).toBe(HOST_VERSION);
      stdin.stream.end();
      await loop;
    } finally {
      out.restore();
      stdin.restore();
    }
  });
});
