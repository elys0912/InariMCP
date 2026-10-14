#!/usr/bin/env node
// Builds the Extension package that is submitted to addons.mozilla.org.
//
//   npm run pack:ext
//
// 1. rebuilds packages/extension/dist (scripts/build-extension.mjs),
// 2. packs packages/extension with web-ext into
//      web-ext-artifacts/<name>-<version>.zip
//    (<name> and <version> come from manifest.json),
// 3. writes web-ext-artifacts/<name>-<version>.sha256.txt: one line per file
//    in the zip, "<sha256>  <path>" (the format of `sha256sum`), sorted by
//    path. The zip itself carries file times, so its own hash differs from
//    run to run; the hashes of its contents do not. A reviewer who builds
//    from the source zip (docs/BUILD.md) compares this file.
// 4. runs `web-ext lint`; any error or warning fails the script.
//
// web-ext is the one in node_modules (a devDependency), not whatever `npx`
// finds. Its configuration is web-ext-config.mjs only: config discovery is
// off, so a config file in the home directory cannot change the package.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'web-ext-artifacts');
const webExt = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const webExtArgs = ['--no-config-discovery', '--config', 'web-ext-config.mjs'];

function fail(message) {
  console.error(`pack-extension: ${message}`);
  process.exit(1);
}

/**
 * Runs a Node.js script from the repository root and returns its stdout;
 * stderr passes through. A non-zero exit fails the script unless
 * `allowFailure` is set (the caller reads the output).
 */
function runNode(script, args, { echo = false, allowFailure = false } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (echo) process.stdout.write(r.stdout);
  if (r.status !== 0 && !allowFailure) fail(`${path.relative(root, script)} failed (exit ${r.status})`);
  return r.stdout;
}

/**
 * Files of a zip as [path, content]. Reads the central directory; supports
 * stored and deflated entries (what web-ext writes), not zip64.
 */
function readZipFiles(zip) {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== EOCD) eocd -= 1;
  if (eocd < 0) fail('the zip has no end-of-central-directory record');

  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const files = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL) fail('the zip central directory is damaged');
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf-8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;

    if (zip.readUInt32LE(localAt) !== LOCAL) fail(`the zip local header of ${name} is damaged`);
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const raw = zip.subarray(dataAt, dataAt + compressedSize);
    if (method === 0) files.push([name, raw]);
    else if (method === 8) files.push([name, inflateRawSync(raw)]);
    else fail(`${name}: unsupported compression method ${method}`);
  }
  return files;
}

const manifest = JSON.parse(readFileSync(path.join(root, 'packages', 'extension', 'manifest.json'), 'utf-8'));
if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
  fail('manifest.json needs a string "name" and "version"');
}
// The file name web-ext gives by default: the lower-cased name with every run
// of other characters replaced by "_".
const base = `${manifest.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '_')}-${manifest.version}`;
const zipPath = path.join(artifacts, `${base}.zip`);
const sumsPath = path.join(artifacts, `${base}.sha256.txt`);

if (!existsSync(webExt)) fail('node_modules/web-ext is missing; run `npm ci` first');

runNode(path.join(root, 'scripts', 'build-extension.mjs'), [], { echo: true });

mkdirSync(artifacts, { recursive: true });
runNode(webExt, ['build', ...webExtArgs, '--overwrite-dest', '--filename', path.basename(zipPath)], { echo: true });
if (!existsSync(zipPath)) fail(`web-ext did not write ${path.relative(root, zipPath)}`);

const sums = readZipFiles(readFileSync(zipPath))
  .map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}`)
  .sort((a, b) => {
    const [pathA, pathB] = [a.slice(66), b.slice(66)];
    return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
  });
writeFileSync(sumsPath, `${sums.join('\n')}\n`);
console.log(`pack-extension: ${sums.length} files, hashes in ${path.relative(root, sumsPath)}`);

// web-ext lint exits non-zero on errors; its JSON on stdout says what they are.
const lintOutput = runNode(webExt, ['lint', ...webExtArgs, '--output', 'json'], { allowFailure: true });
let summary;
try {
  ({ summary } = JSON.parse(lintOutput));
} catch {
  fail(`web-ext lint did not print JSON:\n${lintOutput}`);
}
if (summary.errors !== 0 || summary.warnings !== 0) {
  console.error(lintOutput);
  fail(`web-ext lint reports ${summary.errors} errors and ${summary.warnings} warnings (0 and 0 are required)`);
}
console.log('pack-extension: web-ext lint: 0 errors, 0 warnings');
