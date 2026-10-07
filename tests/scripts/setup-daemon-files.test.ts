/**
 * The daemon probe, the file helpers (writeFileAtomic / removeTreeSafe) and
 * the scripts' copy of the daemon authentication (scripts/lib/core.mjs /
 * scripts/lib/system.mjs). File-system work happens in a temp directory.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as serverAuth from '@kitsune-mcp/shared/node';
import { MAX_PORT as SHARED_MAX_PORT } from '@kitsune-mcp/shared';
import {
  AUTH_HEADER, httpEndpoint, isLoopbackHost, MAX_PORT, computeMac, signPost,
} from '../../scripts/lib/core.mjs';
import {
  RENAME_RETRIES, httpGet, probeDaemon, removeTreeSafe, stopDaemonGracefully, writeFileAtomic,
} from '../../scripts/lib/system.mjs';
import { isWin, useTempDir } from './helpers/test-env.js';

const tmp = useTempDir();

// ---------------------------------------------------------------------------
// Daemon probe
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('probeDaemon', () => {
  const token = 'c'.repeat(64);
  const deps = { httpGet };
  /** Servers of the running test, closed in afterEach. */
  let servers: http.Server[] = [];
  let endpoint: { host: string; port: number };

  async function close(server: http.Server): Promise<void> {
    servers = servers.filter((s) => s !== server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** A loopback HTTP server standing in for the daemon. No real daemon is started. */
  async function serve(handler: http.RequestListener): Promise<http.Server> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    endpoint = { host: '127.0.0.1', port: address.port };
    return server;
  }

  /** A daemon-shaped server; `tweak` breaks one part of the answer. */
  function serveDaemon(
    tweak: { proof?: string | null; pid?: unknown; signature?: string | null } = {},
  ): Promise<http.Server> {
    return serve((req, res) => {
      if (req.url === '/health') {
        const nonce = String(req.headers[AUTH_HEADER.nonce] ?? '');
        const body: Record<string, unknown> = {
          status: 'ok', service: 'kitsune-mcp', version: '9.9.9', browsers_connected: 1,
        };
        if (tweak.proof !== null) body.proof = tweak.proof ?? computeMac(token, 'health', nonce);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      if (req.url === '/daemon/info') {
        const nonce = String(req.headers[AUTH_HEADER.nonce] ?? '');
        const body = JSON.stringify({ pid: 'pid' in tweak ? tweak.pid : 4242 });
        const sig = 'signature' in tweak
          ? tweak.signature
          : computeMac(token, 'http-response', nonce, '200', sha256Hex(body));
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (sig !== null) headers[AUTH_HEADER.signature] = String(sig);
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });
  }

  afterEach(async () => {
    for (const server of [...servers]) await close(server);
  });

  it('kind "none" when nothing listens on the port', async () => {
    const server = await serve((_req, res) => res.end());
    const closed = endpoint;
    await close(server);
    expect(await probeDaemon(deps, closed, token)).toEqual({ kind: 'none' });
  });

  it('kind "foreign" for a server that is not a KitsuneMCP daemon', async () => {
    await serve((_req, res) => res.end('<html>hello</html>'));
    expect(await probeDaemon(deps, endpoint, token)).toEqual({ kind: 'foreign' });
  });

  it('kind "foreign" for JSON with another service name or a non-200 status', async () => {
    const other = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'something-else' }));
    });
    expect(await probeDaemon(deps, endpoint, token)).toEqual({ kind: 'foreign' });
    await close(other);

    await serve((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'kitsune-mcp' }));
    });
    expect(await probeDaemon(deps, endpoint, token)).toEqual({ kind: 'foreign' });
  });

  it('kind "foreign" for a 200 KitsuneMCP answer whose status is not "ok", like kitsuneHealth (R3 N-11)', async () => {
    for (const status of ['starting', '', undefined]) {
      const server = await serve((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status, service: 'kitsune-mcp', version: '1.2.3' }));
      });
      expect(await probeDaemon(deps, endpoint, token), String(status)).toEqual({ kind: 'foreign' });
      await close(server);
    }
  });

  it('unverified when no token is known: /daemon/info is never asked', async () => {
    const urls: string[] = [];
    await serve((req, res) => {
      urls.push(String(req.url));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'kitsune-mcp', version: '1.2.3', browsers_connected: 0 }));
    });
    expect(await probeDaemon(deps, endpoint, undefined)).toEqual({
      kind: 'kitsune', verified: false, pid: undefined, version: '1.2.3', browsers: 0,
    });
    expect(urls).toEqual(['/health']);
  });

  it('unverified when the daemon cannot prove it holds our token', async () => {
    const urls: string[] = [];
    const server = await serveDaemon({ proof: 'd'.repeat(64) });
    server.on('request', (req) => urls.push(String(req.url)));
    const info = await probeDaemon(deps, endpoint, token);
    expect(info).toMatchObject({ kind: 'kitsune', verified: false, pid: undefined });
    expect(urls).toEqual(['/health']); // the token is never sent to an unverified daemon
  });

  it('verified with a pid when both answers are signed correctly', async () => {
    await serveDaemon();
    expect(await probeDaemon(deps, endpoint, token)).toEqual({
      kind: 'kitsune', verified: true, pid: 4242, version: '9.9.9', browsers: 1,
    });
  });

  it('verified but without a pid when the /daemon/info signature is wrong or missing', async () => {
    for (const signature of ['e'.repeat(64), 'not-hex', null]) {
      const server = await serveDaemon({ signature });
      expect(await probeDaemon(deps, endpoint, token)).toMatchObject({ kind: 'kitsune', verified: true, pid: undefined });
      await close(server);
    }
  });

  it('ignores a pid that is not a positive integer', async () => {
    for (const pid of [0, -1, 1.5, 'nope', null]) {
      const server = await serveDaemon({ pid });
      expect(await probeDaemon(deps, endpoint, token)).toMatchObject({ verified: true, pid: undefined });
      await close(server);
    }
  });
});

