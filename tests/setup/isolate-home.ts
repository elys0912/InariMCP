/**
 * Per test file: point the home directory at a fresh temporary directory.
 *
 * The daemon, the relay and the Native Host keep their state under
 * ~/.inari-mcp (api_token, safety.json, logs/audit.jsonl, screenshots),
 * resolved with os.homedir() at call time. Without this, a test that runs
 * the SafetyGuard or the token code writes to the developer's real home.
 *
 * os.homedir() reads USERPROFILE on Windows and HOME elsewhere; both are set.
 * This needs the forks pool (vitest.config.mts): in worker threads
 * process.env is a copy and os.homedir() would still see the real values.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;

// Settings that could point back at real files.
for (const name of [
  'FOX_SAFETY_CONFIG',
  'FOX_SCREENSHOTS_DIR',
  'CLAUDE_BROWSER_SAFETY_CONFIG',
  'CLAUDE_BROWSER_SCREENSHOTS_DIR',
]) {
  delete process.env[name];
}

if (os.homedir() === realHome) {
  throw new Error('tests/setup/isolate-home.ts: os.homedir() still returns the real home (is the pool "forks"?)');
}

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
