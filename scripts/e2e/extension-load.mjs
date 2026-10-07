#!/usr/bin/env node
// Checks that the extension loads as a temporary add-on in Firefox.
//
// Runs `web-ext run` (devDependency) against Playwright's bundled Firefox
// (or FOX_E2E_FIREFOX / the first argument), headless, with a throwaway
// profile, and judges the web-ext log:
//   "Installed ... as a temporary add-on"  → loaded     (exit 0)
//   an install error / timeout / early exit → not loaded (exit 1)
// Firefox is stopped a few seconds after the add-on is installed, so this
// does not show whether the Native Host connection works (that needs the
// installer's Native Messaging registration).
//
// Build first (npm run build): manifest.json loads the compiled scripts.
//
// Usage: node scripts/e2e/extension-load.mjs [path/to/firefox]
//   FOX_E2E_TIMEOUT_MS  overall limit (default 60000)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'packages', 'mcp-server', 'package.json'));

function playwrightFirefox() {
  try {
    return require('playwright').firefox.executablePath();
  } catch {
    return undefined;
  }
}

const firefox = process.argv[2] || process.env.FOX_E2E_FIREFOX || playwrightFirefox();
if (!firefox || !existsSync(firefox)) {
  console.error(`Firefox not found (${firefox ?? 'no path'}); run: npx playwright install firefox`);
  process.exit(1);
}
const timeoutMs = Number(process.env.FOX_E2E_TIMEOUT_MS) || 60_000;
const SETTLE_MS = 3_000;

const webExt = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const args = [
  webExt, 'run',
  '--source-dir', path.join(root, 'packages', 'extension'),
  `--firefox=${firefox}`,
  '--no-input',
  '--no-reload',
  '--arg=-headless',
  '--start-url', 'about:blank',
  '--verbose',
];

console.log(`firefox: ${firefox}`);
const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let log = '';
let verdict;
/** Set once the install message is seen: later output is no longer judged. */
let installedAt;
const finish = (ok, why) => {
  if (verdict !== undefined) return;
  verdict = { ok, why };
  child.kill();
  // web-ext stops Firefox when it is terminated; give it a moment.
  setTimeout(() => {
    console.log(ok ? `OK: ${why}` : `FAILED: ${why}`);
    if (!ok) console.log('--- web-ext log (last 40 lines) ---\n' + log.trim().split('\n').slice(-40).join('\n'));
    process.exit(ok ? 0 : 1);
  }, 1_500);
};

const onData = (chunk) => {
  const s = chunk.toString();
  log += s;
  if (installedAt !== undefined) return;
  const installed = /Installed .* as a temporary add-on/.exec(log);
  if (installed) {
    installedAt = { time: Date.now(), message: installed[0] };
    setTimeout(() => finish(true, installed[0]), SETTLE_MS);
    return;
  }
  const failed = /(InstallError|Error: .*(install|addon|add-on)[^\n]*|WebExtError[^\n]*|UsageError[^\n]*)/i.exec(s);
  if (failed) finish(false, failed[0].trim());
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (code) => {
  if (installedAt !== undefined) finish(true, `${installedAt.message} (web-ext exited, code ${code})`);
  else finish(false, `web-ext exited (code ${code}) before the add-on was installed`);
});
setTimeout(() => finish(false, `no "temporary add-on" message within ${timeoutMs} ms`), timeoutMs).unref();
