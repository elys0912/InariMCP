# Changelog

**English** | [日本語](./CHANGELOG.ja.md)

User-facing changes of KitsuneMCP, newest first. Commit hashes are given in parentheses.

## Unreleased

Changes since 0.1.4. Read **Breaking** before updating, and follow [Update](../README.md#update) in the README.

### Security

- **URL patterns match the parsed URL, and the Extension checks the same way**: `safety.json` patterns are compared with the host (and subdomains), the path and the scheme of the parsed URL, so `example.com.attacker.net` or a query string that mentions a host no longer matches. URLs with a user name or password are refused, and a result whose final URL (after a redirect or a click) is blocked is withheld. Check your lists with `fox_safety_status` after updating (db0e662, b1ebced, 9f5a61d, f8d6496)
- **A broken `safety.json` refuses every tool (fail-closed)**: when the file cannot be read, is not valid JSON, has a wrong type or an unusable URL pattern, every tool except `fox_safety_status` is refused, even with `enabled: false`. Fix the file, restart the daemon and check with `fox_safety_status` (db0e662)
- **Human approval moved out of the page, with one-time approval tokens**: a protected-site action is approved in Claude Code's confirmation dialog (MCP elicitation) or in the toolbar popup, never by buttons in the page, `fox_click` or `fox_execute_script`. An approval covers one call of that tool with exactly those arguments on that host, and the token is seen only by the relay (282ec53, bb005ba)
- **HMAC mutual authentication between the daemon and the Native Host / relays**: the API token is no longer sent; each side proves it holds the token with an HMAC challenge–response, so a program that takes over the port cannot pose as the daemon. A starting daemon whose port is already taken checks the other process's proof, and exits with an error when it is not a KitsuneMCP daemon holding the same token (1de3ecf, 4d2b712)
- **`re:` URL patterns must match the whole URL**: they are anchored as `^(?:<regex>)$`, so `re:example\.com` in `allowed_url_patterns` no longer lets `https://example.com.attacker.net/` through. See Breaking for existing patterns (a015fa5)
- **IPv6 literals and `host:port` in URL patterns**: `[::1]` is read as a host (it used to match every URL containing `:`), and `example.com:8443` matches that port only. An IPv6 address that cannot be parsed, an invalid port or `*.` with an IP address is a configuration error (7ba27cf)
- **Limits on unauthenticated connections and slow request bodies**: at most 8 WebSocket connections may wait for authentication (5 s each, 64 KB before the authentication frame), refused connections are terminated, and an HTTP request body must arrive within 30 s (146fc2d, 2fe3e69)
- **Results cannot be spoofed by an iframe**: commands to a page go to the top frame only, so a frame in the page cannot answer in its place (47d43c6)
- **More secrets are masked in results and the audit log**: credential headers and keys (`x-api-key`, `proxy-authorization`, `accessToken`, …), Basic credentials, `token=` / `password=` in query strings, forms and JSON, and URL fragments are masked; invisible and bidirectional control characters are removed from results (0f0ad33, b1ebced)

### Breaking

- **The in-page approval banner is gone**: approval requests appear as an amber count on the KitsuneMCP toolbar button (plus an OS notification). Open the popup and approve or deny; Claude Code's own confirmation dialog is used first when the client supports MCP elicitation. Reload the extension after updating so the popup is available (bb005ba, 282ec53)
- **`re:` patterns no longer match as a prefix**: a pattern such as `re:^https://example\.com/` stops matching longer URLs, with no warning — in `allowed_url_patterns` those URLs are refused, in the blocked and protected lists they are no longer blocked or protected. Append `.*` to keep the prefix meaning (`re:^https://example\.com/.*`), then check with `fox_safety_status` after a daemon restart (a015fa5)
- **Old-style regular expressions in `allowed_url_patterns` are a configuration error**: simple ones (`paypal\.com`, `^https://a\.example/`) are read as host patterns; any other one makes `safety.json` unusable (every tool refused). Rewrite it as a host pattern or as `re:`. In the blocked and protected lists such a pattern keeps its old meaning, with a warning (db0e662, b1ebced)
- **A daemon from the old version must be stopped**: the daemon, the relays and the Native Host now authenticate with HMAC and check the protocol version, and an old Native Host's plain token is refused. When the relay or the Native Host reports that the running daemon "speaks protocol …" / "is from another version", stop that daemon process (restart Firefox if the Native Host started it) and reload the extension; the next tool call starts a matching daemon (1de3ecf, 7ba27cf)
- **`install.ps1` / `install.sh` / `uninstall.ps1` / `uninstall.sh` are replaced by `npm run setup` / `npm run teardown`**: the Node.js installer needs no PowerShell and does not build unless asked. Run `npm ci`, `npm run build`, then `npm run setup` (or `npm run setup -- --build`); `npm run install:*` / `uninstall:*` remain as aliases. For manual setup, the manifest template is now `packages/native-host/kitsune_mcp.json` and `run-host.cmd` / `run-host.sh` are no longer in the repository: `node scripts/install.mjs --manual` prints the steps (5b8645f, fae166b)
- **`FOX_HEADLESS` is on only for `1`, `true` or `yes`**: `FOX_HEADLESS=0` or `false` used to turn headless mode on. Remove the variable or set `0` to use the extension path. `FOX_READ_ONLY` now also accepts `true` / `yes`, and `FOX_ALLOW_SCRIPTS` accepts `false` / `no` / `off` (2e9ab03, dcf7bfa)
- **`fox_type` no longer uses `text` to find the element, and `pressEnter` submits the form**: the text to type is never used as a locator. Pass `selector`, `xpath`, `placeholder`, `name` or `id`, or leave them out to type into the focused element. `pressEnter` (and `fox_press_key` Enter) submits the form the way a real Enter does (47d43c6)
- **Headless `fox_snapshot` and `fox_scroll` changed**: `fox_snapshot` returns the accessibility tree as YAML text (with `maxDepth`, `includeText`, `roles`) instead of a base64 screenshot; use `fox_screenshot` for an image. `fox_scroll` follows `direction`, `amount`, `selector` and `toElement` instead of always scrolling 300 px down (208cb30)
- **Tool classes are derived from the tool schemas**: `fox_remove_observer` is a script tool and is refused when script execution is off. `fox_hover`, `fox_scroll`, `fox_highlight` and `fox_switch_tab` are class `interact`: they work in read-only mode and on protected sites without approval, and their `readOnlyHint` is `false` (7febaa5)
- **Every package reports version 0.1.4**: the daemon, relay and Native Host used to report 0.1.0 while the extension was 0.1.4; all `package.json` files and the manifest now have the same version, which `--doctor` checks. Update all parts together (c9cbd41)

### Added

- **`--help`, `--version` and `--doctor`**: `node packages/mcp-server/dist/index.js --doctor` checks 14 items (build, Firefox and Claude Code registration, daemon, token, logs, …) read-only and prints a fix for each problem. `--help` / `--version` exit before a daemon, token or log is created. An unknown argument now exits with code 2 instead of starting a relay (5afc516, 0e06a30)
- **`FOX_APPROVAL_ELICITATION`**: set `0` / `false` / `off` / `no` to approve protected-site actions in the Firefox popup only (headless mode then cannot approve). It is on by default (4a785bb)
- **`FOX_SCREENSHOT_RETENTION_DAYS`** (default `30`): at each Native Host start, screenshots saved under a generated name and older than this many days are deleted. Set `0` to keep everything; files saved under your own `filename` are never deleted (69b1af9)
- **Logs survive reloads and navigations**: console and network logs are kept per tab in the Extension's background (latest 500 of each), so `fox_get_console_logs` / `fox_get_network_logs` return entries from before a navigation (47d43c6)
- **Timestamps in `daemon.log`**: each line starts with `<ISO 8601 time> [<pid>] `, like `native-host.log` (7b03a8f)
- **Headless mode lists ignored parameters**: parameters the headless backend does not support are reported in the result's `warnings` (in `error` on failure) (208cb30, 59597b6)
- **`playwright` is optional**: the relay and the extension-path daemon start without it; a `FOX_HEADLESS` daemon without it exits with a message that explains how to install it. `npm run build` still needs it (1cf3974, 2e9ab03)
- **End-to-end smoke tests**: `npm run test:e2e` drives relay → daemon → headless Firefox over MCP with a temporary home directory and free ports, and `npm run e2e:extension` checks that the extension loads into Firefox (2bd20a0)
- **`@kitsune-mcp/shared/node`**: the Node.js helpers of the daemon, relay and Native Host (paths, endpoint, token, `/health`, logs, daemon start, version, HMAC) in one subpath; the package root stays browser-safe (9896141)

### Fixed

- **Native Host start-up**: the host answers `ping` while it is still starting the daemon, and on Windows it starts the daemon outside Firefox's job object without PowerShell when needed (WMI, then `schtasks`), so closing Firefox does not stop the daemon. `daemon.log` is rotated with copy-truncate, because the running daemon keeps it open (82172be, c1521e9, 6856992, 099da45, 69b1af9)
- **Headless backend**: `fox_select_option` fails with `availableOptions` when no option matches, `fox_handle_dialog` no longer blocks other commands (a dialog nobody waits for is dismissed after 2 s and reported), and `FOX_HEADLESS_STARTUP_TIMEOUT` is applied to the Firefox launch (208cb30, 36cb870, 2e9ab03)
- **The relay no longer waits for the daemon before connecting**: Claude Code's MCP connection returns at once; the first tool call waits for the daemon to start (81294f6)
- **Settings differences are compared after normalisation**: `true` / `1` and old / new variable names count as the same, so the "different settings" warning no longer appears for equivalent values, also against an older daemon (dcf7bfa, f6ad469)
- **`allow_password_typing` reaches the Extension**: password fields are judged by one rule on the server, the Extension and headless mode, which also covers `fox_set_value`, `xpath` and `autocomplete` `current-password` / `new-password` (4b070f5)
- **Read-only mode and the rate limit count the right calls**: `fox_switch_tab` and `fox_detect_captcha` are no longer refused in read-only mode, and refused calls and `fox_safety_status` no longer count toward the rate limit (7febaa5, 354730c)
- **Extension tools report failures**: `fox_wait_for_network_idle` fails on timeout, `fox_select_option` fails when no option matches, `fox_click` / `fox_type` fail on disabled elements, and page loads that time out or whose tab closes fail. `fox_type` accepts `delay: 0` and keeps all delays within 10 s (47d43c6)
- **Screenshots**: `fox_screenshot` with `all_tabs` has a time budget and fails when no tab could be captured or saved, `saveToFile: false` captures nothing, and saving under an existing `filename` adds `imageOverwritten` and a warning (47d43c6, e3cb939)
- **Cancelled calls stop the browser command**: request IDs are unique per daemon start, and cancelling a tool call fails the pending browser command (4f2fb52)

### Developer

- **The Extension is bundled with esbuild**: sources are ES modules, `npm run build` writes `dist/background.js`, `dist/content.js` and `dist/popup/popup.js`, and the build fails if zod or `@kitsune-mcp/shared/node` ends up in a bundle. Load `packages/extension/manifest.json` after `npm run build` (0e3376e, 156600f)
- **Vitest**: `npm test` runs the unit, contract and installer tests, each test file with a temporary home directory; development needs Node.js 22.12 or later (or 24) (1925170, 146fc2d)
- **`npm run typecheck` checks the tests too**: it runs every workspace's typecheck and `tsconfig.test.json` over the test directories; `npm run lint:ext` runs `web-ext lint` (f93909a, 156e11d)
- **`background.ts` / `content.ts` split into modules**: under `packages/extension/src/background/` and `src/content/`, which tests import directly (d71c331, cacfcda, c7d6512, 9f51441, 176937b)
- **`docs/development.md`**: build, workflow, `@kitsune-mcp/shared` entries and test layout ([development.md](./development.md)) (9f342ae)

## Unreleased: planned

### Tool name consolidation (WP13, in progress)

<!-- Fill in the body after the final report of WP13. -->

| Old name | New name | Notes |
|---|---|---|