describe('stopDaemonGracefully', () => {
  const token = 'c'.repeat(64);
  const endpoint = { host: '127.0.0.1', port: 8765 };
  type Answer = { status: number; headers: Record<string, string>; body: Buffer } | null;

  /** POST /daemon/shutdown answered by `post`; /health answers `healthAnswers` times, then goes quiet. */
  function fakeDeps(post: (nonce: string) => Answer, healthAnswers: number) {
    let left = healthAnswers;
    const polls: string[] = [];
    return {
      polls,
      deps: {
        httpPost: async (o: { headers: Record<string, string> }) => post(o.headers[AUTH_HEADER.nonce] ?? ''),
        httpGet: async (o: { urlPath: string }) => {
          polls.push(o.urlPath);
          if (left <= 0) return null;
          left--;
          return { status: 200, headers: {}, body: Buffer.from('{}') };
        },
        sleep: async () => {},
      },
    };
  }

  /** A correctly signed 200 answer to the shutdown request. */
  function signedOk(nonce: string): Answer {
    const body = Buffer.from(JSON.stringify({ stopping: true }));
    const signature = computeMac(token, 'http-response', nonce, '200', sha256Hex(body));
    return { status: 200, headers: { [AUTH_HEADER.signature]: signature }, body };
  }

  it('stopped: signed 200, then /health goes quiet', async () => {
    const { deps, polls } = fakeDeps(signedOk, 2);
    expect(await stopDaemonGracefully(deps, endpoint, token, 0)).toBe('stopped');
    expect(polls).toEqual(['/health', '/health', '/health']);
  });

  it('refused: not 200, or not signed by the daemon', async () => {
    const notFound = fakeDeps(() => ({ status: 404, headers: {}, body: Buffer.from('') }), 0);
    expect(await stopDaemonGracefully(notFound.deps, endpoint, token, 0)).toBe('refused');
    const unsigned = fakeDeps(() => ({ status: 200, headers: {}, body: Buffer.from('{}') }), 0);
    expect(await stopDaemonGracefully(unsigned.deps, endpoint, token, 0)).toBe('refused');
    expect([...notFound.polls, ...unsigned.polls]).toEqual([]);
  });

  it('unanswered: no answer to the shutdown request', async () => {
    const { deps, polls } = fakeDeps(() => null, 0);
    expect(await stopDaemonGracefully(deps, endpoint, token, 0)).toBe('unanswered');
    expect(polls).toEqual([]);
  });

  it('still-running: /health keeps answering past the deadline', async () => {
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 1_000;
      return clock;
    });
    try {
      const { deps } = fakeDeps(signedOk, Number.POSITIVE_INFINITY);
      expect(await stopDaemonGracefully(deps, endpoint, token, 0)).toBe('still-running');
    } finally {
      now.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * The `fsApi` parameter of writeFileAtomic / removeTreeSafe defaults to the
 * whole `node:fs` module, so TypeScript infers that full type for it. The
 * functions only call the handful of entry points below, so the stubs
 * implement exactly those and are narrowed here, once, instead of at every
 * call site.
 */
type FsApi = typeof import('node:fs');
const asFsApi = (stub: FsStub): FsApi => stub as unknown as FsApi;
type FsStub =
  | Pick<FsApi, 'openSync' | 'fsyncSync' | 'closeSync' | 'chmodSync' | 'unlinkSync'> & {
      writeFileSync: (...args: never[]) => unknown;
      renameSync: (from: string, to: string) => void;
    }
  | {
      lstatSync: (p: string) => { isSymbolicLink: () => boolean; isDirectory: () => boolean };
      readdirSync: (p: string) => string[];
      rmSync: (p: string, options?: unknown) => unknown;
    };

describe('writeFileAtomic', () => {
  /**
   * Real fs, with renameSync failing `failures` times with `code` first.
   * `attempts` counts every call; `injected` only the failures made here, so
   * a real rename that fails once more (Windows AV) does not change it.
   */
  function flakyRename(code: string, failures: number) {
    let n = 0;
    let injected = 0;
    return {
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      chmodSync: fs.chmodSync,
      unlinkSync: fs.unlinkSync,
      renameSync: (from: string, to: string) => {
        if (n++ < failures) {
          injected++;
          const err: NodeJS.ErrnoException = new Error(`${code}: busy`);
          err.code = code;
          throw err;
        }
        fs.renameSync(from, to);
      },
      get attempts() {
        return n;
      },
      get injected() {
        return injected;
      },
    };
  }

  it('replaces the file and leaves no temporary file behind', () => {
    const target = path.join(tmp(), 'kitsune_mcp.json');
    fs.writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(tmp())).toEqual(['kitsune_mcp.json']);
  });

  it('creates a file that is not there yet', () => {
    const target = path.join(tmp(), 'kitsune_mcp.json');
    writeFileAtomic(target, 'fresh');
    expect(fs.readFileSync(target, 'utf8')).toBe('fresh');
  });

  it('retries the rename while the target is held open (EPERM / EACCES / EBUSY)', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const target = path.join(tmp(), `retry-${code}.json`);
      const fsApi = flakyRename(code, 2);
      writeFileAtomic(target, code, {}, asFsApi(fsApi));
      expect(fs.readFileSync(target, 'utf8')).toBe(code);
      // two injected failures, then the real rename (retried itself if the OS was busy)
      expect(fsApi.injected).toBe(2);
      expect(fsApi.attempts).toBeGreaterThanOrEqual(3);
      expect(fs.readdirSync(tmp()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }
  });

  it('gives up after RENAME_RETRIES attempts and removes the temporary file', () => {
    const target = path.join(tmp(), 'stubborn.json');
    const fsApi = flakyRename('EBUSY', 99);
    expect(() => writeFileAtomic(target, 'x', {}, asFsApi(fsApi))).toThrow(/EBUSY/);
    expect(fsApi.attempts).toBe(RENAME_RETRIES);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(tmp())).toEqual([]);
  });

  it('does not retry another rename error', () => {
    const target = path.join(tmp(), 'xdev.json');
    const fsApi = flakyRename('EXDEV', 99);
    expect(() => writeFileAtomic(target, 'x', {}, asFsApi(fsApi))).toThrow(/EXDEV/);
    expect(fsApi.attempts).toBe(1);
    expect(fs.readdirSync(tmp())).toEqual([]);
  });

  it('removes the temporary file and keeps the old content when the write fails', () => {
    const target = path.join(tmp(), 'kitsune_mcp.json');
    fs.writeFileSync(target, 'old');
    const fsApi = {
      openSync: fs.openSync,
      writeFileSync: () => {
        const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      },
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      chmodSync: fs.chmodSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    };
    expect(() => writeFileAtomic(target, 'new', {}, asFsApi(fsApi))).toThrow(/ENOSPC/);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(tmp())).toEqual(['kitsune_mcp.json']);
  });

  it.skipIf(isWin)('applies the POSIX mode (the wrapper is 0700, the manifest 0644)', () => {
    const wrapper = path.join(tmp(), 'run-host.sh');
    writeFileAtomic(wrapper, '#!/bin/sh\n', { mode: 0o700 });
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700);

    const manifest = path.join(tmp(), 'kitsune_mcp.json');
    writeFileAtomic(manifest, '{}', { mode: 0o644 });
    expect(fs.statSync(manifest).mode & 0o777).toBe(0o644);

    // replacing an existing file sets the mode again
    writeFileAtomic(wrapper, '#!/bin/sh\n# v2\n', { mode: 0o700 });
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700);
  });
});

