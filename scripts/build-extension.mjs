#!/usr/bin/env node
// Builds packages/extension/dist with esbuild.
//
// Four bundles, one per execution context, each self-contained (IIFE):
//   src/background.ts       -> dist/background.js       (manifest background)
//   src/content.ts          -> dist/content.js          (manifest content script)
//   src/popup/popup.ts      -> dist/popup/popup.js      (popup.html)
//   src/consent/consent.ts  -> dist/consent/consent.js  (consent.html, opened
//                                                        by the background)
// plus the static files popup.html / popup.css / consent.html / consent.css /
// content.css, and dist/LICENSE: a copy of the repository's LICENSE (the MIT
// notice of this project and of the project it is based on), which the
// license asks to ship with every copy, the xpi included.
//
// esbuild does not type-check: `npm run typecheck -w @inari-mcp/extension`
// (tsc --noEmit) does, and `npm run build` of the extension runs it first.
//
// @inari-mcp/shared is bundled from its sources (packages/shared/src), not
// from its CommonJS dist/. Only the browser-safe entry points are allowed
// (SHARED_ENTRIES); the bundles must not contain zod (about +110 KB, see
// shared/src/action-names.ts) nor shared/src/node (Node APIs). The build
// fails otherwise.
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
const sharedSrc = path.join(root, 'packages', 'shared', 'src');

/** Import specifiers of @inari-mcp/shared the Extension may use. */
const SHARED_ENTRIES = new Map([
  ['@inari-mcp/shared', path.join(sharedSrc, 'index.ts')],
  ['@inari-mcp/shared/action-names', path.join(sharedSrc, 'action-names.ts')],
  ['@inari-mcp/shared/field-mask', path.join(sharedSrc, 'field-mask.ts')],
  ['@inari-mcp/shared/approval-site', path.join(sharedSrc, 'approval-site.ts')],
  ['@inari-mcp/shared/url-pattern-limit', path.join(sharedSrc, 'url-pattern-limit.ts')],
]);

/** Resolve @inari-mcp/shared[/...] to SHARED_ENTRIES, refuse the rest. */
const sharedPlugin = {
  name: 'inari-shared',
  setup(b) {
    b.onResolve({ filter: /^@inari-mcp\/shared(\/|$)/ }, (args) => {
      const file = SHARED_ENTRIES.get(args.path);
      if (file !== undefined) return { path: file };
      return { errors: [{ text: `${args.path} is not available to the Extension (allowed: ${[...SHARED_ENTRIES.keys()].join(', ')})` }] };
    });
  },
};

/** Bundle inputs that must never reach the Extension. */
const FORBIDDEN_INPUTS = [
  { re: /(^|\/)node_modules\/zod\//, why: 'zod' },
  { re: /^packages\/shared\/src\/node\//, why: 'shared/src/node (Node APIs)' },
];

const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf-8'));

// The keys this script reads, checked up front: a clear message instead of a
// TypeError halfway through the build.
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const manifestProblems = [
  [typeof manifest?.browser_specific_settings?.gecko?.strict_min_version === 'string',
    'browser_specific_settings.gecko.strict_min_version (string)'],
  [isStringArray(manifest?.background?.scripts), 'background.scripts (array of strings)'],
  [Array.isArray(manifest?.content_scripts) && manifest.content_scripts.every((c) =>
    c && typeof c === 'object' && (c.js === undefined || isStringArray(c.js)) && (c.css === undefined || isStringArray(c.css))),
  'content_scripts (array of { js?: string[], css?: string[] })'],
  [typeof manifest?.browser_action?.default_popup === 'string', 'browser_action.default_popup (string)'],
].filter(([ok]) => !ok).map(([, what]) => what);
if (manifestProblems.length > 0) {
  console.error(`build-extension: packages/extension/manifest.json is missing or has a wrong type for: ${manifestProblems.join(', ')}`);
  process.exit(1);
}
const firefoxMin = manifest.browser_specific_settings.gecko.strict_min_version.split('.')[0];

// Old outputs (e.g. the former per-file scripts) would otherwise end up in
// the .xpi.
rmSync(dist, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: [
    { in: path.join(src, 'background.ts'), out: 'background' },
    { in: path.join(src, 'content.ts'), out: 'content' },
    { in: path.join(src, 'popup', 'popup.ts'), out: 'popup/popup' },
    { in: path.join(src, 'consent', 'consent.ts'), out: 'consent/consent' },
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
  plugins: [sharedPlugin],
  metafile: true,
});

for (const [out, info] of Object.entries(result.metafile.outputs)) {
  if (!out.endsWith('.js')) continue;
  for (const input of Object.keys(info.inputs)) {
    const bad = FORBIDDEN_INPUTS.find((f) => f.re.test(input.split(path.sep).join('/')));
    if (bad !== undefined) {
      console.error(`build-extension: ${out} bundles ${bad.why} (${input})`);
      process.exit(1);
    }
  }
}

for (const [from, to] of [
  ['popup/popup.html', 'popup/popup.html'],
  ['popup/popup.css', 'popup/popup.css'],
  ['consent/consent.html', 'consent/consent.html'],
  ['consent/consent.css', 'consent/consent.css'],
  ['content.css', 'content.css'],
]) {
  mkdirSync(path.dirname(path.join(dist, to)), { recursive: true });
  copyFileSync(path.join(src, from), path.join(dist, to));
}
copyFileSync(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));

// ESM sources are strict, but an IIFE bundle is a classic script: esbuild
// keeps strict mode by emitting "use strict" (from the tsconfig's strict /
// alwaysStrict). Fail if that ever stops.
for (const out of ['background.js', 'content.js', 'popup/popup.js', 'consent/consent.js']) {
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
