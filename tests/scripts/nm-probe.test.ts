/**
 * scripts/e2e/nm-probe.mjs: argument handling only (no host is started).
 * Moved from packages/mcp-server/tests/cli.test.ts (a scripts/ tool).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('scripts/e2e/nm-probe.mjs arguments (no host is started)', () => {
  const probe = path.resolve(__dirname, '..', '..', 'scripts', 'e2e', 'nm-probe.mjs');
  const run = (args: string[]) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-probe-'));
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
