/**
 * Side effects for scripts/install.mjs and scripts/uninstall.mjs: files,
 * registry (reg.exe), processes, the daemon's HTTP endpoint, prompts.
 *
 * No PowerShell anywhere (it is blocked by policy on some Windows machines):
 * the registry goes through reg.exe, the process list through WMI via
 * cscript (JScript) or wmic.
 *
 * Every function that talks to the outside world goes through `deps`
 * (see defaultDeps) so the tests can replace it.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  AUTH_HEADER, MANIFEST_MODE, SERVICE_NAME, commandInvocation, computeMac, envValue, macMatches, newNonce,
  parsePsOutput, parseTabOutput, pathApi, responseSignatureValid, signGet, signPost,
} from './core.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Time limits (ms) and sizes used here and by install.mjs / uninstall.mjs.
/** Short helper commands: reg.exe, ps, `node --version`. */
export const CMD_TIMEOUT_MS = 20_000;
/** Process listing through cscript / wmic (WMI can be slow). */
const PROCESS_LIST_TIMEOUT_MS = 30_000;
/** Default of runSync; `claude mcp add / remove`. */
export const PROGRAM_TIMEOUT_MS = 120_000;
/** `npm install` / `npm run build` (--build). */
export const NPM_TIMEOUT_MS = 1_800_000;
/** Default of httpGet / httpPost. */
const HTTP_TIMEOUT_MS = 3_000;
/** Larger daemon answers are dropped. */
const MAX_RESPONSE_BYTES = 1_048_576;
/** stopProcess: polling interval, and how long to wait after SIGKILL. */
const PROCESS_POLL_MS = 100;
const KILL_WAIT_MS = 2_000;
/** stopDaemonGracefully: POST /daemon/shutdown waits for running calls to finish. */
const SHUTDOWN_REQUEST_TIMEOUT_MS = 15_000;
/** stopDaemonGracefully: /health polls until the port goes quiet, for at least SHUTDOWN_MIN_WAIT_MS. */
const SHUTDOWN_POLL_MS = 200;
const SHUTDOWN_MIN_WAIT_MS = 2_000;
const HEALTH_POLL_TIMEOUT_MS = 1_000;
/** writeFileAtomic: rename attempts while another process holds the target, and the backoff step. */
export const RENAME_RETRIES = 10;
const RENAME_RETRY_STEP_MS = 50;
/** Rename errors that mean "the target is in use" (Windows), worth another attempt. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export function runSync(file, args, opts = {}) {
  const r = spawnSync(file, args, {
    cwd: opts.cwd,
    encoding: opts.encoding === 'buffer' ? undefined : 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
    windowsVerbatimArguments: Boolean(opts.verbatim),
    timeout: opts.timeoutMs ?? PROGRAM_TIMEOUT_MS,
    shell: false,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

export function defaultDeps() {
  let rl;
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    execPath: process.execPath,
    nodeVersion: process.version,
    pid: process.pid,
    repoRoot: REPO_ROOT,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: (question) => new Promise((resolve) => {
      rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => resolve(answer));
    }),
    closePrompt: () => rl?.close(),
    run: runSync,
    fs,
    httpGet,
    httpPost,
    sleep,
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive,
    readProcVersion: () => {
      try {
        return fs.readFileSync('/proc/version', 'utf8');
      } catch {
        return '';
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function exists(fsApi, p) {
  try {
    fsApi.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * File content, or null when the file does not exist. Any other error
 * (EACCES, EISDIR …) is thrown: "unreadable" must not pass for "absent".
 */
