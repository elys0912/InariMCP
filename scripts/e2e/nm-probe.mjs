#!/usr/bin/env node
// Native Messaging smoke test: start the installed host the way Firefox does
// and check that it answers and reaches the daemon.
//
//   1. Reads the host manifest written by scripts/install.{sh,ps1}
//   2. Starts manifest.path with Firefox's two arguments (manifest path, extension ID)
//   3. Sends `ping` and `status` framed as Native Messaging (uint32 LE length + JSON)
//   4. Waits until status reports the daemon available and the WebSocket connected
//   5. Closes stdin (as Firefox does) and expects the host to exit by itself
//
// Firefox is not needed. The daemon is started by the host when it is missing
// and keeps running afterwards (it exits on its own when idle).
//
// Usage: node scripts/e2e/nm-probe.mjs   (after running the installer)
// Exit code: 0 = pass, 1 = fail

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function manifestPath() {
  const home = homedir();
  switch (process.platform) {
    case 'win32': return path.join(home, '.kitsune-mcp', 'native-host', 'kitsune_mcp.json');
    case 'darwin': return path.join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', 'kitsune_mcp.json');
    default: return path.join(home, '.mozilla', 'native-messaging-hosts', 'kitsune_mcp.json');
  }
}

const mPath = manifestPath();
if (!existsSync(mPath)) {
  console.error(`host manifest not found: ${mPath} (run the installer first)`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
const extId = manifest.allowed_extensions?.[0];
console.log(`manifest: ${mPath}`);
console.log(`host:     ${manifest.path}`);

// run-host.cmd on Windows can only be started through a shell (Node >= 18.20 / 20.12 refuse .cmd otherwise)
const host = process.platform === 'win32'
  ? spawn(`"${manifest.path}" "${mPath}" ${extId}`, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
  : spawn(manifest.path, [mPath, extId], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = Buffer.alloc(0);
const waiters = new Map();
host.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    const resolve = waiters.get(msg.requestId);
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
const exited = await Promise.race([
  new Promise((r) => host.on('exit', (code) => r(`exited (code ${code})`))),
  sleep(5000).then(() => 'still running after 5s'),
]);
console.log('host after stdin close:', exited);
if (exited.startsWith('still')) { host.kill(); ok = false; }

console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
