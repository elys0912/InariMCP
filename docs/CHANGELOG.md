# Changelog

**English** | [日本語](./CHANGELOG.ja.md)

User-facing changes of Inari MCP for Firefox, newest first.

Inari MCP for Firefox started on 2026-10-14 as a copy of [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0 (commit b2642a9). It is the edition prepared for listing on addons.mozilla.org: it has a different add-on ID, a different native-messaging host name (`inari_mcp`) and a different state directory (`~/.inari-mcp`), so both editions can be installed side by side. For the history before the split, see the KitsuneMCP changelog.

## Unreleased (0.1.0)

### Added

- First-run permission page: right after installation the extension asks, in a tab, whether Inari MCP for Firefox may connect (what it does, what it sends, what it needs, privacy policy). It does not connect to the native host until you allow it; until then the badge shows `OFF`, and the popup reopens the page. Needs the `storage` permission to remember the answer.
- Pause switch in the toolbar popup: while on, every command from the MCP client is refused with an error starting with `paused`, pending approval requests are withdrawn, and the badge shows `II`.
- The badge shows `●` while a command from the MCP client runs. The badge states have one order: not allowed, paused, approval count, running, setup state.
- README: a Permissions section lists what each of the ten extension permissions is used for and where (`cookies` reads no cookie; it is what Firefox requires to open a tab in a container), and that the agent can create a Firefox container.
- Release tooling for addons.mozilla.org: `npm run pack:ext` builds the Extension zip, writes the SHA-256 of every file in it and runs `web-ext lint` (0 errors and 0 warnings required); `npm run pack:source` makes the source zip from the committed files. [`docs/BUILD.md`](./BUILD.md) tells a reviewer how to rebuild the add-on (Node.js 24, npm 11) and compare it with the submitted one. A GitHub Actions workflow builds, type-checks and tests on Ubuntu 24.04 ARM64.
- Privacy policy: [docs/PRIVACY.md](./PRIVACY.md) ([日本語](./PRIVACY.ja.md)): what is read and sent, where it goes, what stays on your computer and for how long, how to delete it, consent and control, private browsing.
- Material for the addons.mozilla.org listing ([docs/amo/listing.md](./amo/listing.md)) and the Notes for Reviewers ([docs/amo/reviewer-notes.md](./amo/reviewer-notes.md)).

### Changed

- Renamed from KitsuneMCP to Inari MCP for Firefox. Add-on ID `inari-mcp@elys0912.github.io`, host manifest `inari_mcp`, state directory `~/.inari-mcp`, npm packages `@inari-mcp/*`.
- Line endings in the repository are fixed to LF with `.gitattributes`, so the extension built on any OS is byte-identical to the one submitted for review.
- `manifest.json`: `incognito` is `not_allowed` (the extension never sees private-browsing tabs), and `data_collection_permissions` declares `websiteContent` and `browsingActivity` (page content, screenshots and URLs are sent to the local native host and from there to the MCP client).
- `fox_wait` with `for: "network_idle"`: the counting hooks on the page's `fetch` and `XMLHttpRequest.prototype.send` are installed when the wait starts and removed when it ends (before, they stayed until the page unloaded). They count requests and record nothing about them. Requests already running when the call starts are not seen.
- Screenshots saved under a `filename` you chose are now deleted after `FOX_SCREENSHOT_RETENTION_DAYS` (default 30) like the others; the Native Host lists them in `.named-screenshots` in the screenshots directory and never deletes any other file there.
- README: installation now starts from addons.mozilla.org (1. the extension from AMO, 2. the native host, 3. the MCP client), and the top of the README says what is sent and what is needed. The "WIP", "AMO listing not planned" and "install the unlisted .xpi from GitHub Releases" statements are gone. New sections: Privacy and Links.
- Default ports are `8785` (HTTP) and `8786` (WebSocket) instead of KitsuneMCP's `8765` / `8766`, so Inari MCP and KitsuneMCP can run at the same time. `FOX_HTTP_PORT` / `FOX_WS_PORT` still override them.
- Running Inari MCP needs Node.js 20 or later (`engines`, the installer and `--doctor`); the reproducible build for the AMO review uses Node.js 24.x and npm 11.x.
- A refusal while the agent is paused reaches the MCP client as a safety refusal (`decision: "paused"`, text starting with `paused:`) instead of a browser error.
- The extension's description and the popup footer use the name "Inari MCP for Firefox" and say that page content goes only to the native host on this computer.

### Removed

- The script tools `fox_evaluate` and `fox_observer` (earlier names `fox_execute_script`, `fox_eval_chain`, `fox_wait_and_act`, `fox_inject_observer`, `fox_remove_observer`), on the extension and in headless mode. The extension no longer runs code given as a string (`tabs.executeScript` with `code`).
- The logging tools `fox_logging` and `fox_get_logs` (earlier names `fox_start_logging`, `fox_stop_logging`, `fox_clear_logs`, `fox_get_console_logs`, `fox_get_network_logs`). The extension no longer records the page's console messages or fetch / XHR traffic.
- The `allow_script_execution` key of `safety.json` and the `FOX_ALLOW_SCRIPTS` / `CLAUDE_BROWSER_ALLOW_SCRIPTS` variables. A `safety.json` that still has the key is refused as an unknown key until the key is deleted.
- The `logs` and `script` profiles of `FOX_CAPS` (an unknown profile name is ignored with a warning).
- The "Inspect Element for InariMCP" context menu entry: it handed its result to nobody.

### Security

- Values are masked as `[MASKED]` in more fields, on the extension and in headless mode alike: besides password fields, `type="hidden"` fields and fields whose `autocomplete` is `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month` or `cc-exp-year` (`current-password` / `new-password` as before). `allow_password_typing` still only allows typing into password fields and unmasks nothing.
- The daemon refuses to start when `FOX_HOST` is not a loopback address (127.0.0.0/8, `::1`, `localhost`), instead of logging a warning and serving plain HTTP / WebSocket to the network.
- Tools that act on a page are refused on a tab without a host (`view-source:`, `blob:`, `data:`, …; `about:` and `file:` excepted), which no URL pattern of `safety.json` can match. Reading tools still work there.
- A `urlPattern` argument longer than 256 characters, or with a repeated group that contains a repeat (such as `(a+)+`), is refused before it is compiled, by the daemon and again by the extension, so one pattern cannot stall the extension's background page.