export function readTextOrNull(fsApi, p) {
  try {
    return fsApi.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function blockMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `data` to `target` through a temporary file in the same directory
 * and a rename, so a reader (Firefox, a concurrent installer) sees either the
 * old or the new file, never a partial one (review 4.B4). On Windows the
 * rename is retried while another process has the target open.
 */
export function writeFileAtomic(target, data, { mode } = {}, fsApi = fs) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fsApi.openSync(tmp, 'wx', mode ?? MANIFEST_MODE);
    fsApi.writeFileSync(fd, data);
    fsApi.fsyncSync(fd);
    fsApi.closeSync(fd);
    fd = undefined;
    if (mode !== undefined && process.platform !== 'win32') fsApi.chmodSync(tmp, mode);
    for (let attempt = 0; ; attempt++) {
      try {
        fsApi.renameSync(tmp, target);
        break;
      } catch (err) {
        if (attempt + 1 >= RENAME_RETRIES || !RETRYABLE_RENAME_CODES.has(err && err.code)) throw err;
        blockMs(RENAME_RETRY_STEP_MS * (attempt + 1));
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        fsApi.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fsApi.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/** Symlinks / junctions inside `root` (not followed), or [root] if root is one. */
export function findLinks(root, fsApi = fs) {
  const links = [];
  const walk = (p) => {
    const st = fsApi.lstatSync(p);
    if (st.isSymbolicLink()) {
      links.push(p);
      return;
    }
    if (!st.isDirectory()) return;
    for (const name of fsApi.readdirSync(p)) walk(path.join(p, name));
  };
  walk(root);
  return links;
}

/**
 * Delete a directory tree, refusing when it contains a symlink or junction:
 * the target of the link must not be deleted by mistake.
 * @returns {{status: 'absent'|'removed'|'refused', links?: string[]}}
 */
export function removeTreeSafe(root, fsApi = fs) {
  if (!exists(fsApi, root)) return { status: 'absent' };
  const links = findLinks(root, fsApi);
  if (links.length > 0) return { status: 'refused', links };
  fsApi.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  return { status: 'removed' };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** First match of `name` on PATH (PATHEXT on Windows), or null. */
export function which(name, deps) {
  const { platform, env, fs: fsApi } = deps;
  const p = pathApi(platform);
  const searchPath = envValue(env, 'PATH') ?? envValue(env, 'Path') ?? '';
  const dirs = searchPath.split(platform === 'win32' ? ';' : ':').filter((dir) => dir.trim() !== '');
  const exts = platform === 'win32'
    ? ['', ...(envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir.replace(/^"(.*)"$/, '$1'), name + ext);
      if (platform === 'win32' && ext === '' && !/\.[a-z0-9]+$/i.test(name)) continue;
      try {
        const st = fsApi.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // next
      }
    }
  }
  return null;
}

/** The claude CLI: PATH, then the native installer's default location. */
export function findClaude(deps) {
  const found = which('claude', deps);
  if (found) return found;
  const p = pathApi(deps.platform);
  const candidate = p.join(deps.home, '.local', 'bin', deps.platform === 'win32' ? 'claude.exe' : 'claude');
  return exists(deps.fs, candidate) ? candidate : null;
}

/** Run a program that may be a .cmd shim. */
export function runProgram(deps, file, args, opts = {}) {
  const inv = commandInvocation(file, args, deps.platform, deps.env);
  return deps.run(inv.file, inv.args, { ...opts, verbatim: inv.verbatim });
}

/** npm through the running node when possible (no shell, no .cmd shim). */
export function npmInvocation(deps) {
  const p = pathApi(deps.platform);
  const bundled = deps.platform === 'win32'
    ? p.join(p.dirname(deps.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : p.join(p.dirname(deps.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cli = deps.env.npm_execpath && /npm-cli\.js$/i.test(deps.env.npm_execpath) ? deps.env.npm_execpath : bundled;
  if (exists(deps.fs, cli)) return { file: deps.execPath, prefix: [cli] };
  const npm = which(deps.platform === 'win32' ? 'npm.cmd' : 'npm', deps);
  return npm ? { file: npm, prefix: [] } : null;
}

// ---------------------------------------------------------------------------
// Windows registry (reg.exe)
// ---------------------------------------------------------------------------

export function regQueryDefault(deps, key, parse) {
  const r = deps.run('reg.exe', ['query', key, '/ve'], { timeoutMs: CMD_TIMEOUT_MS });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: true, value: null };
  return { ok: true, value: parse(r.stdout) };
}

export function regSetDefault(deps, key, value) {
  return deps.run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { timeoutMs: CMD_TIMEOUT_MS });
}

export function regDeleteKey(deps, key) {
  return deps.run('reg.exe', ['delete', key, '/f'], { timeoutMs: CMD_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const WMI_QUERY_JS = [
  'var svc = GetObject("winmgmts:");',
  'var e = new Enumerator(svc.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = \'node.exe\'"));',
  'for (; !e.atEnd(); e.moveNext()) { var p = e.item(); WScript.StdOut.WriteLine(p.ProcessId + "\\t" + (p.CommandLine || "")); }',
].join('\r\n');

/**
 * node processes with their command lines, or null when they cannot be
 * listed. Windows: WMI through cscript (JScript), then wmic; Unix: ps.
 */
export function listNodeProcesses(deps) {
  if (deps.platform !== 'win32') {
    const r = deps.run('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'args='], { timeoutMs: CMD_TIMEOUT_MS });
    if (r.error || r.status !== 0) return null;
    return parsePsOutput(r.stdout); // filtered by entry path in classifyProcesses
  }
  const script = path.join(os.tmpdir(), `kitsune-ps-${process.pid}-${crypto.randomBytes(4).toString('hex')}.js`);
  let created = false;
  try {
    // 'wx': never run a script someone else planted under the predictable name.
    deps.fs.writeFileSync(script, WMI_QUERY_JS, { flag: 'wx' });
    created = true;
    const r = deps.run('cscript.exe', ['//NoLogo', '//U', '//E:jscript', script], { encoding: 'buffer', timeoutMs: PROCESS_LIST_TIMEOUT_MS });
    if (!r.error && r.status === 0) return parseTabOutput(Buffer.from(r.stdout).toString('utf16le'));
  } catch {
    // fall through to wmic
  } finally {
    if (created) {
      try {
        deps.fs.unlinkSync(script);
      } catch {
        // ignore
      }
    }
  }
  const w = deps.run('wmic.exe', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:csv'], { timeoutMs: PROCESS_LIST_TIMEOUT_MS });
  if (w.error || w.status !== 0) return null;
  const out = [];
  for (const line of String(w.stdout).split(/\r?\n/)) {
    const m = /^[^,]*,(.*),(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[2]), cmd: m[1] });
  }
  return out;
}

/**
 * Stop a process: SIGTERM, wait up to graceMs, then SIGKILL (review 4.B6).
 * On Windows there is no graceful signal for a console-less node process:
 * process.kill terminates it at once.
 * @returns {Promise<'gone'|'stopped'|'killed'|'failed'>}
 */
export async function stopProcess(deps, pid, graceMs) {
  if (!deps.isAlive(pid)) return 'gone';
  try {
    deps.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err && err.code === 'ESRCH') return 'gone';
    return 'failed';
  }
  const step = PROCESS_POLL_MS;
  for (let waited = 0; waited < graceMs; waited += step) {
    if (!deps.isAlive(pid)) return 'stopped';
    await deps.sleep(step);
  }
  if (!deps.isAlive(pid)) return 'stopped';
  try {
    deps.kill(pid, 'SIGKILL');
  } catch (err) {
    if (err && err.code === 'ESRCH') return 'stopped';
    return 'failed';
  }
  for (let waited = 0; waited < KILL_WAIT_MS; waited += step) {
    if (!deps.isAlive(pid)) return 'killed';
    await deps.sleep(step);
  }
  return 'failed';
}

// ---------------------------------------------------------------------------
// Daemon HTTP
// ---------------------------------------------------------------------------

/**
 * GET over plain loopback HTTP. A dedicated Agent: never goes through a
 * proxy, even with NODE_USE_ENV_PROXY / HTTP_PROXY set (review 4.B5).
 * @returns {Promise<{status: number, headers: object, body: Buffer}|null>}
 */
export function httpGet(opts) {
  return httpRequest({ ...opts, method: 'GET' });
}

/** POST with a string body, same rules as httpGet. */
export function httpPost(opts) {
  return httpRequest({ ...opts, method: 'POST' });
}

function httpRequest({ host, port, urlPath, method, headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const agent = new http.Agent({ keepAlive: false });
    const done = (value) => {
      agent.destroy();
      resolve(value);
    };
    const allHeaders = body === undefined
      ? headers
      : { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    const req = http.request({ host, port, path: urlPath, method, headers: allHeaders, agent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('response too large'));
        else chunks.push(c);
      });
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done(null));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Ask a verified daemon to stop itself (signed POST /daemon/shutdown; the
 * daemon lets running calls finish, closes Firefox / the WS connections and
 * exits), then wait up to graceMs for its port to go quiet.
 * @returns {Promise<'stopped'|'refused'|'unanswered'|'still-running'>}
 *   refused: the daemon answered but not 200 / not signed (an older daemon has no such route)
 */
export async function stopDaemonGracefully(deps, endpoint, token, graceMs) {
  const body = JSON.stringify({ force: false });
  const signed = signPost(token, '/daemon/shutdown', body);
  const res = await deps.httpPost({ ...endpoint, urlPath: '/daemon/shutdown', headers: signed.headers, body, timeoutMs: SHUTDOWN_REQUEST_TIMEOUT_MS });
  if (!res) return 'unanswered';
  if (res.status !== 200 || !responseSignatureValid(token, signed.nonce, res.status, res.body, res.headers[AUTH_HEADER.signature])) {
    return 'refused';
  }
  // By the clock: each GET may itself take up to HEALTH_POLL_TIMEOUT_MS.
  const deadline = Date.now() + Math.max(graceMs, SHUTDOWN_MIN_WAIT_MS);
  for (;;) {
    if (!(await deps.httpGet({ ...endpoint, urlPath: '/health', timeoutMs: HEALTH_POLL_TIMEOUT_MS }))) return 'stopped';
    if (Date.now() >= deadline) return 'still-running';
    await deps.sleep(SHUTDOWN_POLL_MS);
  }
}

/**
 * What answers on the daemon port.
 * kind 'none': nothing; 'foreign': not a KitsuneMCP daemon; 'kitsune':
 * `verified` when it proved it holds our API token, `pid` from the signed
 * GET /daemon/info (only asked once verified: the token is never sent).
 */
export async function probeDaemon(deps, endpoint, token) {
  const nonce = newNonce();
  const res = await deps.httpGet({ ...endpoint, urlPath: '/health', headers: { [AUTH_HEADER.nonce]: nonce } });
  if (!res) return { kind: 'none' };
  let body;
  try {
    body = JSON.parse(res.body.toString('utf8'));
  } catch {
    return { kind: 'foreign' };
  }
  // Same test as kitsuneHealth of @kitsune-mcp/shared/node (health.ts).
  if (res.status !== 200 || !body || body.status !== 'ok' || body.service !== SERVICE_NAME) return { kind: 'foreign' };
  const info = { kind: 'kitsune', verified: false, pid: undefined, version: body.version, browsers: body.browsers_connected };
  if (!token) return info;
  info.verified = macMatches(body.proof, computeMac(token, 'health', nonce));
  if (!info.verified) return info;
  const signed = signGet(token, '/daemon/info');
  const r = await deps.httpGet({ ...endpoint, urlPath: '/daemon/info', headers: signed.headers });
  if (r && r.status === 200 && responseSignatureValid(token, signed.nonce, r.status, r.body, r.headers[AUTH_HEADER.signature])) {
    try {
      const pid = JSON.parse(r.body.toString('utf8')).pid;
      if (Number.isInteger(pid) && pid > 0) info.pid = pid;
    } catch {
      // no pid
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Output / prompts
// ---------------------------------------------------------------------------

export function makeReporter(deps) {
  return {
    title: (s) => deps.out(`${s}\n`),
    step: (s) => deps.out(`\n==> ${s}\n`),
    ok: (s) => deps.out(`    [ok] ${s}\n`),
    info: (s) => deps.out(`    ${s}\n`),
    plan: (s) => deps.out(`    [dry-run] would ${s}\n`),
    warn: (s) => deps.out(`    [warn] ${s}\n`),
    error: (s) => deps.err(`\n[error] ${s}\n`),
    raw: (s) => deps.out(s),
  };
}

/**
 * Yes/no question. --yes answers yes; without a terminal on stdin the
 * default is taken without asking; --dry-run never asks.
 */
export async function confirm(deps, opts, question, defaultYes) {
  if (opts.yes) return true;
  if (opts.dryRun || !deps.isTTY) return defaultYes;
  const answer = String(await deps.prompt(`    ${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer.startsWith('y');
}

/**
 * Exit quietly when the reader of stdout goes away (… | head). Any other
 * stdout error is reported in one line without a stack trace (same policy
 * as runInstall / runUninstall) and exits with 1.
 */
export function exitOnBrokenPipe() {
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    try {
      process.stderr.write(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
    } catch {
      // stderr gone as well
    }
    process.exit(1);
  });
}

/** Main-module check that works with Windows drive-letter case differences. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const a = path.resolve(fileURLToPath(metaUrl));
  const b = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
