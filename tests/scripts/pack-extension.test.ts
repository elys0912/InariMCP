/**
 * scripts/pack-extension.mjs: the Extension package is reproducible. Two runs
 * give the same file list and the same SHA-256 per file (the zip itself holds
 * file times, so the hashes of its contents are what is compared), and the
 * list holds what manifest.json loads and nothing of the sources.
 *
 * Runs the real build, web-ext build and web-ext lint (a few seconds); it
 * writes packages/extension/dist and web-ext-artifacts/ like `npm run pack:ext`.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'extension', 'manifest.json'), 'utf-8')) as { version: string };
const sumsFile = path.join(root, 'web-ext-artifacts', `inari_mcp_for_firefox-${manifest.version}.sha256.txt`);

/** One line of the hashes file: "<sha256>  <path>", as `sha256sum` writes it. */
const SUM_LINE = /^[0-9a-f]{64} {2}(\S.*)$/;

interface PackRun { status: number | null; output: string; sums: string }

/** One run of the script, and the hashes file it left. */
function pack(): PackRun {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'pack-extension.mjs')], { cwd: root, encoding: 'utf-8', timeout: 120_000 });
  const sums = fs.existsSync(sumsFile) ? fs.readFileSync(sumsFile, 'utf-8') : '';
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, sums };
}

describe('scripts/pack-extension.mjs', () => {
  let runs: PackRun[];
  let lines: string[];
  let files: string[];

  beforeAll(() => {
    runs = [pack(), pack()];
    lines = runs[0]!.sums.trimEnd().split('\n');
    files = lines.map((line) => SUM_LINE.exec(line)?.[1] ?? `(not a hash line: ${line})`);
  }, 150_000);

  it('exits 0: ESLint reports no error and web-ext lint reports nothing', () => {
    for (const run of runs) expect(run.status, run.output).toBe(0);
  });

  it('writes the same file list and hashes on every run', () => {
    expect(runs[1]!.sums).toBe(runs[0]!.sums);
  });

  it('writes one "<sha256>  <path>" line per file', () => {
    for (const line of lines) expect(line).toMatch(SUM_LINE);
  });

  it('lists the files sorted by path', () => {
    expect(files).toEqual([...files].sort());
  });

  it('holds what manifest.json loads', () => {
    expect(files).toEqual(expect.arrayContaining([
      'manifest.json', 'dist/background.js', 'dist/content.js', 'dist/popup/popup.js', 'dist/popup/popup.html',
      'dist/consent/consent.js', 'dist/LICENSE',
    ]));
  });

  it('holds no sources and no source maps', () => {
    expect(files.filter((f) => f.startsWith('src/') || f.endsWith('.map') || f.endsWith('.ts'))).toEqual([]);
  });
});
