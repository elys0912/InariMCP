#!/usr/bin/env node
// Builds the Extension package that is submitted to addons.mozilla.org.
//
//   npm run pack:ext
//
// 1. runs ESLint over the repository (tools/lint, `npm run lint`); an error
//    fails the script, warnings (the complexity rules) do not,
// 2. rebuilds packages/extension/dist (scripts/build-extension.mjs),
// 3. packs packages/extension with web-ext into
//      web-ext-artifacts/<name>-<version>.zip
//    (<name> and <version> come from manifest.json),
// 4. writes web-ext-artifacts/<name>-<version>.sha256.txt: one line per file
//    in the zip, "<sha256>  <path>" (the format of `sha256sum`), sorted by
//    path. The zip itself carries file times, so its own hash differs from
//    run to run; the hashes of its contents do not. A reviewer who builds
//    from the source zip (docs/BUILD.md) compares this file.
// 5. runs `web-ext lint`; any error or warning fails the script.
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
const eslint = path.join(root, 'tools', 'lint', 'node_modules', 'eslint', 'bin', 'eslint.js');

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

// The zip records readZipFiles() reads, from PKWARE's APPNOTE.TXT: the end of
// central directory record (4.3.16), a central directory file header
// (4.3.12) and a local file header (4.3.7). Each starts with its signature;
// the *_AT tables are the byte offsets of the fields from that start.
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end record without a zip comment; a comment only adds to it. */
const EOCD_MIN_SIZE = 22;
const EOCD_AT = { entryCount: 10, centralOffset: 16 };
/** `name` is where the variable-length part (name, extra field, comment) begins. */
const CENTRAL_AT = { method: 10, compressedSize: 20, nameLength: 28, extraLength: 30, commentLength: 32, localOffset: 42, name: 46 };
/** `data` is where the variable-length part (name, extra field) begins; the file data follows it. */
const LOCAL_AT = { nameLength: 26, extraLength: 28, data: 30 };
/** Compression methods (APPNOTE 4.4.5) that web-ext writes. */
const STORED = 0;
const DEFLATED = 8;

/**
 * Files of a zip as [path, content]. Reads the central directory; supports
 * stored and deflated entries (what web-ext writes), not zip64.
 */
function readZipFiles(zip) {
  let eocd = zip.length - EOCD_MIN_SIZE;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== EOCD_SIGNATURE) eocd -= 1;
  if (eocd < 0) fail('the zip has no end-of-central-directory record');

  const count = zip.readUInt16LE(eocd + EOCD_AT.entryCount);
  let at = zip.readUInt32LE(eocd + EOCD_AT.centralOffset);
  const files = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) fail('the zip central directory is damaged');
    const method = zip.readUInt16LE(at + CENTRAL_AT.method);
    const compressedSize = zip.readUInt32LE(at + CENTRAL_AT.compressedSize);
    const nameLength = zip.readUInt16LE(at + CENTRAL_AT.nameLength);
    const extraLength = zip.readUInt16LE(at + CENTRAL_AT.extraLength);
    const commentLength = zip.readUInt16LE(at + CENTRAL_AT.commentLength);
    const localAt = zip.readUInt32LE(at + CENTRAL_AT.localOffset);
    const name = zip.toString('utf-8', at + CENTRAL_AT.name, at + CENTRAL_AT.name + nameLength);
    at += CENTRAL_AT.name + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;

    if (zip.readUInt32LE(localAt) !== LOCAL_SIGNATURE) fail(`the zip local header of ${name} is damaged`);
    const localNameLength = zip.readUInt16LE(localAt + LOCAL_AT.nameLength);
    const localExtraLength = zip.readUInt16LE(localAt + LOCAL_AT.extraLength);
    const dataAt = localAt + LOCAL_AT.data + localNameLength + localExtraLength;
    const raw = zip.subarray(dataAt, dataAt + compressedSize);
    if (method === STORED) files.push([name, raw]);
    else if (method === DEFLATED) files.push([name, inflateRawSync(raw)]);
    else fail(`${name}: unsupported compression method ${method}`);
  }
  return files;
}

/** Code-unit order of the paths, as sort() without a comparator (not the locale's order). */
function byPath([pathA], [pathB]) {
  if (pathA < pathB) return -1;
  return pathA > pathB ? 1 : 0;
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
if (!existsSync(eslint)) fail('tools/lint/node_modules is missing; run `npm run lint:install` first');

// --quiet: the errors only. ESLint exits non-zero on an error, not on a warning.
runNode(eslint, ['-c', path.join('tools', 'lint', 'eslint.config.js'), '--quiet', '.'], { echo: true });
console.log('pack-extension: eslint: 0 errors');

runNode(path.join(root, 'scripts', 'build-extension.mjs'), [], { echo: true });

mkdirSync(artifacts, { recursive: true });
runNode(webExt, ['build', ...webExtArgs, '--overwrite-dest', '--filename', path.basename(zipPath)], { echo: true });
if (!existsSync(zipPath)) fail(`web-ext did not write ${path.relative(root, zipPath)}`);

const sums = readZipFiles(readFileSync(zipPath))
  .sort(byPath)
  .map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}`);
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
