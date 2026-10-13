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
npm run typecheck       # every workspace with a typecheck script (now: the Extension), then typecheck:tests
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
- esbuild does not type-check. The Extension's `typecheck` script (`tsc -p tsconfig.json --noEmit`, run by its `build` and by the root `npm run typecheck`) does. The sources are ES modules (`moduleResolution: bundler`, `isolatedModules`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, no `@types/node`).
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

`vitest.config.mts` defines the projects `shared`, `mcp-server`, `native-host` (`packages/<pkg>/tests/`), `contract` (`tests/contract/`), `scripts` (`tests/scripts/`) and `e2e` (`tests/e2e/`, only with `npm run test:e2e`). The test files that drive a real headless Firefox are in projects of their own, `mcp-server-firefox` and `contract-firefox` (one retry each), so `npx vitest run --project=mcp-server` alone does not run them; add `--project=mcp-server-firefox`. When Firefox cannot be launched, their tests are skipped, except on CI: with `CI` set (to anything but empty, `0` or `false`) the run fails instead. `KITSUNE_REQUIRE_FIREFOX` (same values) does the same without `CI`. `npm run test:firefox` runs only these two projects with `KITSUNE_REQUIRE_FIREFOX=1`, and also fails when any of their tests was skipped; run it where Firefox is installed (on CI as well) to make sure the real-browser tests ran. The Extension is not a project: `background.ts` and `content.ts` register browser listeners at their top level, so contract tests read their sources or import the modules without side effects (`action-map.ts`, `approval.ts`, `url-rule.ts`). Every test file runs with a temporary home directory.

`npm run typecheck:tests` (the second half of `npm run typecheck`) type-checks the tests with `tsconfig.test.json`: `packages/*/tests`, `tests/contract`, `tests/e2e`, `tests/scripts` and `tests/setup`. It uses `bundler` resolution and the same `@kitsune-mcp/shared` paths as `vitest.config.mts`, so no build is needed.

Golden files (`tests/golden/`) record behaviour that must not change by accident: the BrowserCommand and safety-guard decision of each tool call (`tests/contract/tool-golden.test.ts`) and the `tools/list` of a session (`tests/contract/tools-list.test.ts`). When a change is intended, regenerate them with `UPDATE_GOLDEN=1 npx vitest run <test file>` and review the diff. `node scripts/tools-list-size.mjs` prints the size of both tool lists.

## Real-device check: tool consolidation

The 41 earlier tools became 21 (README: [Tool name migration](../README.md#tool-name-migration)). The tests cover the server side and the headless path (`npm run test:e2e`); this check covers the extension path in a real Firefox, and the headless path by hand. Record each step as OK / NG / not run, with the call, the result and the matching `daemon.log` lines for an NG.

Preparation:

1. `npm ci && npm run build`, then load the extension (README: [Load the extension in Firefox](../README.md#load-the-extension-in-firefox)) and check the connection with `--doctor` (README: [Command line](../README.md#command-line)).
2. For the headless runs, start the daemon with `FOX_HEADLESS=1` (README: [Headless mode](../README.md#headless-mode)); do not connect the extension at the same time.
3. Add a test host to `protected_url_patterns` in `safety.json`, for example a local HTTP server under a name in the hosts file. Do not use a real bank or payment site.

Tool lists:

| # | Session | Expected |
|---|---|---|
| 1-1 | `FOX_CAPS` unset | the 21 tools; no earlier names |
| 1-2 | `FOX_CAPS=legacy` | the 41 earlier tools; replaced ones start their description with `[Deprecated: …]` |
| 1-3 | `FOX_CAPS=core,logs` | the `core` tools, `fox_logging`, `fox_get_logs` and `fox_safety_status` |

New names (on both paths unless noted):

| # | Call | Expected |
|---|---|---|
| 2-1 | `fox_navigate` `{url}` | navigates, returns the URL |
| 2-2 | `fox_tab` `{action: "create", url}`, then `{action: "switch", tabId}`, then `{action: "close", tabId}` | creates, switches to, closes the tab |
| 2-3 | `fox_tab` `{action: "create", url, container: {name: "Work"}}` | extension: a container tab opens. Headless: error, containers not supported |
| 2-4 | `fox_wait` `{for: "url", urlPattern}` | returns at once when the URL already matches, else after the navigation |
| 2-5 | `fox_logging` `{action: "start"}`, a fetch in the page, `fox_get_logs` `{kind: "network"}` | extension: the request is listed. Headless: error, not supported |
| 2-6 | `fox_evaluate` `{mode: "script", script: "document.title"}` | the page title |
| 2-7 | `fox_evaluate` `{mode: "chain", steps: [...]}` | extension: `Not implemented in extension`. Headless: the result of each step |
| 2-8 | `fox_read` `{mode: "text"}`, `fox_find` `{by: "text", text}` | the page text; the match count |
| 2-9 | `fox_set_value` `{kind: "select", selector, option: {text}}` | the option is selected |
| 2-10 | `fox_interact` `{action: "highlight", selector}` | the element is outlined |

Earlier names (`FOX_CAPS=legacy`):

| # | Call | Expected |
|---|---|---|
| 3-1 | `fox_get_text` `{}` twice | the same result as 2-8; only the first one ends with `Note: fox_get_text is deprecated; use fox_read with mode='text'.` |
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
