#!/usr/bin/env node
// Builds packages/extension/dist with esbuild.
//
// Three bundles, one per execution context, each self-contained (IIFE):
//   src/background.ts     -> dist/background.js     (manifest background)
//   src/content.ts        -> dist/content.js        (manifest content script,
//                                                    and the early injection)
//   src/popup/popup.ts    -> dist/popup/popup.js    (popup.html)
// plus the static files popup.html / popup.css / content.css.
//
// esbuild does not type-check: `npm run typecheck -w @kitsune-mcp/extension`
// (tsc --noEmit) does, and `npm run build` of the extension runs it first.
//
// This file lives outside packages/extension on purpose: web-ext packs every
// file of packages/extension that web-ext-config.mjs does not ignore.
//
// Usage: node scripts/build-extension.mjs [--dev]
//   --dev  also write linked source maps (dist/**/*.js.map)

import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'packages', 'extension');
const src = path.join(ext, 'src');
const dist = path.join(ext, 'dist');
const dev = process.argv.includes('--dev');

const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf-8'));
const firefoxMin = manifest.browser_specific_settings.gecko.strict_min_version.split('.')[0];

// Old outputs (e.g. the former per-file scripts) would otherwise end up in
// the .xpi.
rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: [
    { in: path.join(src, 'background.ts'), out: 'background' },
    { in: path.join(src, 'content.ts'), out: 'content' },
    { in: path.join(src, 'popup', 'popup.ts'), out: 'popup/popup' },
  ],
  outdir: dist,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: `firefox${firefoxMin}`,
  // Readable output for review (AMO); same as the former tsc output.
  minify: false,
  sourcemap: dev ? 'linked' : false,
  charset: 'utf8',
  logLevel: 'warning',
});

for (const [from, to] of [
  ['popup/popup.html', 'popup/popup.html'],
  ['popup/popup.css', 'popup/popup.css'],
  ['content.css', 'content.css'],
]) {
  mkdirSync(path.dirname(path.join(dist, to)), { recursive: true });
  copyFileSync(path.join(src, from), path.join(dist, to));
}

// ESM sources are strict, but an IIFE bundle is a classic script: esbuild
// keeps strict mode by emitting "use strict" (from the tsconfig's strict /
// alwaysStrict). Fail if that ever stops.
for (const out of ['background.js', 'content.js', 'popup/popup.js']) {
  if (!readFileSync(path.join(dist, out), 'utf-8').startsWith('"use strict";')) {
    console.error(`build-extension: dist/${out} does not start with "use strict"`);
    process.exit(1);
  }
}

// Every file manifest.json loads must exist.
const referenced = [
  ...manifest.background.scripts,
  ...manifest.content_scripts.flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
  manifest.browser_action.default_popup,
];
const missing = referenced.filter((f) => !existsSync(path.join(ext, f)));
if (missing.length > 0) {
  console.error(`build-extension: manifest.json references missing files: ${missing.join(', ')}`);
  process.exit(1);
}