/** Can this machine / account create a symlink or a junction? (Windows needs a privilege.) */
const canLink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-link-'));
  try {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

describe('removeTreeSafe', () => {
  it('reports an absent directory and deletes a plain tree', () => {
    expect(removeTreeSafe(path.join(tmp(), 'nope'))).toEqual({ status: 'absent' });

    const root = path.join(tmp(), 'native-host');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run-host.cmd'), '');
    fs.writeFileSync(path.join(root, 'sub', 'kitsune_mcp.json'), '{}');
    expect(removeTreeSafe(root)).toEqual({ status: 'removed' });
    expect(fs.existsSync(root)).toBe(false);
  });

  it.skipIf(!canLink)('refuses a tree that holds a symlink or a junction, and keeps the target', () => {
    const outside = path.join(tmp(), 'precious');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete me');

    const root = path.join(tmp(), 'native-host');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run-host.cmd'), '');
    fs.symlinkSync(outside, path.join(root, 'sub', 'link'), 'junction');

    const res = removeTreeSafe(root);
    expect(res.status).toBe('refused');
    expect(res.links).toEqual([path.join(root, 'sub', 'link')]);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('do not delete me');
  });

  it.skipIf(!canLink)('refuses when the root itself is a link', () => {
    const outside = path.join(tmp(), 'precious');
    fs.mkdirSync(outside);
    const root = path.join(tmp(), 'native-host');
    fs.symlinkSync(outside, root, 'junction');
    expect(removeTreeSafe(root)).toEqual({ status: 'refused', links: [root] });
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses a link reported by the file-system API (no privilege needed)', () => {
    // Same check as above, driven through a stub so it runs where symlinks cannot be created.
    const root = path.join(tmp(), 'native-host');
    const link = path.join(root, 'link');
    const removed: string[] = [];
    const stat = (kind: 'dir' | 'link' | 'file') => ({
      isSymbolicLink: () => kind === 'link',
      isDirectory: () => kind === 'dir',
    });
    const fsApi = {
      lstatSync: (p: string) => stat(p === root ? 'dir' : p === link ? 'link' : 'file'),
      readdirSync: (p: string) => (p === root ? ['link', 'run-host.cmd'] : []),
      rmSync: (p: string) => removed.push(p),
    };
    expect(removeTreeSafe(root, asFsApi(fsApi))).toEqual({ status: 'refused', links: [link] });
    expect(removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Daemon authentication copy
// ---------------------------------------------------------------------------

describe('daemon authentication copy', () => {
  it('computes the same MACs as @kitsune-mcp/shared/node (auth.ts)', () => {
    const token = 'a'.repeat(64);
    expect(computeMac(token, 'health', 'b'.repeat(32))).toBe(serverAuth.computeMac(token, 'health', 'b'.repeat(32)));
  });

  it('signPost signs like signRequest (POST /daemon/shutdown from uninstall.mjs)', () => {
    const token = 'a'.repeat(64);
    const body = JSON.stringify({ force: false });
    const s = signPost(token, '/daemon/shutdown', body, 1_000);
    const nonce = s.headers[AUTH_HEADER.nonce];
    expect(s.nonce).toBe(nonce);
    expect(s.headers[AUTH_HEADER.signature]).toBe(serverAuth.computeMac(
      token, serverAuth.MAC_LABEL.httpRequest, 'POST', '/daemon/shutdown', '1000', nonce, serverAuth.sha256Hex(body),
    ));
  });

  it('isLoopbackHost and MAX_PORT agree with @kitsune-mcp/shared (R2-A V-6, S12)', () => {
    const hosts = [
      'localhost', 'LOCALHOST', ' localhost ', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '::ffff:127.0.0.1',
      '[::FFFF:127.0.0.1]', ' 127.0.0.1	', '0.0.0.0', '', '::', '128.0.0.1', '127.0.0', '10.0.0.1',
      'example.test', 'localhost.example.test', '[::2]', '127.0.0.1.example.test',
    ];
    for (const host of hosts) {
      expect(isLoopbackHost(host), host).toBe(serverAuth.isLoopbackHost(host));
    }
    expect(MAX_PORT).toBe(SHARED_MAX_PORT);
    expect(httpEndpoint({ FOX_HOST: '[::ffff:127.0.0.1]', FOX_HTTP_PORT: String(MAX_PORT) }))
      .toEqual({ host: '::ffff:127.0.0.1', port: MAX_PORT });
    expect(httpEndpoint({ FOX_HTTP_PORT: String(MAX_PORT + 1) }).port).toBe(8765);
  });

  it('httpEndpoint treats an empty or blank variable as unset like @kitsune-mcp/shared (R2-A R-2, R3 N-1)', () => {
    const legacyPort = 9001;
    const legacyHost = '127.0.0.2';
    const legacyPortEnv = { FOX_HTTP_PORT: '', CLAUDE_BROWSER_HTTP_PORT: String(legacyPort) };
    const legacyHostEnv = { FOX_HOST: '', CLAUDE_BROWSER_HOST: legacyHost };
    const emptyEnv = { FOX_HOST: '', FOX_HTTP_PORT: '' };
    const blankEnv = { FOX_HOST: ' ', FOX_HTTP_PORT: ' ', CLAUDE_BROWSER_HTTP_PORT: String(legacyPort) };
    const paddedEnv = { FOX_HOST: ' 127.0.0.1 ', FOX_HTTP_PORT: ' 8765 ' };
    for (const env of [legacyPortEnv, legacyHostEnv, emptyEnv, blankEnv, paddedEnv]) {
      const endpoint = httpEndpoint(env);
      expect(endpoint.port, JSON.stringify(env)).toBe(serverAuth.resolveHttpPort(undefined, env));
      expect(endpoint.host, JSON.stringify(env)).toBe(serverAuth.resolveHost(env));
    }
    expect(httpEndpoint(legacyPortEnv).port).toBe(legacyPort);
    expect(httpEndpoint(legacyHostEnv).host).toBe(legacyHost);
    expect(httpEndpoint(blankEnv)).toEqual({ host: '127.0.0.1', port: legacyPort });
    expect(httpEndpoint(paddedEnv)).toEqual({ host: '127.0.0.1', port: 8765 });
  });
});
