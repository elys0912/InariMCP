# Development

**English** | [日本語](./development.ja.md)

How the packages are built and checked. For using InariMCP, see the [README](../README.md).

## Requirements

- Running InariMCP needs Node.js 20 or later (`engines` in `package.json`, the installer's minimum). The reproducible build for the AMO review uses Node.js 24.x and npm 11.x (`.nvmrc`, [BUILD.md](BUILD.md)), so the Extension package you build matches the submitted one.
- `playwright` (an optional dependency of `packages/mcp-server`, installed by `npm ci` unless `--omit=optional` is given). `npm run build` needs it: the headless backend imports its types. `npm run test:e2e` and `npm run e2e:extension` also need its Firefox (`npx playwright install firefox`).

## Workflow

Run from the repository root:

```bash
npm ci
npm run build           # every workspace (see Build)
npm run typecheck       # every workspace with a typecheck script (now: the Extension), then typecheck:tests
npm test                # Vitest, all projects except e2e
npm run lint:ext        # web-ext lint of packages/extension
npm run pack:ext        # the Extension package for AMO, its file hashes, then web-ext lint (see Release)
npm run pack:source     # the source package for AMO (see Release)
npm run e2e:extension   # the Extension loads into Firefox as a temporary add-on
```

`npm run test:e2e` (relay → daemon → headless Firefox) and the scripts in `scripts/e2e/` are listed under "Development" in the README.

`npm run smoke:reviewer` (`scripts/e2e/reviewer-smoke.mjs`) calls the tools as an MCP client against a local test page on 127.0.0.1 and waits for the click to be approved in the extension's popup; `npm run smoke:reviewer -- --headless` runs it on headless Firefox without the extension. The steps for add-on reviewers are in [amo/reviewer-smoke.md](./amo/reviewer-smoke.md).

## Build

`npm run build` runs `build` in every workspace.

| Package | Build | Output |
|---|---|---|
| `packages/shared` | `tsc -b` | `dist/` (with `.d.ts`) |
| `packages/mcp-server` | `tsc -b` | `dist/` (`dist/index.js` is the relay / daemon / doctor entry) |
| `packages/native-host` | `tsc -b` | `dist/` |
| `packages/extension` | `npm run typecheck`, then `node ../../scripts/build-extension.mjs` | `dist/` (bundles) |

### Extension (esbuild)

`scripts/build-extension.mjs` bundles the Extension with esbuild into four self-contained IIFE bundles, one per execution context, and copies the static files:

| Entry | Bundle | Loaded by |
|---|---|---|
| `src/background.ts` | `dist/background.js` | `manifest.json` `background.scripts` |
| `src/content.ts` | `dist/content.js` | `manifest.json` `content_scripts` |
| `src/popup/popup.ts` | `dist/popup/popup.js` | `dist/popup/popup.html` (`browser_action.default_popup`) |
| `src/consent/consent.ts` | `dist/consent/consent.js` | `dist/consent/consent.html` (the consent page; the background opens it on the first install) |
| `src/popup/popup.html`, `src/popup/popup.css`, `src/consent/consent.html`, `src/consent/consent.css`, `src/content.css` | copied to `dist/` | |

`manifest.json` loads exactly one script per context. Details of the build:

- `dist/` is deleted first, so no old file ends up in the package.
- The target is `firefox<major of strict_min_version>`; the output is not minified (readable for AMO review).
- `npm run build:dev -w @inari-mcp/extension` also writes linked source maps (`dist/**/*.js.map`; `web-ext-config.mjs` keeps them out of the package).
- esbuild does not type-check. The Extension's `typecheck` script (`tsc -p tsconfig.json --noEmit`, run by its `build` and by the root `npm run typecheck`) does. The sources are ES modules (`moduleResolution: bundler`, `isolatedModules`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, no `@types/node`).
- The build fails when a bundle contains zod or `packages/shared/src/node`, when a bundle does not start with `"use strict";`, or when a file that `manifest.json` loads is missing.
- The script lives outside `packages/extension` because web-ext packs every file there that `web-ext-config.mjs` does not ignore.

`npm run lint:ext` runs `web-ext lint` from the repository root, where `web-ext-config.mjs` sets `sourceDir: 'packages/extension'` and the files to leave out (`src`, `package.json`, `tsconfig.json`, source maps, …).

## Release

Steps for a new version, for example 0.1.1. The AMO submission is the listed channel; the reviewer's build instructions are [`BUILD.md`](./BUILD.md), which the source package carries at its top level.

1. **Version.** Set the same `version` in six files: `package.json`, `packages/shared/package.json`, `packages/mcp-server/package.json`, `packages/native-host/package.json`, `packages/extension/package.json` and `packages/extension/manifest.json`. `npm run build` and the test suite do not check this, `--doctor` does (its `versions` item). Edit by hand: `npm version` changes one `package.json` (the workspaces need `--workspaces` as well), never the `manifest.json`, and commits and tags on its own, before the changelog is final. Then run `npm install --package-lock-only` so `package-lock.json` carries the same version, and commit it. A version that has been submitted to AMO cannot be submitted again; the version in the manifest must be higher than the previous one.
2. **Changelog.** In `docs/CHANGELOG.md` and `docs/CHANGELOG.ja.md`, rename "Unreleased" to the version and the date (`date` of the day), and check that every user-visible change is listed.
3. **Checks.** `npm ci`, `npm run build`, `npm run typecheck`, `npm test`. CI runs the same on Ubuntu 24.04 ARM64 (`.github/workflows/ci.yml`).
4. **Commit and tag.** Commit with a clean working tree (`git status` prints nothing), then `git tag v<version>`. `npm run pack:source` refuses a working tree that is not clean.
5. **Packages.** `npm run pack:ext` and `npm run pack:source`. Both write to `web-ext-artifacts/` (ignored by git):
   - `inari_mcp_for_firefox-<version>.zip` and `.sha256.txt`: the add-on and the SHA-256 of each file in it. `pack:ext` fails when `web-ext lint` reports any error or warning. Building twice gives the same hashes (`tests/scripts/pack-extension.test.ts`); a zip file itself differs by its file times, so compare the `.sha256.txt` files.
   - `inari-mcp-source-<version>.zip`: the tracked files of `HEAD` and `BUILD.md`.
6. **Submit.** Push the tag, make a GitHub release and attach the `.sha256.txt`. In the AMO Developer Hub, upload the add-on zip as a listed version, upload the source zip when asked whether the add-on uses bundled or minified code, and paste the text of `docs/amo/reviewer-notes.md` into Notes for Reviewers.

CI does not upload the packages (to save Actions storage); make them locally at step 5.

## `@inari-mcp/shared`

| Import | Contents | Used by |
|---|---|---|
| `@inari-mcp/shared` | zod schemas (protocol, actions, Native Host messages), action names, constants (`ENV`, …), small utilities. No Node.js APIs (`packages/shared/tests/browser-safe.test.ts` checks this) | daemon, relay, Native Host; the Extension only for exports that do not pull in zod |
| `@inari-mcp/shared/action-names` | the browser command action names, zod-free | the Extension |
| `@inari-mcp/shared/field-mask` | which form fields have their value masked (`[MASKED]`), import-free | the Extension (the headless backend through `@inari-mcp/shared`) |
| `@inari-mcp/shared/url-pattern-limit` | the length and shape limits of a `urlPattern` argument, import-free | the Extension (the daemon through `@inari-mcp/shared`) |
| `@inari-mcp/shared/node` | helpers of the Node.js processes (below) | daemon, relay, Native Host, doctor |

The Extension bundles `@inari-mcp/shared` from its sources (`packages/shared/src`), not from `dist/`. Only `@inari-mcp/shared`, `@inari-mcp/shared/action-names`, `@inari-mcp/shared/field-mask` and `@inari-mcp/shared/url-pattern-limit` resolve; any other subpath, `/node` included, is a build error. The Extension's `tsconfig.json` maps the same four names to the sources. Vitest also resolves all five imports to the sources, so tests need no build.

Modules of `@inari-mcp/shared/node` (`packages/shared/src/node/`):

| Module | Contents |
|---|---|
| `paths` | files under `~/.inari-mcp/` (data and logs directories, API token, `daemon.log`, `native-host.log`, audit log, default `safety.json` and screenshots directory), resolved at call time |
| `endpoint` | `FOX_HOST` / `FOX_HTTP_PORT` / `FOX_WS_PORT` (and the legacy names), loopback check |
| `token` | reading the API token; creating it (daemon only) |
| `health` | judging a `GET /health` answer (daemon singleton check, relay, Native Host, doctor) |
| `log` | 5 MB rotation to `<file>.old` (rename, or copy-truncate), line stamps `<ISO time> [<pid>] `, the `[InariMCP:<role>]` stderr logger |
| `spawn` | starting the daemon as a detached process, stderr appended to `daemon.log` (rotated first with copy-truncate) |
| `version` | `version` of a `package.json` |
| `auth` | HMAC challenge–response between the daemon and its clients, protocol version |

`daemon.log` always rotates with copy-truncate: a running daemon keeps it open, and a rename would make it keep writing to `.old`. It is checked before a relay or the Native Host starts a daemon, and every hour while a Native Host runs. `native-host.log` and `audit.jsonl` are renamed.

## Tests

`vitest.config.mts` defines the projects `shared`, `mcp-server`, `native-host` (`packages/<pkg>/tests/`), `contract` (`tests/contract/`), `scripts` (`tests/scripts/`) and `e2e` (`tests/e2e/`, only with `npm run test:e2e`). The test files that drive a real headless Firefox are in projects of their own, `mcp-server-firefox` and `contract-firefox` (one retry each), so `npx vitest run --project=mcp-server` alone does not run them; add `--project=mcp-server-firefox`. When Firefox cannot be launched, their tests are skipped, except on CI: with `CI` set (to anything but empty, `0` or `false`) the run fails instead. `INARI_REQUIRE_FIREFOX` (same values) does the same without `CI`. `npm run test:firefox` runs only these two projects with `INARI_REQUIRE_FIREFOX=1`, and also fails when any of their tests was skipped; run it where Firefox is installed (on CI as well) to make sure the real-browser tests ran. The Extension is not a project: `background.ts` and `content.ts` register browser listeners at their top level, so contract tests read their sources or import the modules without side effects (`action-map.ts`, `approval.ts`, `url-rule.ts`). Every test file runs with a temporary home directory.

`npm run typecheck:tests` (the second half of `npm run typecheck`) type-checks the tests with `tsconfig.test.json`: `packages/*/tests`, `tests/contract`, `tests/e2e`, `tests/scripts` and `tests/setup`. It uses `bundler` resolution and the same `@inari-mcp/shared` paths as `vitest.config.mts`, so no build is needed.

Golden files (`tests/golden/`) record behaviour that must not change by accident: the BrowserCommand and safety-guard decision of each tool call (`tests/contract/tool-golden.test.ts`) and the `tools/list` of a session (`tests/contract/tools-list.test.ts`). When a change is intended, regenerate them with `UPDATE_GOLDEN=1 npx vitest run <test file>` and review the diff. `node scripts/tools-list-size.mjs` prints the size of both tool lists.

## Real-device check: tool consolidation

The 41 earlier tools became 21 (README: [Tool name migration](../README.md#tool-name-migration)). The tests cover the server side and the headless path (`npm run test:e2e`); this check covers the extension path in a real Firefox, and the headless path by hand. Record each step as OK / NG / not run, with the call, the result and the matching `daemon.log` lines for an NG.

Preparation:

1. `npm ci && npm run build`, then load the extension (as a temporary add-on, README: [Install the extension from AMO](../README.md#install-the-extension-from-amo)) and check the connection with `--doctor` (README: [Command line](../README.md#command-line)).
2. For the headless runs, start the daemon with `FOX_HEADLESS=1` (README: [Headless mode](../README.md#headless-mode)); do not connect the extension at the same time.
3. Add a test host to `protected_url_patterns` in `safety.json`, for example a local HTTP server under a name in the hosts file. Do not use a real bank or payment site.

Tool lists:

| # | Session | Expected |
|---|---|---|
| 1-1 | `FOX_CAPS` unset | the 17 tools; no earlier names |
| 1-2 | `FOX_CAPS=legacy` | the 31 earlier tools; replaced ones start their description with `[Deprecated: …]` |
| 1-3 | `FOX_CAPS=core,human` | the `core` tools, `fox_request_approval`, `fox_detect_captcha` and `fox_safety_status` |

New names (on both paths unless noted):

| # | Call | Expected |
|---|---|---|
| 2-1 | `fox_navigate` `{url}` | navigates, returns the URL |
| 2-2 | `fox_tab` `{action: "create", url}`, then `{action: "switch", tabId}`, then `{action: "close", tabId}` | creates, switches to, closes the tab |
| 2-3 | `fox_tab` `{action: "create", url, container: {name: "Work"}}` | extension: a container tab opens. Headless: error, containers not supported |
| 2-4 | `fox_wait` `{for: "url", urlPattern}` | returns at once when the URL already matches, else after the navigation |
| 2-5 | `fox_read` `{mode: "text"}`, `fox_find` `{by: "text", text}` | the page text; the match count |
| 2-6 | `fox_set_value` `{kind: "select", selector, option: {text}}` | the option is selected |
| 2-7 | `fox_interact` `{action: "highlight", selector}` | the element is outlined |
| 2-8 | `fox_wait` `{for: "network_idle"}` while the page has a fetch running | extension: returns once it ended; afterwards the page's own `fetch` is back (in the page's console, `window.fetch.toString()` shows `[native code]`) |

Earlier names (`FOX_CAPS=legacy`):

| # | Call | Expected |
|---|---|---|
| 3-1 | `fox_get_text` `{}` twice | the same result as 2-5; only the first one ends with `Note: fox_get_text is deprecated; use fox_read with mode='text'.` |
| 3-2 | `fox_create_tab` `{url}` | the same as the create step of 2-2 |
| 3-3 | the `audit.jsonl` line of 3-2 | `"tool": "fox_tab"`, `"legacyTool": "fox_create_tab"` |

Protected site:

| # | Call | Expected |
|---|---|---|
| 4-1 | `fox_tab` `{action: "create", url: <protected URL>}` | you are asked (MCP elicitation or the toolbar popup); after approval the call runs once |
| 4-2 | 4-1, declined | nothing runs; the result says it was declined |
| 4-3 | on a protected page, `fox_interact` `{action: "scroll"}` (extension) | runs without asking (UI-only) |
| 4-4 | on a protected page the daemon knows about, `fox_set_value` `{selector, value}` (extension) | you are asked (safety guard); after approval it runs |
| 4-5 | open a protected page by hand, then 4-4 (the daemon does not know the URL) | the extension refuses with confirmation_required, you are asked, after approval it runs (the approved host reaches the extension) |
| 4-6 | 4-1 with the earlier name `fox_create_tab` (`FOX_CAPS=legacy`) | the same flow; the question names `fox_create_tab` |

Keep the steps that could not be checked on a real device separate in the report.
