#!/usr/bin/env node
// Native Messaging smoke test: start the installed host the way Firefox does
// and check that it answers and reaches the daemon.
//
//   1. Reads the host manifest written by scripts/install.mjs
//   2. Starts manifest.path with Firefox's two arguments (manifest path, extension ID)
//   3. Sends `ping` and `status` framed as Native Messaging (uint32 LE length + JSON)
//   4. Waits until status reports the daemon available and the WebSocket connected
//   5. Closes stdin (as Firefox does) and expects the host to exit by itself
//
// Firefox is not needed. The daemon is started by the host when it is missing
// and keeps running afterwards (it exits on its own when idle).
//
// Usage: node scripts/e2e/nm-probe.mjs [manifest.json]   (after running the installer)
//        node scripts/e2e/nm-probe.mjs --help
// Exit code: 0 = pass, 1 = fail, 2 = bad arguments

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { commandInvocation, nmManifestTargets } from '../lib/core.mjs';

const USAGE = `Usage: node scripts/e2e/nm-probe.mjs [manifest.json]

Starts the Native Messaging host the way Firefox does, sends ping and status,
and checks that it reaches the daemon and exits when stdin closes.

  manifest.json  host manifest to test (default: the one the installer writes,
                 ${defaultManifestPath()})
  -h, --help     show this help

Exit code: 0 = pass, 1 = fail, 2 = bad arguments.
Note: the host starts the daemon when none is running (it exits when idle).
`;

/** Parse argv: at most one positional (manifest path) and --help. */
function parseArgs(argv) {
  if (argv.some((a) => a === '-h' || a === '--help')) return { help: true };
  const flags = argv.filter((a) => a.startsWith('-'));
  if (flags.length > 0) return { error: `unknown option: ${flags.join(' ')}` };
  if (argv.length > 1) return { error: `expected at most one manifest path, got ${argv.length} arguments` };
  return { manifest: argv[0] };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (args.error) {
  process.stderr.write(`nm-probe: ${args.error}\n\n${USAGE}`);
  process.exit(2);
}

/** The manifest every Firefox edition reads (the installer's first target). */
function defaultManifestPath() {
  return nmManifestTargets({ platform: process.platform, home: homedir(), env: process.env, exists: existsSync })[0].file;
}

const mPath = args.manifest !== undefined ? path.resolve(args.manifest) : defaultManifestPath();
if (!existsSync(mPath)) {
  console.error(`host manifest not found: ${mPath}${args.manifest !== undefined ? '' : ' (run the installer first)'}`);
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(mPath, 'utf8'));
} catch (err) {
  console.error(`cannot read host manifest ${mPath}: ${err.message}`);
  process.exit(1);
}
const extId = manifest?.allowed_extensions?.[0];
if (typeof manifest?.path !== 'string' || typeof extId !== 'string') {
  console.error(`host manifest ${mPath} lacks a string "path" or "allowed_extensions[0]"`);
  process.exit(1);
}
console.log(`manifest: ${mPath}`);
console.log(`host:     ${manifest.path}`);

// run-host.cmd on Windows goes through cmd.exe (Node >= 18.20 / 20.12 refuse
// to spawn .cmd directly); commandInvocation quotes every argument and
// refuses quotes / % that cmd.exe would interpret.
let inv;
try {
  inv = commandInvocation(manifest.path, [mPath, extId], process.platform, process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const host = spawn(inv.file, inv.args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsVerbatimArguments: inv.verbatim,
  windowsHide: true,
});
// Registered right away, so an early exit is not missed (and is not reported
// as "still running" later).
const exitedPromise = new Promise((resolve) => host.on('exit', (code) => resolve(`exited (code ${code})`)));
host.on('error', (err) => {
  console.log('ERROR cannot start the host:', err.message);
  console.log('RESULT: FAIL');
  process.exit(1);
});
// EPIPE when the host has already exited; the reply timeout reports it.
host.stdin.on('error', (err) => console.log('host stdin:', err.message));

let buf = Buffer.alloc(0);
const waiters = new Map();
host.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log('message that is not JSON:', raw.slice(0, 200));
      continue;
    }
    const resolve = waiters.get(msg?.requestId);
    if (resolve) { waiters.delete(msg.requestId); resolve(msg); }
    else console.log('unsolicited message:', JSON.stringify(msg));
  }
});

let seq = 0;
function send(action) {
  const requestId = `nm-probe-${++seq}`;
  const body = Buffer.from(JSON.stringify({ action, requestId }), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  host.stdin.write(Buffer.concat([head, body]));
  return new Promise((resolve, reject) => {
    waiters.set(requestId, resolve);
    setTimeout(() => reject(new Error(`no reply to '${action}' within 8s`)), 8000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
try {
  const pong = await send('ping');
  console.log('ping   ->', JSON.stringify(pong));
  let status;
  for (let i = 0; i < 20; i++) {
    status = await send('status');
    if (status.mcp_server?.available && status.mcp_server?.ws?.connected) break;
    await sleep(500);
  }
  console.log('status ->', JSON.stringify(status));
  ok = Boolean(pong.pong && status.mcp_server?.available && status.mcp_server?.ws?.connected);
} catch (err) {
  console.log('ERROR', err.message);
  ok = false;
}

host.stdin.end();
const exited = host.exitCode !== null || host.signalCode !== null
  ? `exited (code ${host.exitCode})`
  : await Promise.race([exitedPromise, sleep(5000).then(() => 'still running after 5s')]);
console.log('host after stdin close:', exited);
if (exited.startsWith('still')) { host.kill(); ok = false; }

console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
