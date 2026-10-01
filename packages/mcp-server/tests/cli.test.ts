import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';
import { PACKAGE_VERSION } from '../src/version.js';

describe('parseArgs', () => {
  it('selects the role, and --help / --version win over it', () => {
    expect(parseArgs([])).toEqual({ kind: 'relay' });
    expect(parseArgs(['--daemon'])).toEqual({ kind: 'daemon' });
    expect(parseArgs(['--daemon', '--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it('refuses unknown arguments instead of starting a relay', () => {
    expect(parseArgs(['--deamon'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--help', 'extra'])).toMatchObject({ kind: 'error' });
  });

  it('refuses two modes; a repeated mode or alias is one mode; -h / -v are aliases', () => {
    expect(parseArgs(['--daemon', '--doctor'])).toMatchObject({ kind: 'error', message: expect.stringContaining('cannot be combined') });
    expect(parseArgs(['--daemon', '--daemon'])).toEqual({ kind: 'daemon' });
    expect(parseArgs(['doctor', '--doctor'])).toEqual({ kind: 'doctor' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h', '--version'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version', '--daemon'])).toEqual({ kind: 'version' });
    expect(parseArgs(['--daemon', '--doctor', '--help'])).toEqual({ kind: 'help' });
  });
});

const entry = path.resolve(__dirname, '..', 'dist', 'index.js');

describe.skipIf(!fs.existsSync(entry))('dist/index.js without side effects (needs npm run build)', () => {
  it('--version / --help / unknown argument create nothing under the home directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-cli-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const version = spawnSync(process.execPath, [entry, '--version'], { env, encoding: 'utf-8', timeout: 10_000 });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(PACKAGE_VERSION);

      const help = spawnSync(process.execPath, [entry, '--help'], { env, encoding: 'utf-8', timeout: 10_000 });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('--daemon');

      const bad = spawnSync(process.execPath, [entry, '--nope'], { env, encoding: 'utf-8', timeout: 10_000 });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('unknown argument: --nope');

      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('scripts/e2e/nm-probe.mjs arguments (no host is started)', () => {
  const probe = path.resolve(__dirname, '..', '..', '..', 'scripts', 'e2e', 'nm-probe.mjs');
  const run = (args: string[]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-probe-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      return spawnSync(process.execPath, [probe, ...args], { env, encoding: 'utf-8', timeout: 10_000 });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it('--help exits 0; an unknown option or two paths exit 2', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/e2e/nm-probe.mjs');
    const bad = run(['--bogus']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown option: --bogus');
    const two = run(['a.json', 'b.json']);
    expect(two.status).toBe(2);
    expect(two.stderr).toContain('expected at most one manifest path');
  });
});
