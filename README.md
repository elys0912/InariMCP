# InariMCP

**English** | [日本語](./README.ja.md)

**Control your everyday Firefox from Claude Code.** A Firefox-only MCP addon — your real profile, your real logins, no throwaway browser.

> Status: **early WIP — the installer is in place (Windows, macOS and Linux; macOS untested on real hardware) and the extension path works end-to-end.** The AMO-signed extension is published on [GitHub Releases](https://github.com/elys0912/InariMCP/releases/latest). See [Status](#status) below.

![status](https://img.shields.io/badge/status-WIP-yellow) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D18-green)

---

## What is this?

InariMCP is an MCP server + Firefox extension that lets Claude Code drive your actual Firefox browser — the one with your cookies, your sessions, your extensions already installed. Instead of spinning up a throwaway profile, it talks to your running Firefox through a WebExtension and a native messaging bridge, so it can click, type, screenshot, read console/network logs, and generally act like a very fast pair of hands on the tab you're already looking at.

It's a fork of [nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser) (MIT), ported from Python to TypeScript and narrowed to Firefox only.

## Why?

Chrome already has an official Claude browser extension. Firefox doesn't — not yet. InariMCP exists to fill that gap until Anthropic (or Mozilla) ships something official. When that happens, this project's job is basically done.

## Not for you?

InariMCP is deliberately narrow. If your use case is one of these, you'll be happier elsewhere:

- **Chrome/Edge user** → use the [official Claude browser extension](https://claude.com) or [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp).
- **CI / automated testing, cross-browser** → [Playwright MCP](https://github.com/microsoft/playwright-mcp). It supports Chromium/Firefox/WebKit and disposable profiles — the right tool for that job.
- **Large-scale scraping** → [browser-use](https://github.com/browser-use/browser-use) or [Browserbase](https://www.browserbase.com/) are built for that.
- **Debugging Firefox itself (DevTools protocol level)** → [mozilla/firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp) is the real deal for that.
- **CAPTCHA solving** → InariMCP won't do this. It detects a CAPTCHA and hands control back to you — on purpose.

## Features

- **21 `fox_*` tools** covering navigation, click/type/scroll, screenshots (visible/full page/all tabs), tab management, console/network log capture, script execution and wait helpers. Related operations share one tool with a mode argument (`fox_wait` with `for: "url"`, `fox_tab` with `action: "close"`, …); the 41 earlier tool names still work, see [Tool name migration](#tool-name-migration). Prefixed `fox_` instead of `browser_` so it doesn't collide with Playwright MCP if you run both. Not all of them work on every backend yet: see [Tool availability](#tool-availability).
- **Tool profiles (`FOX_CAPS`)** — registering every tool costs real context tokens. Pick profiles (`core`, `logs`, `script`, …) to only load what you need. See [`FOX_CAPS` profiles](#fox_caps-profiles).
- **8-layer safety guard (Layers 0–7)** — container scope (0), rate limit (1), URL scheme check and block/allow lists (2–3), read-only pass-through for observation tools (4), read-only mode (5), script-execution toggle (6) and human approval on protected domains such as banks, payment processors and `.gov` (7). Every decision is written to a JSONL audit log. The guard is always on; only container scoping (Layer 0) needs opt-in.
- **Human approval outside the page** — an action on a protected site is approved by you, either in Claude Code's own confirmation dialog (MCP elicitation) or in the InariMCP toolbar popup in Firefox. Nothing inside the page can approve it. See [Human approval for protected sites](#human-approval-for-protected-sites).
- **Container isolation (opt-in)** — using Firefox's `contextualIdentities`, you can restrict the agent to a dedicated container so your banking/email sessions in other tabs stay invisible to it. This is a Firefox-only capability; Chromium has nothing equivalent.
- **Headless mode (advanced)** — a Playwright-driven, Firefox-only headless backend for when you don't want the extension path. Many tools and parameters are not supported there (see [Tool availability](#tool-availability)).
- **Firefox-native APIs** — `browser.find` for token-cheap in-page text search, `tabs.captureTab` for screenshots, including full-page and all-tabs ones (a background tab is captured without switching to it; a discarded tab is an error until you switch to it).

## Quick Start

### Prerequisites

- Node.js >= 18.0.0 (to run InariMCP; development needs more, see [Development](#development))
- Firefox 142 or later (`strict_min_version` of the extension). Developer Edition and Nightly read the same Native Messaging registration as the release build
- (Headless mode only) Playwright and its Firefox. `playwright` is an optional dependency of `packages/mcp-server`: `npm ci` installs it unless optional dependencies are omitted (`--omit=optional`). Its Firefox is a separate download: `npx playwright install firefox`

PowerShell is not needed: the installer and uninstaller are Node.js scripts.

### Install

```bash
git clone https://github.com/elys0912/InariMCP.git
cd InariMCP
npm ci
npm run build
npm run setup
```

The installer works the same way on Windows, macOS and Linux; macOS is untested on real hardware (see [Status](#status)). On Linux, a Firefox from a distribution package (deb/rpm), Mozilla's APT repository or the tarball from mozilla.org is the reliable choice; Snap and Flatpak builds need the desktop portal (see [Platform notes](#platform-notes)).

`npm run setup` (`node scripts/install.mjs`):

1. checks Node.js (>= 18) and the build output (`packages/*/dist`), and looks for Firefox (warning only),
2. writes the Native Messaging host wrapper (`run-host.cmd` / `run-host.sh`) to `~/.inari-mcp/native-host/`,
3. writes the host manifest `inari_mcp.json` where Firefox reads it (Windows: next to the wrapper, with `HKCU\Software\Mozilla\NativeMessagingHosts\inari_mcp` pointing to it, for every edition; macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/`; Linux: `~/.mozilla/native-messaging-hosts/`, plus the XDG, Snap and Flatpak directories when those builds seem to be present),
4. prints the `claude mcp add` command, or runs it with `--register-claude` (see [Add to Claude Code](#add-to-claude-code)).

It is safe to run again: unchanged files and registrations are left alone. It does not build unless asked (`--build` runs `npm install` and `npm run build` first). Options go after `--` when going through npm (`npm run setup -- --register-claude`), or call the script directly (`node scripts/install.mjs --register-claude`):

| Option | Effect |
|---|---|
| `-n`, `--dry-run` | Show what would change; change nothing |
| `-y`, `--yes` | Answer yes to every question (no prompts) |
| `--register-claude` | Register the MCP server with Claude Code (default: print the command) |
| `--claude-scope user\|local\|project` | Scope for `claude mcp add` (default `user`, i.e. every project) |
| `--node PATH` | Node executable to register (default: the one running the installer) |
| `--build` | Run `npm install` and `npm run build` first |
| `--manual` | Print the manual installation steps (Markdown) and exit |
| `-h`, `--help` | Show the usage, plus the manual steps for this machine |

Questions are asked only when stdin is a terminal; otherwise the default answer is used. `--skip-build` and `--no-register-claude` are still accepted. The old `npm run install:windows` / `install:unix` remain as aliases of `node scripts/install.mjs --build`.

**If you ever swap out or upgrade Node.js**, re-run the installer — the generated wrapper embeds the absolute path to the `node` binary that ran it (it falls back to the `node` on Firefox's `PATH` when that binary is gone). The installer warns when that node comes from a version manager, whose paths change when you switch versions; `--node` pins a stable one.

### Load the extension in Firefox

Download `inarimcp-<version>.xpi` from [GitHub Releases](https://github.com/elys0912/InariMCP/releases/latest). It is signed by AMO (unlisted: it is not in the add-on store's search) and stays installed across restarts. Install it either way:

- Drag and drop the `.xpi` onto a Firefox window.
- Open `about:addons`, click the gear icon → "Install Add-on From File..." and choose the `.xpi`.

Use the `.xpi` from the release that matches your checkout (`git checkout v<version>`): the extension, the Native Host and the server change together, and mismatched versions can refuse commands.

To try your own changes to the extension, load it as a temporary add-on instead:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. "Load Temporary Add-on..." → select `packages/extension/manifest.json` (it loads the bundles in `packages/extension/dist/`, so run `npm run build` first).
3. It's removed when Firefox restarts, so you'll need to load it again after each restart.

The InariMCP button appears in the toolbar. Its popup shows the connection state (see [Check the connection](#restart-and-check-the-connection)).

### First-run permission

Right after installation the extension opens a permission page in a new tab. It says what the add-on does, what it sends (page content, screenshots, URLs and the tab list, through the native host to the MCP client) and what it needs, and links to the [privacy policy](docs/PRIVACY.md). Until you press **Allow**, the extension does not connect to the native host and does nothing; with **Don't allow** it stays that way, and the badge shows `OFF`. To allow it later, open the toolbar popup and press "Open the permission page". The page is not shown again on updates.

### Pausing the agent

The toolbar popup has a **Pause agent actions** switch. While it is on, the extension refuses every command from the MCP client (the error starts with `paused`), withdraws the approval requests still waiting, and the badge shows `II`. Turn it off to let the agent work again. The switch is kept across restarts.

### Add to Claude Code

`npm run setup -- --register-claude` registers InariMCP with Claude Code (`claude mcp add`, scope `user` by default — available from any project), with the absolute path of node. A registration that already points to this installation is left unchanged; one that points elsewhere is replaced after asking. Without `--register-claude`, or when `claude` is not on your `PATH`, the installer prints the command; run it yourself:

```bash
claude mcp add --scope user inari-mcp -- node <INSTALL_PATH>/packages/mcp-server/dist/index.js
```

Environment variables for the server go before the name, e.g. `claude mcp add --scope user --env FOX_CAPS=core,logs inari-mcp -- node …` (but read [Whichever side starts the daemon first, its config wins](#whichever-side-starts-the-daemon-first-its-config-wins) before relying on them).

Or add it manually to your MCP config (`config/mcp_config.json` is the same template):

```json
{
  "mcpServers": {
    "inari-mcp": {
      "command": "node",
      "args": ["<INSTALL_PATH>/packages/mcp-server/dist/index.js"],
      "env": {
        "FOX_CAPS": "core,logs"
      }
    }
  }
}
```

Replace `<INSTALL_PATH>` with the absolute path of your clone.

### Restart and check the connection

1. **Restart Claude Code** (a running session does not pick up a new MCP server).
2. Make sure the extension is loaded (again, after every Firefox restart).
3. Look at the InariMCP toolbar button:

| Badge / popup | Meaning | What to do |
|---|---|---|
| no badge, popup "Connected" / "Connected (N)" | Firefox and N Claude Code sessions are connected | nothing |
| red `!`, "No session" | Firefox is ready, but no Claude Code session uses InariMCP | register it (the popup shows the command) and restart Claude Code; a running session appears within about 30 s |
| red `!`, "Setup needed" (native host missing) | Firefox cannot find the Native Messaging host | build and run the installer (the popup shows the commands), then press Recheck (Snap / Flatpak Firefox: see [Platform notes](#platform-notes)) |
| red `!`, "Setup needed" (native host failed / MCP server not responding) | the host is registered but does not start, or the daemon does not answer | re-run the installer, `npm run setup` (the popup's command also rebuilds; usual cause: Node.js was upgraded or moved); check the logs below |
| red `!`, "Update needed" | the clone is older than the extension | `git pull`, rebuild, re-run the installer, restart Firefox |
| amber number | approval requests waiting for you | open the popup and approve or deny |
| grey `OFF` | not allowed yet: the extension does not connect | open the popup → "Open the permission page" → Allow ([First-run permission](#first-run-permission)) |
| blue `II` | paused: commands from the MCP client are refused | turn off the pause switch in the popup ([Pausing the agent](#pausing-the-agent)) |
| green `●` | the MCP client is operating Firefox right now | nothing (it goes away when the command ends) |

The badge shows one state at a time, the first that applies: `OFF`, `II`, the approval count, `●`, then the setup state (`!` or nothing).

4. Run the diagnostics: `node packages/mcp-server/dist/index.js --doctor` (see [Command line](#command-line)). It checks the build, the Firefox registration, the Claude Code registration, the daemon and the logs, and prints a fix for each problem.
5. Ask Claude Code to call `fox_safety_status`. It shows the active safety policy (read-only mode, script toggle, URL patterns, rate limit, audit log path) and warns when the running daemon was started with different settings than this session. It does not report whether a browser is connected.
6. For a low-level check, query the daemon:

```bash
curl --noproxy '*' -sS http://127.0.0.1:8765/health    # Windows PowerShell: curl.exe --noproxy "*" -sS …
```

(`--noproxy` keeps a configured HTTP proxy out of a local request.) `"status":"ok"` means the daemon runs; `browsers_connected` should be `1` once the extension is connected (a few seconds after loading it). If nothing answers ("Connection refused"), no daemon is running yet: it is started by the first Claude Code session or by Firefox with the extension loaded, and it exits after 10 minutes unused. Then look at the logs.

### Logs

All under `~/.inari-mcp/logs/`:

| File | Written by |
|---|---|
| `native-host.log` | the Native Host (override with `FOX_NATIVE_HOST_LOG`; `0` / `off` / `false` / `no` / `none` disables it) |
| `daemon.log` | the shared daemon's stderr |
| `audit.jsonl` | the safety guard's audit log (`audit_log` in `safety.json`) |

Each line of `native-host.log` and `daemon.log` starts with `<ISO 8601 time> [<pid>] `. Each file is rotated to `<name>.old` once it grows past 5 MB (one generation kept): `native-host.log` and `audit.jsonl` are renamed; `daemon.log`, which a running daemon keeps open, is copied to `daemon.log.old` and then truncated (copy-truncate; lines written in between are lost).

### Command line

```
node packages/mcp-server/dist/index.js [option]
```

| Option | Effect |
|---|---|
| (none) | stdio MCP relay — what Claude Code starts. Starts the shared daemon when none is running |
| `--daemon` | the shared daemon. Normally started automatically by a relay or by the Native Host |
| `--doctor` (or `doctor`) | check the installation and the running daemon |
| `--stop-daemon` [`--force`] | stop the running daemon gracefully |
| `-h`, `--help` | show the usage |
| `-v`, `--version` | print the version |

`--help` and `--version` print and exit before anything else happens: no daemon is started, no API token or log file is created. An unknown argument (or two modes together, or `--force` without `--stop-daemon`) exits with code 2.

`--doctor` prints one line per item — `OK`, `WARN`, `FAIL` or `SKIP` — with a fix for each problem, and exits with code 1 when an item FAILs (else 0). A missing `native-messaging` registration is a WARN: the extension route (Firefox) needs it, headless alone does not. The 14 items: `node`, `versions` (all packages and the extension manifest have the same version), `build` (`dist` newer than the sources), `native-messaging` (the Firefox registration and the manifest's name, type, allowed extension and path), `nm-wrapper` (the wrapper points to this checkout and its node exists), `claude` (the Claude Code registration, read from `~/.claude.json` — `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set — and `.mcp.json`), `powershell` (Windows: whether the Native Host can use it), `daemon` (`/health`: protocol, proof, version), `token`, `settings` (`FOX_*` here vs. the running daemon), `browsers` (connected Native Hosts), `safety-config` (`safety.json` parses and is valid), `screenshots` (`FOX_SCREENSHOTS_DIR`) and `logs` (sizes, Native Host start-up limit). It is read-only: it creates no token, starts no daemon, writes no log, and does not run `claude mcp get` (that would start the server to test it).

`--stop-daemon` asks the daemon to stop over a signed `POST /daemon/shutdown` (it needs `~/.inari-mcp/api_token`): running tool calls get up to 10 s to finish (`--force`: none), new tool calls are answered with HTTP 503 meanwhile, headless Firefox is closed, and the daemon exits. A daemon from an older version that predates `--stop-daemon` cannot be stopped this way: end its process by PID. `--stop-daemon` exits with code 0 when the daemon is gone (or none was running), else 1. Every Claude Code session loses the browser tools until its next call starts a daemon again, and a running Native Host (Firefox with the extension) starts one within about 20 s — quit Firefox first to keep it stopped.

`scripts/e2e/nm-probe.mjs [manifest.json]` starts the Native Messaging host the way Firefox does (from the installed manifest by default), sends `ping` and `status`, and checks that it reaches the daemon (exit code 0 = pass, 1 = fail, 2 = bad arguments). It starts a daemon if none is running.

### Headless mode

If you don't want to install the extension, set `FOX_HEADLESS=1` for the daemon and it drives a Playwright-managed Firefox instance directly instead of talking to your real browser. The relay passes its environment to the daemon it starts, so setting it for the relay (the command Claude Code runs) is enough when no daemon is running yet:

```bash
FOX_HEADLESS=1 node packages/mcp-server/dist/index.js
```

(or `claude mcp add --env FOX_HEADLESS=1 …`). `1`, `true` and `yes` (any case) turn it on; any other value leaves it off, and a value that is not a known "off" (`0`, `false`, `no`, `off`), such as `on`, makes the daemon log a warning. `FOX_HEADLESS_STARTUP_TIMEOUT` is the Firefox launch timeout in milliseconds (default `45000`). Without `playwright` installed, the daemon exits at start with `FOX_HEADLESS needs the optional dependency playwright, which is not installed (…)` in `daemon.log`; install it (`npm ci` without `--omit=optional`, or `npm install playwright` in `packages/mcp-server`, as the message says) and its Firefox (`npx playwright install firefox`). The settings only apply when this session is the one that starts the daemon (see [below](#whichever-side-starts-the-daemon-first-its-config-wins)).

Note this loses your real sessions/cookies/logged-in state — it's a disposable profile, same tradeoff as Playwright MCP. Many tools and parameters are not supported there (ignored parameters are listed in the result's `warnings`), and nobody can be asked in a browser popup, so protected-site actions can only be approved through MCP elicitation. Headless mode has no Firefox containers: with `container_scope.enabled` in `safety.json`, every browser command is refused; give the headless daemon its own `safety.json` with container scope off (`FOX_SAFETY_CONFIG`). Use the extension path if you want your actual logged-in Firefox.

### Update

```bash
git pull
npm ci
npm run build
npm run setup
```

Then install the new `.xpi` from [GitHub Releases](https://github.com/elys0912/InariMCP/releases/latest) (it replaces the old one in place; with a temporary add-on, reload it in `about:debugging` instead), restart Firefox and restart Claude Code. A daemon from the old version keeps running until it is stopped: when the new relay or Native Host reports that the running daemon "speaks protocol …" / "is from another version", stop that daemon process (and restart Firefox if the Native Host started it); a matching one starts on the next tool call. A daemon that predates `--stop-daemon` has to be ended by PID (`--doctor` prints the port to look for); a newer one can be stopped with `node packages/mcp-server/dist/index.js --stop-daemon`.

#### Notes on updating

- **`re:` URL patterns now match the whole URL**, in every list (they are anchored as `^(?:<regex>)$`; see [`safety.json`](#safetyjson)). An existing `re:` pattern written as a prefix, such as `re:^https://example\.com/`, no longer matches longer URLs: in `allowed_url_patterns` those URLs are now refused, and in `blocked_url_patterns` / `protected_url_patterns` they are no longer blocked or protected. No warning is logged for this. Append `.*` to keep the prefix meaning (`re:^https://example\.com/.*`). For example, the default `re:^https?://(?:[^/?#@]+\.)?mychart\.` that earlier development builds wrote to `protected_url_patterns` is now `re:https?://(?:[^/?#@]+\.)?mychart\..*`. Patterns without `re:` are not affected. Check the result with `fox_safety_status` after a daemon restart.

### Uninstall

```bash
npm run teardown
```

`npm run teardown` (`node scripts/uninstall.mjs`) removes things in an order that keeps them removed:

1. the Firefox Native Messaging registration (registry key / manifest files), so the extension cannot start the Native Host again,
2. `~/.inari-mcp/native-host/` (the wrapper),
3. the Claude Code registration, when you confirm or pass `--unregister-claude` (it only finds registrations visible from the repository directory — a `local`-scope registration made in another directory is listed, and has to be removed there),
4. running Native Host processes of this repository, then the daemon (after checking that the process on the port is a InariMCP daemon; over its signed `POST /daemon/shutdown` when the API token is present, else — or when that fails — SIGTERM, then SIGKILL after the grace period),
5. with `--purge`, the rest of `~/.inari-mcp/` (API token, `safety.json`, logs, screenshots); otherwise what is left is listed, not deleted.

Claude Code sessions that still run InariMCP start the daemon again on their next browser tool call; the uninstaller names them — restart them. The repository and the Firefox extension are not touched (remove the extension in Firefox). A Claude Code configuration file (`~/.claude.json`, `.mcp.json`) that cannot be read or parsed is reported as a problem (exit code 1), not as "not registered"; check with `claude mcp list`. A Firefox registration that points to another checkout's Native Host is reported with a warning and removed as well.

Options (after `--` with npm): `-n`/`--dry-run`, `-y`/`--yes` (also removes the Claude Code registration), `--unregister-claude`, `--keep-claude`, `--no-stop` (stop nothing), `--grace SECONDS` (0 to 60, default 5; anything else is a usage error), `--purge`, `--manual`, `-h`/`--help`. `--stop-daemon`, `--no-stop-daemon` and `--no-unregister-claude` are still accepted, and `npm run uninstall:windows` / `uninstall:unix` remain as aliases.

### Manual setup

Where the installer cannot run, set things up by hand. `node scripts/install.mjs --manual` and `node scripts/uninstall.mjs --manual` print the steps for every platform, and `--help` prints them for this machine with your paths filled in. On Windows, without the installer:

1. Build: `npm ci` and `npm run build` in the repository.
2. Create the folder `%USERPROFILE%\.inari-mcp\native-host`.
3. Create `%USERPROFILE%\.inari-mcp\native-host\run-host.cmd` (use full paths; write `%%` for a `%` in a path):

   ```bat
   @echo off
   cd /d "C:\path\to\InariMCP\packages\native-host"
   "C:\Program Files\nodejs\node.exe" "C:\path\to\InariMCP\packages\native-host\dist\index.js" %*
   ```

4. Copy `packages\native-host\inari_mcp.json` to `%USERPROFILE%\.inari-mcp\native-host\inari_mcp.json` and set `"path"` to the full path of `run-host.cmd` (JSON: write each `\` as `\\`).
5. Register it for Firefox (every edition reads this key):

   ```bat
   reg add "HKCU\Software\Mozilla\NativeMessagingHosts\inari_mcp" /ve /t REG_SZ /d "%USERPROFILE%\.inari-mcp\native-host\inari_mcp.json" /f
   ```

6. Optional, Claude Code: `claude mcp add --scope user inari-mcp -- "C:\Program Files\nodejs\node.exe" "C:\path\to\InariMCP\packages\mcp-server\dist\index.js"`

To uninstall by hand on Windows (order matters: while the host is registered and Firefox runs the extension, the Native Host starts the daemon again): `reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\inari_mcp" /f`; `rmdir /s /q "%USERPROFILE%\.inari-mcp\native-host"`; `claude mcp remove --scope user inari-mcp`; remove the extension in Firefox or quit Firefox; find the daemon with `netstat -ano | findstr :8765` and stop it with `taskkill /PID <pid> /F`; optionally `rmdir /s /q "%USERPROFILE%\.inari-mcp"`.

On Windows the Native Host starts the daemon outside Firefox's job object (otherwise closing Firefox kills the daemon and every Claude Code session using it). It tries PowerShell first, then WMI (`cscript`) and a one-off Task Scheduler task (`schtasks`); only if all of them fail is the daemon started inside the job, with a warning in `native-host.log`.

### Platform notes

- **Snap Firefox** (Ubuntu's default `firefox`) starts Native Messaging hosts through the xdg-desktop-portal WebExtensions portal, which may not work depending on the system. The installer writes the manifest to `~/.mozilla/native-messaging-hosts/` and into the snap. Where it does not work, install the deb from Mozilla's APT repository.
- **Flatpak Firefox** cannot run node from the host inside its sandbox. The installer writes the manifest into `~/.var/app/org.mozilla.firefox/`, but Firefox reaches the host only through the portal: set `widget.use-xdg-desktop-portal.native-messaging` to `1` in `about:config` (needs an xdg-desktop-portal with WebExtensions support). Without that, re-running the installer does not help, although the popup says "Setup needed"; a non-Flatpak Firefox is the reliable choice.
- **WSL**: run Claude Code and Firefox on the same side. With Claude Code inside WSL and Firefox on Windows, each side starts its own daemon with its own `~/.inari-mcp/` (and API token), so the WSL session never reaches the Windows Firefox. Either run Claude Code on Windows, or Firefox inside WSL (WSLg) with the installer run there. The installer warns when it runs inside WSL.
- **Several Firefox profiles** running at the same time all connect to the one daemon; commands go to the one that connected first, and nothing shows which one that is.

## Architecture

A monorepo of four TypeScript packages:

| Package | Role |
|---|---|
| `packages/shared` | Shared zod schemas, action names, and constants used by the other three packages. The subpath `@inari-mcp/shared/node` holds the helpers of the Node.js processes (paths, endpoint, API token, `/health`, logs, daemon start, version, HMAC authentication); the Extension bundles only the browser-safe part, without zod (see [Development](#development)). |
| `packages/mcp-server` | Two roles in one executable. By default it is a thin stdio relay: the process Claude Code starts, one per session, which lists the `fox_*` tools and forwards each call to the shared daemon. With `--daemon` it is that shared daemon: the single process that owns the HTTP/WebSocket ports, runs the safety guard, and dispatches commands to the Native Host over WebSocket (preferred) or to the headless Playwright backend (advanced). |
| `packages/native-host` | A Native Messaging bridge process between the daemon and the Firefox extension. Starts the daemon if none is running and restarts it only if its process is gone (a slow daemon is never killed). After 10 failed starts it stops trying until a usable daemon appears (for example one a Claude Code session started). |
| `packages/extension` | The Firefox WebExtension (Manifest V2) that actually clicks, types, and reads the DOM, and shows approval requests in its toolbar popup. Built with esbuild into three bundles (`dist/background.js`, `dist/content.js`, `dist/popup/popup.js`). |

Command flow: Claude Code → stdio relay → HTTP → shared daemon → safety guard → WebSocket → Native Host → Native Messaging → extension background script → content script → page DOM, and the result flows back the same way.

The `claude mcp add` command stays the same: the relay starts the daemon on first use (and the Native Host does the same when Firefox starts first), and the daemon exits by itself after 10 minutes unused (`FOX_DAEMON_IDLE_TIMEOUT`). Because every session gets its own relay and they all share one daemon, you can run several Claude Code sessions at the same time without port conflicts. They share the safety guard state too (rate limit, audit log, the last known URL of each tab).

The relay and the Native Host authenticate the daemon, and the daemon them, with HMAC challenge–response over the API token in `~/.inari-mcp/api_token` (the token itself never travels): a program that takes over the port cannot pose as the daemon. `GET /health` needs no authentication; with a nonce it adds a `proof`, and it reports the `protocol` version the relay and Native Host check. The relay asks for that proof before every tool call, approval answer and `--stop-daemon`, and sends the signed request (tool name, arguments, approval token; the approval request ID and the human's answer; the stop request) only when it is valid, so a program on the port does not receive them either. The `X-API-Key: <token>` header is still accepted by the HTTP API, for manual debugging only (such answers are not signed), except by `POST /daemon/shutdown`, which takes signed requests only. A `FOX_HOST` that is not a loopback address makes the daemon log a warning: the ports are then reachable from other machines.

## Configuration

### Environment variables

The names below are the ones the code reads. Where noted, the old `CLAUDE_BROWSER_*` name (inherited from the fork) still works as a fallback when the `FOX_*` one isn't set. The daemon takes an empty or blank `FOX_HEADLESS`, `FOX_HEADLESS_STARTUP_TIMEOUT`, `FOX_EXECUTABLE`, `FOX_SAFETY_CONFIG`, `FOX_SCREENSHOTS_DIR`, `FOX_READ_ONLY`, `FOX_ALLOW_SCRIPTS`, `FOX_APPROVAL_ELICITATION` or `FOX_DAEMON_IDLE_TIMEOUT` as not set (the legacy name where there is one, else the default, applies); the Native Host does the same with `FOX_SCREENSHOTS_DIR`, `FOX_SCREENSHOT_RETENTION_DAYS` and `FOX_NATIVE_HOST_LOG`.

| Variable | Default | Read by | Description |
|---|---|---|---|
| `FOX_HOST` | `127.0.0.1` | daemon, relay, Native Host, uninstaller | Address of the HTTP/WS server. A non-loopback value logs a warning. An empty or blank value counts as unset (the legacy name, then the default, applies). Legacy: `CLAUDE_BROWSER_HOST` |
| `FOX_HTTP_PORT` | `8765` | daemon, relay, Native Host, uninstaller | HTTP port (also the daemon's singleton lock). An empty or blank value counts as unset (the legacy name, then the default, applies). Legacy: `CLAUDE_BROWSER_HTTP_PORT` |
| `FOX_WS_PORT` | `8766` | daemon, Native Host | WebSocket port the Native Host connects to. An empty or blank value counts as unset (the legacy name, then the default, applies). Legacy: `CLAUDE_BROWSER_WS_PORT` |
| `FOX_CAPS` | unset (all tools) | relay | Tool profiles, comma-separated (see [below](#fox_caps-profiles)); `legacy` lists the earlier tool names instead (see [Tool name migration](#tool-name-migration)). **Not a safety boundary** — it only trims which tool schemas this session registers, to save context tokens. The daemon accepts every tool from every caller; actual restrictions (read-only, no scripts, URL limits, container scope) come from `safety.json` / the safety guard |
| `FOX_HEADLESS` | unset | daemon | `1` / `true` / `yes` uses the headless Playwright backend; anything else leaves it off (an unrecognised value such as `on` is logged as a warning). Legacy: `CLAUDE_BROWSER_HEADLESS` |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45000` | daemon | Launch timeout of the headless Firefox in **milliseconds** (not seconds). Legacy: `CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT` |
| `FOX_EXECUTABLE` | Playwright's Firefox | daemon (headless only) | Path to the Firefox binary Playwright launches. Legacy: `CLAUDE_BROWSER_EXECUTABLE` |
| `FOX_SCREENSHOTS_DIR` | `~/.inari-mcp/screenshots` | Native Host (extension path), daemon (headless path, `GET /screenshots`) | Where screenshots are saved; a relative path is taken from the working directory of the process. Legacy: `CLAUDE_BROWSER_SCREENSHOTS_DIR` |
| `FOX_SCREENSHOT_RETENTION_DAYS` | `30` | Native Host | At each Native Host start, screenshots it saved under a generated name and older than this many days are deleted (`0` keeps everything; a negative or non-numeric value means `30`). Files saved under a `filename` you chose, and headless screenshots, are never deleted |
| `FOX_READ_ONLY` | unset | daemon | `1` / `true` / `yes` forces read-only mode. Legacy: `CLAUDE_BROWSER_READ_ONLY` |
| `FOX_ALLOW_SCRIPTS` | unset | daemon | `0` / `false` / `no` / `off` disables the script tools (`fox_evaluate`, `fox_observer`; earlier names `fox_execute_script`, `fox_eval_chain`, `fox_wait_and_act`, `fox_inject_observer`, `fox_remove_observer`). Legacy: `CLAUDE_BROWSER_ALLOW_SCRIPTS` |
| `FOX_SAFETY_CONFIG` | `~/.inari-mcp/safety.json` | daemon | Alternate path of the safety policy file. Legacy: `CLAUDE_BROWSER_SAFETY_CONFIG` |
| `FOX_APPROVAL_ELICITATION` | on | relay, daemon | `0` / `false` / `off` / `no` turns approval through MCP elicitation off: protected-site actions are then always approved in the Firefox popup. The relay and the daemon each read their own environment: a relay with it off never asks through elicitation; a daemon with it off does not take elicitation answers, so a "yes" given there is asked again in the popup |
| `FOX_DAEMON_IDLE_TIMEOUT` | `600` | daemon | Seconds without a relay, a Native Host or a running call before the daemon exits (`0` = never) |
| `FOX_NATIVE_HOST_LOG` | `~/.inari-mcp/logs/native-host.log` | Native Host | Log file path; `0` / `off` / `false` / `no` / `none` disables file logging |

`FOX_PORT`, `FOX_DEBUG` and `FOX_CONTAINER` are defined in `packages/shared` but not read anywhere.

### `FOX_CAPS` profiles

| Profile | Tools |
|---|---|
| `core` | `fox_navigate`, `fox_click`, `fox_type`, `fox_press_key`, `fox_set_value`, `fox_screenshot`, `fox_snapshot`, `fox_read`, `fox_find`, `fox_tabs`, `fox_tab`, `fox_interact`, `fox_wait`, `fox_handle_dialog` |
| `logs` | `fox_logging`, `fox_get_logs` |
| `script` | `fox_evaluate`, `fox_observer` |
| `workflow` | `fox_evaluate` (its `wait_and_act` mode; the earlier `fox_run_workflow` and `fox_audit_page` were never implemented and are gone) |
| `human` | `fox_request_approval`, `fox_detect_captcha` |
| `container` | `fox_tabs`, `fox_tab` (containers are `fox_tabs` with `what: "containers"` and `fox_tab` with `action: "create"` and `container`) |
| `wait` | `fox_wait` |
| `all` | every tool (same as leaving `FOX_CAPS` unset) |

`fox_safety_status` is in no profile: it is always registered. Every other tool is in at least one profile. Unknown profile names are ignored with a warning on stderr; when every name given is unknown, only `fox_safety_status` is registered. `legacy` (alone, or with other profiles: `legacy,core`) registers the earlier tool names and their earlier profiles instead; see [Tool name migration](#tool-name-migration).

### Tool name migration

The 41 earlier tools were merged into 21: related operations became one tool with a mode argument. The browser side did not change; each call of a new tool runs exactly what the earlier tool ran.

- New sessions list the new names. With `FOX_CAPS=legacy` a session lists the earlier names instead (their descriptions start with `[Deprecated: …]`).
- The daemon accepts both: the earlier names keep working over HTTP (`POST /mcp/call`) whatever `FOX_CAPS` says.
- The first call of an earlier name in a daemon run adds a note naming the replacement to the result (and to `daemon.log`). The audit log records such a call under the new tool name with the earlier name as `legacyTool`.
- Human approval of a protected-site action is bound to the name and arguments of the call as made: retry with the same name and arguments.

| Earlier tool | New call | Argument changes |
|---|---|---|
| `fox_get_page_info` | `fox_read` `mode: "info"` | |
| `fox_get_text` | `fox_read` `mode: "text"` | |
| `fox_get_elements` | `fox_find` `by: "selector"` | |
| `fox_find_text` | `fox_find` `by: "text"` | `query` → `text` |
| `fox_get_tabs` | `fox_tabs` `what: "tabs"` | |
| `fox_list_containers` | `fox_tabs` `what: "containers"` | |
| `fox_create_tab` | `fox_tab` `action: "create"` | |
| `fox_open_in_container` | `fox_tab` `action: "create"` with `container` | `containerName` → `container.name`, `cookieStoreId` → `container.cookieStoreId`; `url` required |
| `fox_close_tab` | `fox_tab` `action: "close"` | |
| `fox_switch_tab` | `fox_tab` `action: "switch"` | |
| `fox_set_value` | `fox_set_value` (`kind: "input"`, the default) | |
| `fox_select_option` | `fox_set_value` `kind: "select"` | `value` / `text` / `index` → `option: { value }` / `{ text }` / `{ index }` (exactly one) |
| `fox_hover`, `fox_scroll`, `fox_highlight` | `fox_interact` `action: "hover"` / `"scroll"` / `"highlight"` | |
| `fox_wait_for_element`, `fox_wait_for_network_idle`, `fox_wait_for_navigation`, `fox_wait_for_url` | `fox_wait` `for: "element"` / `"network_idle"` / `"navigation"` / `"url"` | `for: "url"` needs `url` or `urlPattern` |
| `fox_start_logging`, `fox_stop_logging`, `fox_clear_logs` | `fox_logging` `action: "start"` / `"stop"` / `"clear"` | |
| `fox_get_console_logs`, `fox_get_network_logs` | `fox_get_logs` `kind: "console"` / `"network"` | |
| `fox_execute_script`, `fox_eval_chain`, `fox_wait_and_act` | `fox_evaluate` `mode: "script"` / `"chain"` / `"wait_and_act"` | `wait_and_act`: `timeoutMs` → `timeout` |
| `fox_inject_observer`, `fox_remove_observer` | `fox_observer` `action: "inject"` / `"remove"` | |
| `fox_run_workflow`, `fox_audit_page` | none | were not implemented on any backend; still callable by name, with the same error |

Unchanged: `fox_screenshot`, `fox_snapshot`, `fox_navigate`, `fox_click`, `fox_type`, `fox_press_key`, `fox_handle_dialog`, `fox_request_approval`, `fox_detect_captcha`, `fox_safety_status`.

### `safety.json`

Auto-generated on first run at `~/.inari-mcp/safety.json` (or `FOX_SAFETY_CONFIG`). A key left out of the file, or out of `container_scope`, takes its default; the camelCase spelling of a key (`readOnly`) is accepted too; a key not in this table (a typo such as `readonly`) makes the file unusable (see below):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Safety guard on |
| `read_only` | `false` | Refuse the tools that change page or browser state (input, navigation, tabs, scripts); observation, waiting, logging and UI-only tools (`fox_interact`, `fox_tab` with `action: "switch"`) still work |
| `allow_script_execution` | `true` | Allow the script tools. A script is not covered by the URL lists, protected-site approval or password masking: it can read password fields and send requests to other sites (see [Known issues](docs/known-issues.md)) |
| `confirm_protected_actions` | `true` | Ask a human before acting on (or screenshotting / logging) a protected site |
| `allow_password_typing` | `false` | Allow `fox_type` / `fox_set_value` on password fields (`type="password"`, or an `autocomplete` with the token `current-password` / `new-password` in any case, such as `section-login current-password`) |
| `max_actions_per_minute` | `120` | Rate limit, shared by all sessions (`0` = no limit) |
| `audit_log` | `true` | Write `~/.inari-mcp/logs/audit.jsonl` |
| `blocked_url_patterns` | `[]` | URLs to refuse |
| `allowed_url_patterns` | `[]` | When not empty, only these URLs are allowed |
| `protected_url_patterns` | banks, payment processors, `.gov`, … | Sites that need human approval |
| `container_scope` | `{ "enabled": false, "container_name": "InariMCP Agent" }` | Layer 0: restrict the agent to one Firefox container |

URL patterns are matched against the parsed URL, not the raw string, so `example.com.attacker.net` or a query string that mentions a host does not match:

| Pattern | Matches |
|---|---|
| `example.com` | the host and every subdomain |
| `*.example.com` | subdomains only |
| `example.com/admin` | ... whose path starts with `/admin` (`example.com/*` = any path) |
| `https://example.com` | ... over that scheme only |
| `example.com:8443` | ... on that port only (a URL without a port has its scheme's default: `example.com:443` matches `https://example.com/`) |
| `[::1]` | an IPv6 address, in brackets |
| `re:<regex>` | a case-insensitive regex over the normalised URL (`scheme://host[:port]/path?query#hash`, no user name or password) that must match the whole URL: it is always anchored as `^(?:<regex>)$`, so `re:example\.com` does not match `https://example.com.attacker.net/`; end it with `.*` for a prefix (`re:https://example\.com/.*`). In the blocked and protected lists it is also tried on the URL as written (not normalised), so that either form matching is enough |

Host and scheme compare case-insensitively. In `allowed_url_patterns` a path matches as written (at a segment boundary: `/admin` does not cover `/administrator`); in the blocked and protected lists it matches any continuation after decoding `%xx` escapes, collapsing repeated slashes and folding case. Regular expressions from earlier versions keep working where possible: simple ones (`paypal\.com`, `\.gov(/|$)`, `^https://a\.example/`) are read as the equivalent host pattern; any other one keeps its old meaning (anywhere in the URL) in the blocked and protected lists, with a warning, and is an error in the allowed list.

If `safety.json` cannot be used (unreadable, invalid JSON, an unknown key, a wrong type, an unusable URL pattern), the daemon logs the error to stderr (`daemon.log`) and refuses every tool except `fox_safety_status`, which shows the error, until the file is fixed and the daemon restarted. A URL pattern is unusable when it is empty, an invalid `re:` regex, a host pattern with an invalid port (1–65535) or IPv6 address, `*.` before an IP address, `*` in a path other than a trailing `/*`, `?` / `#` (or `%3F` / `%23`) in a path, an entry of `allowed_url_patterns` that is not a host pattern or `re:`, or an earlier-version regex that does not compile. A dot-less host pattern in the blocked or protected list (`paypal` matches only the host `paypal` and its subdomains) and an earlier-version regex kept as is are used with a warning, shown in `fox_safety_status` (`patternWarnings`). Navigation targets are checked as well: only `http://`, `https://` and `about:blank` are allowed, URLs with a user name or password before the host are refused, and a result whose final URL (after a redirect or a click) is blocked is withheld.

### Human approval for protected sites

When a tool would act on a URL matching `protected_url_patterns` (and `confirm_protected_actions` is on), the call is not run. The daemon opens a one-time approval request, and your Claude Code session asks you:

1. in Claude Code's own confirmation dialog (MCP elicitation), when the client supports it and `FOX_APPROVAL_ELICITATION` is not turned off;
2. otherwise in Firefox: the InariMCP toolbar button shows an amber count (plus an OS notification), and you approve or deny in its popup. The popup is also used when the elicitation request fails (the client does not know the method, a transport error); when the dialog times out, the call ends unapproved.

Tools that change page data need approval: input, navigation, tab changes, scripts. Of the tools that only read, three need it as well: `fox_screenshot` of a single tab (`scope: "all_tabs"` leaves protected tabs out instead), `scope: "scroll_capture"`, and `fox_logging` with `action: "start"` (recording pauses while a logging tab is on a protected site). Other reading tools (`fox_read`, `fox_find`, `fox_tabs`, …), `fox_wait`, and UI-only tools (`fox_interact`, `fox_tab` with `action: "switch"`) run on protected sites without approval. At most 32 approval requests can wait at a time.

An approval covers one call of that tool with exactly those arguments on that host, must be given before the request expires (120 s; the Firefox popup waits at most 60 s), and is carried by a one-time token that only the relay sees (the model never does). You are shown the arguments in full: invisible and text-direction characters (bidi controls, zero-width and tag characters, U+2028 / U+2029) appear as `\u` escapes under a warning line, and a call whose arguments do not fit (more than 160 in one value, or 800 for all the `name: value` lines; counted in UTF-16 code units with each value as JSON — quotes and escapes included, so a newline in a value counts 2 and an emoji 2) is not offered for approval at all — the model is told so. On a protected site this means long arguments cannot be approved: a long URL for `fox_navigate`, a multi-line script for `fox_evaluate`, or long text for `fox_type`. Text and scripts can sometimes be split into shorter calls; a URL cannot. Nothing in the page — buttons, `fox_click`, `fox_evaluate` — can approve it. One risk is accepted while elicitation approval is on: the answer reaches the daemon over local HTTP, so a local process that can read `~/.inari-mcp/api_token` could approve its own requests. Set `FOX_APPROVAL_ELICITATION=0` to require the Firefox popup (headless mode then cannot approve at all).

`fox_request_approval` is a separate, plain yes/no question to you in the same popup; its answer does not unlock protected sites.

### Whichever side starts the daemon first, its config wins

The daemon isn't started fresh per session — whoever gets there first (your Claude Code relay, or Firefox via the Native Host) starts it, and everyone else just talks to that one running daemon. That matters for env vars: `FOX_READ_ONLY`, `FOX_HEADLESS`, `FOX_ALLOW_SCRIPTS`, etc. are only read from the environment of whichever process actually launched the daemon. (`FOX_APPROVAL_ELICITATION` is read on both sides: each relay from its own environment, the daemon from the one it was started with; see [Environment variables](#environment-variables).) A daemon started by the Native Host gets Firefox's environment, not that of any Claude Code session. If Firefox starts the daemon first, a later Claude Code session's `FOX_READ_ONLY=1` in its MCP config does nothing — you'll see a warning (at session start and in `fox_safety_status`), but the existing daemon keeps running with its original settings.

`safety.json` doesn't have this problem: it's read from the same fixed path (`~/.inari-mcp/safety.json` by default) no matter which side starts the daemon. If you need `read_only` or similar to reliably take effect, set it in `safety.json` rather than relying on the env var.

## Status

This project is **under active, incremental development** — not ready for general use yet. It has moved past "source you can read and build": the installer and the AMO-signed extension on GitHub Releases let you drive your real Firefox end-to-end.

**Done:**
- Design and multi-angle review
- Monorepo scaffolding (P1)
- Safety guard, 8 layers (P2)
- MCP server core + all 41 tool schemas/handlers (P3)
- Headless Playwright backend (P4)
- Native messaging host (P5)
- Extension ported to TypeScript (P6)
- Firefox-native APIs: container tabs, `browser.find`, `tabs.captureTab` (P7)
- Extension path wired end-to-end, plus the relay + shared-daemon split so several Claude Code sessions can drive Firefox at the same time without fighting over ports (P7.5)
- Real-device E2E on Windows 11 + Firefox (2026-09-27)
- Installer — first as PowerShell / bash scripts, verified end-to-end on real Windows 11 hardware and on Linux (WSL2 Ubuntu 24.04 with the deb build of Firefox 156, 2026-09-28); since replaced by one Node.js installer and uninstaller for every platform (`scripts/install.mjs` / `scripts/uninstall.mjs`, `npm run setup` / `npm run teardown`) that needs no PowerShell. The macOS paths haven't been run on real macOS yet. `scripts/e2e/` has the smoke tests used for the Linux check
- Diagnostics (`--doctor`), `--help` / `--version`, and one version (0.1.4) for every package and the extension
- Distribution prep: the real Extension ID is confirmed (`inari-mcp@elys0912.github.io`), AMO's `data_collection_permissions` is set, and `web-ext lint` passes with 0 errors/warnings (P8)
- Human approval moved out of the page (toolbar popup / MCP elicitation, one-time approval tokens), and HMAC mutual authentication between the daemon, the relays and the Native Host
- AMO signing (unlisted) and distributing the signed `.xpi` via GitHub Releases (since 0.1.0)

**Not done yet:**
- Running the installer on real macOS
- Listing on the AMO store (not planned for now; the extension is distributed only through GitHub Releases)


### Tool availability

| Tools | Extension path | Headless |
|---|---|---|
| `fox_snapshot` | not implemented | returns the accessibility tree as YAML text |
| `fox_evaluate` `mode: "chain"` / `"wait_and_act"`, `fox_handle_dialog` | not implemented | work |
| `fox_observer` | works | works (one observer per page; `action: "remove"` returns only the number of changes) |
| `fox_logging`, `fox_get_logs` | work | not supported |
| `fox_navigate` with `action: "hard_refresh"`; `fox_screenshot` with `scope: "all_tabs"` or `"scroll_capture"` | work | not supported |
| `fox_tabs` `what: "containers"`, `fox_tab` `action: "create"` with `container` | work | not supported (no containers) |
| `fox_request_approval` | works | always refused (nobody to ask) |
| everything else | works | works, but many parameters are ignored (listed in the result's `warnings`; see [known issues](docs/known-issues.md)) |

A tool that is not implemented returns an error (`Not implemented in extension: …` / `Unsupported headless action: …`) rather than doing nothing silently.

Current limitations are listed in [`docs/known-issues.md`](docs/known-issues.md) ([日本語](docs/known-issues.ja.md)).

## Development

```bash
npm ci
npm run build             # every package; the Extension is bundled by scripts/build-extension.mjs
npm run typecheck         # type check of the Extension (tsc --noEmit), then of the tests (typecheck:tests)
npm test                  # Vitest, without e2e
npm run lint:ext          # web-ext lint of packages/extension
npm run e2e:extension     # the Extension loads into Firefox (needs Playwright's Firefox)
```

Build, packages and checks in detail: [`docs/development.md`](docs/development.md) ([日本語](docs/development.ja.md)).

`npm audit` reports 11 vulnerabilities, all in the dependency tree of `web-ext` (a devDependency); they are accepted. Audit with `npm audit --omit=dev` (0 vulnerabilities): the distributed parts (mcp-server, native-host, the extension `.xpi`) do not contain web-ext.

`npm test` runs the Vitest suites (unit tests per package, contract tests in `tests/contract/`, installer tests in `tests/scripts/`). Each test file gets a temporary home directory, so the tests never touch your `~/.inari-mcp/`. Development needs Node.js 22.12 or later (or 24), a requirement of Vitest, although running InariMCP only needs Node.js 18.

End-to-end checks, kept out of `npm test`:

| Command | What it checks |
|---|---|
| `npm run test:e2e` | relay → daemon → headless Firefox over MCP (`tests/e2e/`; needs `npx playwright install firefox`). Uses a temporary home directory and free ports, so a running daemon is not touched |
| `npm run e2e:extension` | the extension loads into Firefox as a temporary add-on (`scripts/e2e/extension-load.mjs`, `web-ext` with Playwright's Firefox; another Firefox with `FOX_E2E_FIREFOX` or a path argument, overall limit `FOX_E2E_TIMEOUT_MS`, default 60000) |
| `node scripts/e2e/tools-smoke.mjs` | daemon → Native Host → extension in your real Firefox (installer run, extension loaded; needs internet access) |
| `node scripts/e2e/nm-probe.mjs` | the installed Native Messaging host starts and reaches the daemon |

## Credits

Forked from [nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser), originally written in Python. This project ports it to TypeScript, narrows it to Firefox, and extends the safety model (container isolation, human approval outside the page with one-time tokens, HMAC mutual authentication between its processes). Thanks to the original author for doing the hard part first.

## License

MIT — see [LICENSE](./LICENSE).
