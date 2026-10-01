# Development

**English** | [日本語](./development.ja.md)

How the packages are built and checked. For using KitsuneMCP, see the [README](../README.md).

## Requirements

- Node.js 22.12 or later (or 24) for development: a requirement of Vitest. Running KitsuneMCP needs only Node.js 18.
- `playwright` (an optional dependency of `packages/mcp-server`, installed by `npm ci` unless `--omit=optional` is given). `npm run build` needs it: the headless backend imports its types. `npm run test:e2e` and `npm run e2e:extension` also need its Firefox (`npx playwright install firefox`).

## Workflow

Run from the repository root:

```bash
npm ci
npm run build           # every workspace (see Build)
npm run typecheck       # every workspace with a typecheck script (now: the Extension)
npm test                # Vitest, all projects except e2e
npm run lint:ext        # web-ext lint of packages/extension
npm run e2e:extension   # the Extension loads into Firefox as a temporary add-on
```

`npm run test:e2e` (relay → daemon → headless Firefox) and the scripts in `scripts/e2e/` are listed under "Development" in the README.

## Build

`npm run build` runs `build` in every workspace.

| Package | Build | Output |
|---|---|---|
| `packages/shared` | `tsc -b` | `dist/` (with `.d.ts`) |
| `packages/mcp-server` | `tsc -b` | `dist/` (`dist/index.js` is the relay / daemon / doctor entry) |
| `packages/native-host` | `tsc -b` | `dist/` |
| `packages/extension` | `npm run typecheck`, then `node ../../scripts/build-extension.mjs` | `dist/` (bundles) |

### Extension (esbuild)

`scripts/build-extension.mjs` bundles the Extension with esbuild into three self-contained IIFE bundles, one per execution context, and copies the static files:

| Entry | Bundle | Loaded by |
|---|---|---|
| `src/background.ts` | `dist/background.js` | `manifest.json` `background.scripts` |
| `src/content.ts` | `dist/content.js` | `manifest.json` `content_scripts` (and the early injection on tabs with logging on) |
| `src/popup/popup.ts` | `dist/popup/popup.js` | `dist/popup/popup.html` (`browser_action.default_popup`) |
| `src/popup/popup.html`, `src/popup/popup.css`, `src/content.css` | copied to `dist/` | |

`manifest.json` loads exactly one script per context. Details of the build:

- `dist/` is deleted first, so no old file ends up in the package.
- The target is `firefox<major of strict_min_version>`; the output is not minified (readable for AMO review).
- `npm run build:dev -w @kitsune-mcp/extension` also writes linked source maps (`dist/**/*.js.map`; `web-ext-config.mjs` keeps them out of the package).
- esbuild does not type-check. `npm run typecheck` (`tsc --noEmit`, also run by the Extension's `build`) does. The sources are ES modules (`moduleResolution: bundler`, `isolatedModules`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, no `@types/node`).
- The build fails when a bundle contains zod or `packages/shared/src/node`, when a bundle does not start with `"use strict";`, or when a file that `manifest.json` loads is missing.
- The script lives outside `packages/extension` because web-ext packs every file there that `web-ext-config.mjs` does not ignore.

`npm run lint:ext` runs `web-ext lint` from the repository root, where `web-ext-config.mjs` sets `sourceDir: 'packages/extension'` and the files to leave out (`src`, `package.json`, `tsconfig.json`, source maps, …).

## `@kitsune-mcp/shared`

| Import | Contents | Used by |
|---|---|---|
| `@kitsune-mcp/shared` | zod schemas (protocol, actions, Native Host messages), action names, constants (`ENV`, …), small utilities. No Node.js APIs (`packages/shared/tests/browser-safe.test.ts` checks this) | daemon, relay, Native Host; the Extension only for exports that do not pull in zod |
| `@kitsune-mcp/shared/action-names` | the browser command action names, zod-free | the Extension |
| `@kitsune-mcp/shared/node` | helpers of the Node.js processes (below) | daemon, relay, Native Host, doctor |

The Extension bundles `@kitsune-mcp/shared` from its sources (`packages/shared/src`), not from `dist/`. Only `@kitsune-mcp/shared` and `@kitsune-mcp/shared/action-names` resolve; any other subpath, `/node` included, is a build error. The Extension's `tsconfig.json` maps the same two names to the sources. Vitest also resolves all three imports to the sources, so tests need no build.

Modules of `@kitsune-mcp/shared/node` (`packages/shared/src/node/`):

| Module | Contents |
|---|---|
| `paths` | files under `~/.kitsune-mcp/` (data and logs directories, API token, `daemon.log`, `native-host.log`, audit log, default `safety.json` and screenshots directory), resolved at call time |
| `endpoint` | `FOX_HOST` / `FOX_HTTP_PORT` / `FOX_WS_PORT` (and the legacy names), loopback check |
| `token` | reading the API token; creating it (daemon only) |
| `health` | judging a `GET /health` answer (daemon singleton check, relay, Native Host, doctor) |
| `log` | 5 MB rotation to `<file>.old` (rename, or copy-truncate), line stamps `<ISO time> [<pid>] `, the `[KitsuneMCP:<role>]` stderr logger |
| `spawn` | starting the daemon as a detached process, stderr appended to `daemon.log` (rotated first with copy-truncate) |
| `version` | `version` of a `package.json` |
| `auth` | HMAC challenge–response between the daemon and its clients, protocol version |

`daemon.log` always rotates with copy-truncate: a running daemon keeps it open, and a rename would make it keep writing to `.old`. It is checked before a relay or the Native Host starts a daemon, and every hour while a Native Host runs. `native-host.log` and `audit.jsonl` are renamed.

## Tests

`vitest.config.mts` defines the projects `shared`, `mcp-server`, `native-host` (`packages/<pkg>/tests/`), `contract` (`tests/contract/`), `scripts` (`tests/scripts/`) and `e2e` (`tests/e2e/`, only with `npm run test:e2e`). The Extension is not a project: `background.ts` and `content.ts` register browser listeners at their top level, so contract tests read their sources or import the modules without side effects (`action-map.ts`, `approval.ts`, `url-rule.ts`). Every test file runs with a temporary home directory.
