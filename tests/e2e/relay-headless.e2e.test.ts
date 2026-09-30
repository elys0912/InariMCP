/**
 * E2E smoke: MCP client → stdio relay → shared daemon → headless Firefox.
 *
 * Starts `packages/mcp-server/dist/index.js` (build first) the way Claude
 * Code does, with FOX_HEADLESS=1, and drives it over MCP against a local
 * HTTP page. Needs Playwright's Firefox (`npx playwright install firefox`).
 *
 * Isolation: HOME / USERPROFILE point at a temporary directory
 * (tests/setup/isolate-home.ts; token, safety.json, audit log and
 * screenshots go there) and the daemon gets free ports, so a daemon in real
 * use on 8765/8766 is neither reused nor disturbed.
 *
 * Cleanup: the relay spawns the daemon detached, and the daemon only exits
 * after RELAY_TTL (90 s) + idle timeout. The test therefore stops it by PID
 * (GET /daemon/info): SIGTERM on POSIX (graceful: closes Firefox),
 * `taskkill /T /F` on Windows (the process tree, Firefox included), and
 * waits until the PID is gone and the port is free.
 *
 * Run: npm run test:e2e (excluded from npm test).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY = fileURLToPath(new URL('../../packages/mcp-server/dist/index.js', import.meta.url));
const MARKER = 'kitsune-e2e-marker-7f3a';
const PAGE = `<!doctype html><html><head><title>Kitsune E2E</title></head>
<body><h1>${MARKER}</h1><p>Plain page for the relay/headless smoke test.</p>
<button id="go">Go</button></body></html>`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function text(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

let page: http.Server;
let pageUrl: string;
let httpPort: number;
let client: Client;
let daemonPid: number | undefined;

async function stopDaemon(): Promise<void> {
  if (daemonPid === undefined) {
    // Not learned yet (setup failed early): ask the daemon, if any.
    const token = fs.readFileSync(path.join(os.homedir(), '.kitsune-mcp', 'api_token'), 'utf-8').trim();
    const info = await fetch(`http://127.0.0.1:${httpPort}/daemon/info`, { headers: { 'X-API-Key': token } })
      .then((r) => r.json() as Promise<{ pid?: number }>)
      .catch(() => ({} as { pid?: number }));
    daemonPid = info.pid;
  }
  if (daemonPid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(daemonPid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(daemonPid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  const pid = daemonPid;
  const gone = await waitFor(async () => !pidAlive(pid) && !(await portOpen(httpPort)), 20_000);
  if (!gone) throw new Error(`daemon PID ${pid} still running after stop`);
}

beforeAll(async () => {
  if (!fs.existsSync(ENTRY)) throw new Error(`${ENTRY} not found — run npm run build first`);

  page = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => page.listen(0, '127.0.0.1', () => resolve()));
  pageUrl = `http://127.0.0.1:${(page.address() as net.AddressInfo).port}/`;

  httpPort = await freePort();
  const wsPort = await freePort();

  client = new Client({ name: 'kitsune-e2e', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      FOX_HEADLESS: '1',
      FOX_HOST: '127.0.0.1',
      FOX_HTTP_PORT: String(httpPort),
      FOX_WS_PORT: String(wsPort),
      FOX_DAEMON_IDLE_TIMEOUT: '30',
    },
    stderr: 'pipe',
  });
  await client.connect(transport);
}, 90_000);

afterAll(async () => {
  try {
    await client?.close();
  } finally {
    try {
      await stopDaemon();
    } finally {
      await new Promise<void>((resolve) => (page ? page.close(() => resolve()) : resolve()));
    }
  }
}, 60_000);

describe('relay → daemon → headless Firefox', () => {
  it('lists tools, navigates, reads, snapshots, screenshots and reports status', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['fox_navigate', 'fox_get_text', 'fox_snapshot', 'fox_screenshot', 'fox_safety_status']) {
      expect(names).toContain(n);
    }

    const nav = await client.callTool({ name: 'fox_navigate', arguments: { url: pageUrl } }, undefined, { timeout: 90_000 });
    expect(nav.isError, text(nav)).not.toBe(true);

    // The daemon is up now: learn its PID for the cleanup.
    const token = fs.readFileSync(path.join(os.homedir(), '.kitsune-mcp', 'api_token'), 'utf-8').trim();
    const info = await fetch(`http://127.0.0.1:${httpPort}/daemon/info`, { headers: { 'X-API-Key': token } })
      .then((r) => r.json() as Promise<{ pid?: number; headless?: boolean }>);
    daemonPid = info.pid;
    expect(info.headless).toBe(true);

    const got = await client.callTool({ name: 'fox_get_text', arguments: {} });
    expect(got.isError, text(got)).not.toBe(true);
    expect(text(got)).toContain(MARKER);

    const snap = await client.callTool({ name: 'fox_snapshot', arguments: {} });
    expect(snap.isError, text(snap)).not.toBe(true);
    expect(text(snap)).toContain(MARKER);

    const shot = await client.callTool({ name: 'fox_screenshot', arguments: {} });
    expect(shot.isError, text(shot)).not.toBe(true);

    const status = await client.callTool({ name: 'fox_safety_status', arguments: {} });
    expect(status.isError, text(status)).not.toBe(true);
    expect(text(status)).toMatch(/readOnly/);
  }, 180_000);
  // TODO(test): screenshot file lands under the isolated SCREENSHOTS dir; audit log in the temp home; relay restarts a killed daemon
});
