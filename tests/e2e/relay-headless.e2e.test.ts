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
 * after RELAY_TTL (90 s) + idle timeout. The test therefore stops it over
 * its signed POST /daemon/shutdown (graceful: closes Firefox, exits 0) and
 * waits until the PID (GET /daemon/info) is gone and the port is free. Only
 * when that request fails is the process killed (SIGTERM / `taskkill /T /F`)
 * so no Firefox is left behind — and the test fails.
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
import { AUTH_HEADER, signRequest, verifyResponse } from '@inari-mcp/shared/node';

const ENTRY = fileURLToPath(new URL('../../packages/mcp-server/dist/index.js', import.meta.url));
const MARKER = 'inari-e2e-marker-7f3a';
const PAGE = `<!doctype html><html><head><title>Inari E2E</title></head>
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

function readToken(): string | undefined {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.inari-mcp', 'api_token'), 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Last resort when the graceful stop failed: no Firefox may be left behind. */
function killDaemon(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** Signed POST /daemon/shutdown; the daemon exits once its answer is out. */
async function requestShutdown(token: string): Promise<{ status: number; verified: boolean; body: Record<string, unknown> }> {
  const body = JSON.stringify({ force: false });
  const signed = signRequest(token, 'POST', '/daemon/shutdown', body);
  const res = await fetch(`http://127.0.0.1:${httpPort}/daemon/shutdown`, {
    method: 'POST',
    headers: { ...signed.headers, 'Content-Type': 'application/json' },
    body,
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const verified = verifyResponse(token, signed.nonce, res.status, raw, res.headers.get(AUTH_HEADER.signature) ?? undefined);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { status: res.status, verified, body: parsed };
}

async function stopDaemon(): Promise<void> {
  const token = readToken();
  if (daemonPid === undefined && token !== undefined) {
    // Not learned yet (setup failed early): ask the daemon, if any.
    const info = await fetch(`http://127.0.0.1:${httpPort}/daemon/info`, { headers: { 'X-API-Key': token } })
      .then((r) => r.json() as Promise<{ pid?: number }>)
      .catch(() => ({} as { pid?: number }));
    daemonPid = info.pid;
  }
  if (daemonPid === undefined) return;
  const pid = daemonPid;

  let problem: string | undefined;
  if (token === undefined) {
    problem = 'no api_token to sign the shutdown request';
  } else {
    try {
      const reply = await requestShutdown(token);
      if (reply.status !== 200 || !reply.verified) {
        problem = `POST /daemon/shutdown answered ${reply.status} (signed: ${reply.verified}): ${JSON.stringify(reply.body)}`;
      } else if (reply.body['pid'] !== pid) {
        problem = `POST /daemon/shutdown answered for PID ${String(reply.body['pid'])}, expected ${pid}`;
      }
    } catch (err: unknown) {
      problem = `POST /daemon/shutdown failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (problem !== undefined) killDaemon(pid);

  const gone = await waitFor(async () => !pidAlive(pid) && !(await portOpen(httpPort)), 20_000);
  if (!gone) {
    killDaemon(pid);
    throw new Error(`daemon PID ${pid} still running after stop${problem !== undefined ? ` (${problem})` : ''}`);
  }
  if (problem !== undefined) throw new Error(`graceful stop failed, daemon was killed instead: ${problem}`);
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

  client = new Client({ name: 'inari-e2e', version: '0.0.0' });
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
    for (const n of ['fox_navigate', 'fox_read', 'fox_snapshot', 'fox_screenshot', 'fox_safety_status']) {
      expect(names).toContain(n);
    }

    const nav = await client.callTool({ name: 'fox_navigate', arguments: { url: pageUrl } }, undefined, { timeout: 90_000 });
    expect(nav.isError, text(nav)).not.toBe(true);

    // The daemon is up now: learn its PID for the cleanup.
    const token = fs.readFileSync(path.join(os.homedir(), '.inari-mcp', 'api_token'), 'utf-8').trim();
    const info = await fetch(`http://127.0.0.1:${httpPort}/daemon/info`, { headers: { 'X-API-Key': token } })
      .then((r) => r.json() as Promise<{ pid?: number; headless?: boolean }>);
    daemonPid = info.pid;
    expect(info.headless).toBe(true);

    const got = await client.callTool({ name: 'fox_read', arguments: { mode: 'text' } });
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
  // TODO(test): --stop-daemon CLI against this daemon (exit 0, "stopped"); shutdown while a fox_navigate is in flight (drain ≤ 10 s, then exit)

  it('saves the screenshot under the isolated screenshots directory', () => {
    // tests/setup/isolate-home.ts points HOME / USERPROFILE at a temporary
    // directory and clears FOX_SCREENSHOTS_DIR, so the daemon's
    // defaultScreenshotsDir() is ~/.inari-mcp/screenshots inside it.
    const home = os.homedir();
    expect(home.startsWith(os.tmpdir())).toBe(true);
    const dir = path.join(home, '.inari-mcp', 'screenshots');
    const shots = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
    expect(shots.length).toBeGreaterThan(0);
    expect(fs.statSync(path.join(dir, shots[0] as string)).size).toBeGreaterThan(0);
  });

  it('writes the audit log in the temporary home', () => {
    const logPath = path.join(os.homedir(), '.inari-mcp', 'logs', 'audit.jsonl');
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    const entries = lines.map((l) => JSON.parse(l) as { tool: string; decision: string; url: string | null });
    for (const e of entries) {
      expect(typeof e.tool).toBe('string');
      expect(typeof e.decision).toBe('string');
    }
    const nav = entries.find((e) => e.tool === 'fox_navigate');
    expect(nav, JSON.stringify(entries.map((e) => e.tool))).toBeDefined();
    expect(nav?.decision).toBe('allowed');
    expect(nav?.url).toBe(pageUrl);
  });

  it('restarts a killed daemon on the next tool call', async () => {
    expect(daemonPid).toBeDefined();
    const killed = daemonPid as number;

    await stopDaemon();
    daemonPid = undefined;
    expect(await portOpen(httpPort)).toBe(false);

    // ConnectionRefusedError on POST /mcp/call: the relay starts a daemon and
    // retries once (relay/daemon-client.ts callTool).
    const nav = await client.callTool({ name: 'fox_navigate', arguments: { url: pageUrl } }, undefined, { timeout: 120_000 });
    expect(nav.isError, text(nav)).not.toBe(true);

    const token = fs.readFileSync(path.join(os.homedir(), '.inari-mcp', 'api_token'), 'utf-8').trim();
    const info = await fetch(`http://127.0.0.1:${httpPort}/daemon/info`, { headers: { 'X-API-Key': token } })
      .then((r) => r.json() as Promise<{ pid?: number; headless?: boolean }>);
    daemonPid = info.pid;
    expect(info.headless).toBe(true);
    expect(daemonPid).toBeDefined();
    expect(daemonPid).not.toBe(killed);

    const got = await client.callTool({ name: 'fox_read', arguments: { mode: 'text' } });
    expect(got.isError, text(got)).not.toBe(true);
    expect(text(got)).toContain(MARKER);
  }, 240_000);
});
