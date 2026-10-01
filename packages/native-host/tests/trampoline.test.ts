import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRAMPOLINE_JS, sweepRunDir } from '../src/outside-job.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-tramp-')); });
// A file just written may still be open (AV scan) for a moment on Windows.
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

/**
 * Run the real trampoline script against a spec; the "daemon" writes its PID,
 * then its env and cwd, to files.
 */
function runTrampoline(spec: Record<string, unknown>): { specPath: string; out: string; log: string; pidFile: string } {
  const tramp = path.join(dir, 'trampoline.js');
  const specPath = path.join(dir, 'spec.json');
  const out = path.join(dir, 'out.txt');
  const log = path.join(dir, 'daemon.log');
  const pidFile = path.join(dir, 'daemon.pid');
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
    cwd: dir,
    ...spec,
  }));
  execFileSync(process.execPath, [tramp, specPath], { stdio: 'ignore' });
  return { specPath, out, log, pidFile };
}

/**
 * Wait until the detached daemon has exited. Its cwd is `dir`, and Windows
 * refuses to delete the cwd of a running process (EPERM in afterEach).
 */
async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: gone
    }
    if (Date.now() > deadline) throw new Error(`daemon ${pid} still running`);
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
    const { specPath, out, log, pidFile } = runTrampoline({});
    expect(fs.existsSync(specPath)).toBe(false);
    const expected = `from-spec|${fs.realpathSync(dir)}`;
    // the daemon writes out.txt in one call: wait for the complete line
    expect(await readWhen(out, (text) => text.length >= expected.length)).toBe(expected);
    expect(await readWhen(log, (text) => text.includes('daemon stderr'))).toContain('daemon stderr');
    await waitForExit(Number(await readWhen(pidFile, (text) => /^\d+$/.test(text))));
  }, 30_000);

  it('keeps the spec when the daemon cannot be spawned, so the caller can fall back', () => {
    const { specPath } = runTrampoline({ exe: path.join(dir, 'no-such-executable') });
    expect(fs.existsSync(specPath)).toBe(true);
  });
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
