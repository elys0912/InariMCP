import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRAMPOLINE_JS, sweepRunDir } from '../src/outside-job.js';

/** Limit of one trampoline run (execFileSync is synchronous: vitest's test timeout cannot stop it). */
const TRAMPOLINE_RUN_TIMEOUT_MS = 20_000;
/** Test timeout of the tests that start real processes. */
const PROCESS_TEST_TIMEOUT_MS = 30_000;
/** afterAll: how long to wait for the detached daemons, then to retry deleting their directory. */
const DAEMON_EXIT_WAIT_MS = 10_000;
const CLEANUP_RETRIES = 30;
const CLEANUP_RETRY_DELAY_MS = 100;

/**
 * Per test: the trampoline and its spec. Only short-lived processes of this
 * test touch it (the trampoline has exited when execFileSync returns), so
 * afterEach can delete it at once.
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-tramp-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

/**
 * The detached "daemons" run (cwd, daemon.log, out / pid files) in a
 * directory of their own, outside `dir`: Windows refuses to delete the cwd
 * of a running process and files a new process just wrote may still be open
 * (AV scan), so `dir` must not depend on when they exit. Deleted once in
 * afterAll, after they have exited (the trampoline tests were flaky otherwise).
 */
let daemonRoot: string;
const daemonPids: number[] = [];
beforeAll(() => { daemonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-tramp-daemon-')); });
afterAll(async () => {
  for (const pid of daemonPids) await waitForExit(pid, DAEMON_EXIT_WAIT_MS);
  try {
    fs.rmSync(daemonRoot, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES, retryDelay: CLEANUP_RETRY_DELAY_MS });
  } catch {
    // A leftover in the OS temp directory must not fail the run.
  }
});

/**
 * Run the real trampoline script against a spec; the "daemon" writes its PID,
 * then its env and cwd, to files in a fresh directory under `daemonRoot`.
 */
function runTrampoline(spec: Record<string, unknown>): {
  specPath: string; daemonDir: string; out: string; log: string; pidFile: string;
} {
  const tramp = path.join(dir, 'trampoline.js');
  const specPath = path.join(dir, 'spec.json');
  const daemonDir = fs.mkdtempSync(path.join(daemonRoot, 'run-'));
  const out = path.join(daemonDir, 'out.txt');
  const log = path.join(daemonDir, 'daemon.log');
  const pidFile = path.join(daemonDir, 'daemon.pid');
  fs.writeFileSync(tramp, TRAMPOLINE_JS);
  const daemonScript =
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.FOX_TEST + '|' + process.cwd());` +
    "process.stderr.write('daemon stderr\\n');";
  fs.writeFileSync(specPath, JSON.stringify({
    exe: process.execPath,
    args: ['-e', daemonScript],
    env: { FOX_TEST: 'from-spec' },
    log,
    cwd: daemonDir,
    ...spec,
  }));
  execFileSync(process.execPath, [tramp, specPath], { stdio: 'ignore', timeout: TRAMPOLINE_RUN_TIMEOUT_MS });
  return { specPath, daemonDir, out, log, pidFile };
}

/** Wait (at most `timeoutMs`) until the detached daemon has exited. Never throws. */
async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: gone
    }
    if (Date.now() > deadline) return; // leave it to the cleanup retries
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Poll until `file` can be read and `done` accepts its content; throw at the
 * deadline. Existence alone is not enough: the daemon may be mid-write.
 */
async function readWhen(file: string, done: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '(missing)';
  for (;;) {
    try {
      last = fs.readFileSync(file, 'utf-8');
      if (done(last)) return last;
    } catch { /* not there yet */ }
    if (Date.now() > deadline) throw new Error(`${path.basename(file)} not as expected in time: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('trampoline script', () => {
  it('starts the daemon with the spec env, cwd and log, then deletes the spec', async () => {
    const { specPath, daemonDir, out, log, pidFile } = runTrampoline({});
    expect(fs.existsSync(specPath)).toBe(false);
    daemonPids.push(Number(await readWhen(pidFile, (text) => /^\d+$/.test(text))));
    const expected = `from-spec|${fs.realpathSync(daemonDir)}`;
    // the daemon writes out.txt in one call: wait for the complete line
    expect(await readWhen(out, (text) => text.length >= expected.length)).toBe(expected);
    expect(await readWhen(log, (text) => text.includes('daemon stderr'))).toContain('daemon stderr');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('keeps the spec when the daemon cannot be spawned, so the caller can fall back', () => {
    const { specPath } = runTrampoline({ exe: path.join(dir, 'no-such-executable') });
    expect(fs.existsSync(specPath)).toBe(true);
  }, PROCESS_TEST_TIMEOUT_MS);
});

describe('sweepRunDir', () => {
  it('removes only files older than the limit', () => {
    const oldFile = path.join(dir, 'spec-old.json');
    const newFile = path.join(dir, 'spec-new.json');
    fs.writeFileSync(oldFile, '{}');
    fs.writeFileSync(newFile, '{}');
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(oldFile, old, old);
    sweepRunDir(dir, 600_000);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('ignores a missing directory', () => {
    expect(() => sweepRunDir(path.join(dir, 'missing'))).not.toThrow();
  });
});
