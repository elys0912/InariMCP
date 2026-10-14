#!/usr/bin/env node
// Builds the source package that is submitted to addons.mozilla.org together
// with the Extension (AMO "Source Code Submission").
//
//   npm run pack:source
//
// Writes web-ext-artifacts/inari-mcp-source-<version>.zip with
// `git archive --format=zip HEAD`: the tracked files of the last commit and
// nothing else (no node_modules, dist, web-ext-artifacts or .git). The
// reviewer's instructions, docs/BUILD.md, are added once more at the top
// level of the zip as BUILD.md.
//
// Fails when the working tree is not clean: the zip is made from HEAD, so a
// modified file would be missing from it, and an untracked one would be
// missing without anyone noticing.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`pack-source: ${message}`);
  process.exit(1);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
  if (r.error !== undefined) fail(`cannot run git: ${r.error.message}`);
  if (r.status !== 0) fail(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const manifest = JSON.parse(readFileSync(path.join(root, 'packages', 'extension', 'manifest.json'), 'utf-8'));
if (typeof manifest.version !== 'string') fail('manifest.json needs a string "version"');

const dirty = git(['status', '--porcelain']).trim();
if (dirty !== '') {
  fail(`the working tree is not clean; commit or remove these first:\n${dirty}`);
}

const out = path.join('web-ext-artifacts', `inari-mcp-source-${manifest.version}.zip`);
mkdirSync(path.join(root, 'web-ext-artifacts'), { recursive: true });
git(['archive', '--format=zip', `--output=${out}`, '--add-file=docs/BUILD.md', 'HEAD']);
console.log(`pack-source: wrote ${out} (from ${git(['rev-parse', '--short', 'HEAD']).trim()})`);
