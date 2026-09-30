import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRAMPOLINE_JS, sweepRunDir } from '../src/outside-job.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-tramp-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Run the real trampoline script against a spec; the "daemon" writes its env and cwd to a file. */
function runTrampoline(spec: Record<string, unknown>): { specPath: string; out: string; log: string } {
  const tramp = path.join(dir, 'trampoline.js');
  const specPath = path.join(dir, 'spec.json');
  const out = path.join(dir, 'out.txt');
  const log = path.join(dir, 'daemon.log');
  fs.writeFileSync(tramp, TRAMPOLINE_JS);
  const daemonScript =
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
  return { specPath, out, log };
}

async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
}

describe('trampoline script', () => {
  it('starts the daemon with the spec env, cwd and log, then deletes the spec', async () => {
    const { specPath, out, log } = runTrampoline({});
    expect(fs.existsSync(specPath)).toBe(false);
    await waitFor(out);
    expect(fs.readFileSync(out, 'utf-8')).toBe(`from-spec|${fs.realpathSync(dir)}`);
    for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.readFileSync(log, 'utf-8')).toContain('daemon stderr');
  });

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
