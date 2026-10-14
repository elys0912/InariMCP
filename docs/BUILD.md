# Building Inari MCP for Firefox from source

This file is for reviewers of addons.mozilla.org. It is in the source package as `BUILD.md` and in the repository as `docs/BUILD.md`. Following it produces the same files as the submitted add-on (see "Check the result").

## Environment

Any of these works:

- Linux, including Ubuntu 24.04 (x86-64 and ARM64)
- macOS
- Windows

Tools:

| Tool | Version | Note |
|---|---|---|
| Node.js | 24.x (tested with 24.14) | `.nvmrc` says `24`. Running Inari MCP needs Node.js 20 or later (`package.json` `engines`: `>=20`); the reproducible build for the review uses Node.js 24.x |
| npm | 11.x (the one that comes with Node.js 24) | |

Nothing else is needed: no compiler, no Python, no Java, no network access other than the npm registry in the first two steps.

## Build

Run in the root directory of the source package:

```bash
npm ci
npm run lint:install
npm run build
npm run pack:ext
```

- `npm ci` installs exactly what `package-lock.json` lists.
- `npm run lint:install` (`npm ci --prefix tools/lint`) installs ESLint into `tools/lint/node_modules`, exactly as `tools/lint/package-lock.json` lists. Only the lint runs on TypeScript 6 (typescript-eslint's peer dependency does not allow TypeScript 7 yet, so it is kept apart in `tools/lint`); the build uses TypeScript 7 from the root.
- `npm run build` builds every workspace of the repository. The add-on itself needs only the next step: `npm run pack:ext` rebuilds `packages/extension/dist` on its own.
- `npm run pack:ext` (`scripts/pack-extension.mjs`) lints the sources, bundles the add-on, packs it and lints the package:
  1. it runs ESLint (`npm run lint` with `--quiet`) and fails on an error; warnings (the complexity rules) do not fail it;
  2. it runs `scripts/build-extension.mjs` (esbuild), which writes `packages/extension/dist/`;
  3. it runs `web-ext build` (from `node_modules`) on `packages/extension`;
  4. it writes the SHA-256 of every file in the zip to a text file;
  5. it runs `web-ext lint` and fails on any error or warning.

## Output

In `web-ext-artifacts/`:

| File | Content |
|---|---|
| `inari_mcp_for_firefox-<version>.zip` | the add-on package (the submitted file) |
| `inari_mcp_for_firefox-<version>.sha256.txt` | one line per file in the zip: `<sha256>  <path>`, sorted by path |

`<version>` is the `version` of `packages/extension/manifest.json`. The files in the zip are `manifest.json`, `_locales/`, `icons/` and `dist/`: four JavaScript bundles (`dist/background.js`, `dist/content.js`, `dist/popup/popup.js`, `dist/consent/consent.js`), the HTML and CSS files of the popup and of the permission page, and `dist/LICENSE`.

`dist/LICENSE` in the zip is a copy of the repository's `LICENSE` (MIT, with the copyright notice of the project this add-on is based on); `scripts/build-extension.mjs` copies it.

## Check the result

A zip file records the modification time of each file, so two zips built at different times differ as files even when their contents are the same. Compare the hashes of the contents instead:

Make the same list from the submitted add-on and compare it with the one your build wrote. The add-on that AMO signs and serves has a `META-INF/` folder added (the signature), which the build does not make: leave it out, as below, or use the unsigned file that was uploaded.

```bash
mkdir submitted && unzip -q -d submitted <submitted add-on>.xpi
(cd submitted && find . -type f -not -path './META-INF/*' | sed 's|^\./||' | LC_ALL=C sort | xargs sha256sum) > submitted.sha256.txt
diff submitted.sha256.txt web-ext-artifacts/inari_mcp_for_firefox-<version>.sha256.txt
```

(`shasum -a 256` replaces `sha256sum` on macOS.) No output from `diff` means every file is identical. The same list is attached to the GitHub release (`https://github.com/elys0912/InariMCP/releases`) of that version.

Line endings do not differ between systems: `.gitattributes` fixes every text file to LF, and the source package is made from the committed files.

## What the build does and does not do

- All build dependencies are in `package-lock.json` (ESLint: `tools/lint/package-lock.json`) and come from the official npm registry (`https://registry.npmjs.org`). No dependency is copied into the repository, and no build step downloads anything else.
- esbuild only bundles the TypeScript sources of `packages/extension/src` and `packages/shared/src` into four files (`dist/background.js`, `dist/content.js`, `dist/popup/popup.js`, `dist/consent/consent.js`); the build script copies the HTML and CSS files of the popup and of the permission page as they are. esbuild does not minify and does not obfuscate: names and structure of the sources stay readable, and each part of a bundle is preceded by a comment with the path of its source file.
- No source map is written (`sourcemap: false`; source maps exist only with the `--dev` option, which `pack:ext` does not use).
- The bundles contain no build time, random value, environment variable or absolute path. Building twice gives the same hashes.
- The bundles contain no third-party code: the only inputs are the repository's own sources (the build fails if `zod` or any Node.js-only module reaches a bundle).
- `npm ci` prints deprecation warnings and `npm audit` reports vulnerabilities in transitive dependencies of `web-ext`. `web-ext` is only the packaging and lint tool, maintained by Mozilla; none of its code is in the add-on.

## Where the code is

| Path | Content |
|---|---|
| `packages/extension/` | the add-on: `manifest.json`, `src/` (TypeScript), `_locales/`, `icons/` |
| `packages/shared/src/` | code shared with the Node.js parts; the add-on bundles `index.ts`, `action-names.ts`, `field-mask.ts`, `approval-site.ts` and `url-pattern-limit.ts` from here (`SHARED_ENTRIES` of `scripts/build-extension.mjs`) |
| `scripts/build-extension.mjs` | the esbuild configuration |
| `scripts/pack-extension.mjs` | the packaging script (`npm run pack:ext`) |
| `tools/lint/` | ESLint, its configuration and its lockfile (`npm run lint:install`, `npm run lint`) |
| `web-ext-config.mjs` | what web-ext leaves out of the zip |
| `packages/mcp-server/`, `packages/native-host/` | the local MCP server and the native messaging host; separate programs, not part of the add-on package |
