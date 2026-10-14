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
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'extension', 'manifest.json'), 'utf-8')) as { version: string };
const sumsFile = path.join(root, 'web-ext-artifacts', `inari_mcp_for_firefox-${manifest.version}.sha256.txt`);

function pack(): string {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'pack-extension.mjs')], { cwd: root, encoding: 'utf-8', timeout: 120_000 });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return fs.readFileSync(sumsFile, 'utf-8');
}

describe('scripts/pack-extension.mjs', () => {
  it('writes the same file list and hashes on every run, and lints clean', () => {
    const first = pack();
    const second = pack();
    expect(second).toBe(first);

    const lines = first.trimEnd().split('\n');
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} {2}\S/);

    const files = lines.map((line) => line.slice(66));
    expect(files).toEqual([...files].sort());
    expect(files).toEqual(expect.arrayContaining([
      'manifest.json', 'dist/background.js', 'dist/content.js', 'dist/popup/popup.js', 'dist/popup/popup.html',
    ]));
    expect(files.filter((f) => f.startsWith('src/') || f.endsWith('.map') || f.endsWith('.ts'))).toEqual([]);
  }, 150_000);
});
