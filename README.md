# KitsuneMCP

**English** | [日本語](./README.ja.md)

**Control your everyday Firefox from Claude Code.** A Firefox-only MCP addon — your real profile, your real logins, no throwaway browser.

> Status: **early WIP — the installer is in place (verified on real Windows and Linux hardware; macOS untested) and the extension path works end-to-end.** Signed-package distribution via AMO/GitHub Releases is still in progress. See [Status](#status) below.

![status](https://img.shields.io/badge/status-WIP-yellow) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D18-green)

---

## What is this?

KitsuneMCP is an MCP server + Firefox extension that lets Claude Code drive your actual Firefox browser — the one with your cookies, your sessions, your extensions already installed. Instead of spinning up a throwaway profile, it talks to your running Firefox through a WebExtension and a native messaging bridge, so it can click, type, screenshot, read console/network logs, and generally act like a very fast pair of hands on the tab you're already looking at.

It's a fork of [nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser) (MIT), ported from Python to TypeScript and narrowed to Firefox only.

## Why?

Chrome already has an official Claude browser extension. Firefox doesn't — not yet. KitsuneMCP exists to fill that gap until Anthropic (or Mozilla) ships something official. When that happens, this project's job is basically done.

## Not for you?

KitsuneMCP is deliberately narrow. If your use case is one of these, you'll be happier elsewhere:

- **Chrome/Edge user** → use the [official Claude browser extension](https://claude.com) or [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp).
- **CI / automated testing, cross-browser** → [Playwright MCP](https://github.com/microsoft/playwright-mcp). It supports Chromium/Firefox/WebKit and disposable profiles — the right tool for that job.
- **Large-scale scraping** → [browser-use](https://github.com/browser-use/browser-use) or [Browserbase](https://www.browserbase.com/) are built for that.
- **Debugging Firefox itself (DevTools protocol level)** → [mozilla/firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp) is the real deal for that.
- **CAPTCHA solving** → KitsuneMCP won't do this. It detects a CAPTCHA and hands control back to you — on purpose.

## Features

- **41 `fox_*` tools** covering navigation, click/type/scroll, screenshots (visible/full page/all tabs), tab management, console/network log capture, script execution and wait helpers. Prefixed `fox_` instead of `browser_` so it doesn't collide with Playwright MCP if you run both. Not all of them work on every backend yet: see [Tool availability](#tool-availability).
- **Tool profiles (`FOX_CAPS`)** — registering all 41 tools costs real context tokens. Pick profiles (`core`, `logs`, `script`, …) to only load what you need. See [`FOX_CAPS` profiles](#fox_caps-profiles).
- **8-layer safety guard (Layers 0–7)** — container scope (0), rate limit (1), URL scheme check and block/allow lists (2–3), read-only pass-through for observation tools (4), read-only mode (5), script-execution toggle (6) and human approval on protected domains such as banks, payment processors and `.gov` (7). Every decision is written to a JSONL audit log. The guard is always on; only container scoping (Layer 0) needs opt-in.
- **Human approval outside the page** — an action on a protected site is approved by you, either in Claude Code's own confirmation dialog (MCP elicitation) or in the KitsuneMCP toolbar popup in Firefox. Nothing inside the page can approve it. See [Human approval for protected sites](#human-approval-for-protected-sites).
- **Container isolation (opt-in)** — using Firefox's `contextualIdentities`, you can restrict the agent to a dedicated container so your banking/email sessions in other tabs stay invisible to it. This is a Firefox-only capability; Chromium has nothing equivalent.
- **Headless mode (advanced)** — a Playwright-driven, Firefox-only headless backend for when you don't want the extension path. Many tools and parameters are not supported there (see [Tool availability](#tool-availability)).
- **Firefox-native APIs** — `browser.find` for token-cheap in-page text search, `tabs.captureTab` for full-page and all-tabs screenshots (a visible-area screenshot of a background tab briefly activates that tab, then switches back).

## Quick Start

### Prerequisites

- Node.js >= 18.0.0 (to run KitsuneMCP; development needs more, see [Development](#development))
- Firefox 142 or later (`strict_min_version` of the extension). Developer Edition and Nightly read the same Native Messaging registration as the release build
- On Windows: PowerShell for the installer (without it, see [Windows without PowerShell](#windows-without-powershell))
- (Headless mode only) Playwright's Firefox: `npx playwright install firefox`

### Install

```bash
git clone https://github.com/elys0912/KitsuneMCP.git
cd KitsuneMCP
npm run install:windows   # macOS / Linux: npm run install:unix
```

`install:unix` is verified on Linux and untested on real macOS hardware (see [Status](#status)). On Linux, use Firefox from a distribution package (deb/rpm), Mozilla's APT repository or the tarball from mozilla.org: the Flatpak build cannot start Native Messaging hosts at all, and the Snap build (the default `firefox` on Ubuntu) may not either. See [Platform notes](#platform-notes).

The installer:

1. checks Node.js (>= 18) and npm, and looks for Firefox (warning only; on Windows, Developer Edition and Nightly are not detected, which is harmless),
2. runs `npm install` and `npm run build`,
3. writes the Native Messaging host wrapper (`run-host.cmd` / `run-host.sh`) to `~/.kitsune-mcp/native-host/` and registers the host manifest `kitsune_mcp.json` with Firefox (Windows: the manifest sits next to the wrapper and `HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp` points to it; Linux: written to `~/.mozilla/native-messaging-hosts/`; macOS: to `~/Library/Application Support/Mozilla/NativeMessagingHosts/`),
4. offers to register the MCP server with Claude Code (`claude mcp add`, see [Add to Claude Code](#add-to-claude-code)).

Options (pass them after `--` when going through npm, e.g. `npm run install:unix -- --skip-build`):

| `install.sh` | `install.ps1` | Effect |
|---|---|---|
| `--skip-build` | `-SkipBuild` | Skip `npm install` / `npm run build` (`dist/` must exist) |
| `--register-claude` | `-RegisterClaude` | Register with Claude Code without asking |
| `--no-register-claude` | `-NoRegisterClaude` | Don't register; print the command instead |
| `--claude-scope user\|local\|project` | `-ClaudeScope user\|local\|project` | Scope for `claude mcp add` (default `user`, i.e. every project) |
| `--help` | (`Get-Help scripts\install.ps1 -Detailed`) | Show the usage |

Direct invocations: `bash scripts/install.sh [options]` or `powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [options]`.

The `run-host.cmd` / `run-host.sh` files inside `packages/native-host/` are not used: the installer generates its own wrapper under `~/.kitsune-mcp/native-host/`.

**If you ever swap out or upgrade Node.js**, re-run the installer — the generated wrapper embeds the absolute path to the `node` binary that built it (it falls back to the `node` on Firefox's `PATH` when that binary is gone).

### Load the extension in Firefox

A signed, one-click-install `.xpi` isn't published yet (AMO signing + GitHub Releases distribution is still in progress). For now, load it as a temporary add-on:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. "Load Temporary Add-on..." → select `packages/extension/manifest.json`.
3. It's removed when Firefox restarts, so you'll need to load it again after each restart.

The KitsuneMCP button appears in the toolbar. Its popup shows the connection state (see [Check the connection](#restart-and-check-the-connection)).

### Add to Claude Code

The installer registers KitsuneMCP with Claude Code for you (`claude mcp add`, scope `user` by default — available from any project). It leaves an existing `kitsune-mcp` registration unchanged. If you skipped that step, or `claude` wasn't on your `PATH` at install time, register it manually:

```bash
claude mcp add --scope user kitsune-mcp -- node <INSTALL_PATH>/packages/mcp-server/dist/index.js
```

Environment variables for the server go before the name, e.g. `claude mcp add --scope user --env FOX_CAPS=core,logs kitsune-mcp -- node …` (but read [Whichever side starts the daemon first, its config wins](#whichever-side-starts-the-daemon-first-its-config-wins) before relying on them).

Or add it manually to your MCP config (`config/mcp_config.json` is the same template):

```json
{
  "mcpServers": {
    "kitsune-mcp": {
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
3. Look at the KitsuneMCP toolbar button:

| Badge / popup | Meaning | What to do |
|---|---|---|
| no badge, popup "Connected" / "Connected (N)" | Firefox and N Claude Code sessions are connected | nothing |
| red `!`, "No session" | Firefox is ready, but no Claude Code session uses KitsuneMCP | register it (the popup shows the command) and restart Claude Code; a running session appears within about 30 s |
| red `!`, "Setup needed" (native host missing) | Firefox cannot find the Native Messaging host | run the installer, then press Recheck (Flatpak Firefox: see [Platform notes](#platform-notes)) |
| red `!`, "Setup needed" (native host failed / MCP server not responding) | the host is registered but does not start, or the daemon does not answer | re-run the installer (usual cause: Node.js was upgraded or moved); check the logs below |
| red `!`, "Update needed" | the clone is older than the extension | `git pull`, re-run the installer, restart Firefox |
| amber number | approval requests waiting for you | open the popup and approve or deny |

4. Ask Claude Code to call `fox_safety_status`. It shows the active safety policy (read-only mode, script toggle, URL patterns, rate limit, audit log path) and warns when the running daemon was started with different settings than this session. It does not report whether a browser is connected.
5. For a low-level check, query the daemon:

```bash
curl -sS http://127.0.0.1:8765/health    # Windows PowerShell: curl.exe -sS … or Invoke-RestMethod …
```

`"status":"ok"` means the daemon runs; `browsers_connected` should be `1` once the extension is connected (a few seconds after loading it). If nothing answers ("Connection refused"), no daemon is running yet: it is started by the first Claude Code session or by Firefox with the extension loaded, and it exits after 10 minutes unused. Then look at the logs.

### Logs

All under `~/.kitsune-mcp/logs/`:

| File | Written by |
|---|---|
| `native-host.log` | the Native Host (override with `FOX_NATIVE_HOST_LOG`, `0`/`off` disables it) |
| `daemon.log` | the shared daemon's stderr |
| `audit.jsonl` | the safety guard's audit log (`audit_log` in `safety.json`) |

Each file is moved to `<name>.old` once it grows past 5 MB (one generation kept).

### Headless mode

If you don't want to install the extension, run the daemon with `FOX_HEADLESS` set and it drives a Playwright-managed Firefox instance directly instead of talking to your real browser:

```bash
FOX_HEADLESS=1 node packages/mcp-server/dist/index.js
```

(or `claude mcp add --env FOX_HEADLESS=1 …`). In the current version any non-empty value turns it on, `0` included. The setting only applies when this session is the one that starts the daemon (see [below](#whichever-side-starts-the-daemon-first-its-config-wins)).

Note this loses your real sessions/cookies/logged-in state — it's a disposable profile, same tradeoff as Playwright MCP. Many tools and parameters are not supported there, and nobody can be asked in a browser popup, so protected-site actions can only be approved through MCP elicitation. Use the extension path if you want your actual logged-in Firefox.

### Update

```bash
git pull
npm run install:windows   # or: npm run install:unix
```

Then reload the extension in `about:debugging` (or restart Firefox and load it again) and restart Claude Code. A daemon from the old version keeps running until it is stopped: when the new relay or Native Host reports that the running daemon "speaks protocol …" / "is from another version", stop that daemon process (and restart Firefox if the Native Host started it); a matching one starts on the next tool call.

### Uninstall

1. Remove the extension in Firefox (`about:debugging` → Remove), or close Firefox. Otherwise the Native Host still running there restarts the daemon within about 20 seconds and creates the API token and logs again.
2. Run the uninstaller:

```bash
npm run uninstall:windows   # or: npm run uninstall:unix
```

It stops a running daemon (after confirming that the process on the port is a KitsuneMCP daemon, and asking you), removes the Firefox registration and `~/.kitsune-mcp/native-host/`, and asks whether to remove the Claude Code registration (`claude mcp remove`; it only finds registrations visible from the repository directory — a `local`-scope registration made in another directory has to be removed there). What is left of `~/.kitsune-mcp/` (API token, `safety.json`, logs, screenshots) is listed, not deleted.

Options (after `--` with npm): `--purge`/`-Purge` also deletes the rest of `~/.kitsune-mcp/`; `--stop-daemon`/`-StopDaemon` and `--no-stop-daemon`/`-NoStopDaemon`; `--unregister-claude`/`-UnregisterClaude` and `--no-unregister-claude`/`-NoUnregisterClaude` answer the questions in advance. The repository itself is not touched.

### Windows without PowerShell

`npm run install:windows` / `uninstall:windows` need PowerShell. Where it is blocked, set things up by hand (from `cmd.exe`; replace `<REPO>` with the absolute path of your clone and `<NODE>` with the output of `where node`):

1. `npm install` and `npm run build` in `<REPO>`.
2. Create `%USERPROFILE%\.kitsune-mcp\native-host\run-host.cmd`:

   ```bat
   @echo off
   cd /d "<REPO>\packages\native-host"
   "<NODE>" "<REPO>\packages\native-host\dist\index.js" %*
   ```

3. Create `%USERPROFILE%\.kitsune-mcp\native-host\kitsune_mcp.json` (backslashes doubled; `packages/native-host/kitsune-mcp.json` is the same template):

   ```json
   {
     "name": "kitsune_mcp",
     "description": "KitsuneMCP Native Messaging Host",
     "path": "C:\\Users\\<you>\\.kitsune-mcp\\native-host\\run-host.cmd",
     "type": "stdio",
     "allowed_extensions": ["kitsune-mcp@elys0912.github.io"]
   }
   ```

4. Register it: `reg add "HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp" /ve /t REG_SZ /d "%USERPROFILE%\.kitsune-mcp\native-host\kitsune_mcp.json" /f`
5. `claude mcp add --scope user kitsune-mcp -- node "<REPO>\packages\mcp-server\dist\index.js"`

To uninstall by hand: remove the extension (or close Firefox), find the daemon with `netstat -ano | findstr :8765` and stop it with `taskkill /PID <pid>`, then `reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp" /f`, delete `%USERPROFILE%\.kitsune-mcp\native-host` (or all of `%USERPROFILE%\.kitsune-mcp`), and `claude mcp remove kitsune-mcp`.

The Native Host itself also uses PowerShell on Windows, to start the daemon outside Firefox's job object (otherwise closing Firefox kills the daemon and every Claude Code session using it). Without PowerShell it falls back to WMI (`cscript`) and then to a one-off Task Scheduler task (`schtasks`); only if all of them fail is the daemon started inside the job, with a warning in `native-host.log`.

### Platform notes

- **Flatpak Firefox** cannot start Native Messaging hosts outside its sandbox. The popup then says "Setup needed" and suggests running the installer, but re-running it does not help: use a non-Flatpak Firefox.
- **Snap Firefox** (Ubuntu's default `firefox`) may not start them either; the installer warns about it. Install the deb from Mozilla's APT repository.
- **WSL**: run Claude Code and Firefox on the same side. With Claude Code inside WSL and Firefox on Windows, each side starts its own daemon with its own `~/.kitsune-mcp/` (and API token), so the WSL session never reaches the Windows Firefox. Either run Claude Code on Windows, or Firefox inside WSL (WSLg) with `install:unix`.
- **Several Firefox profiles** running at the same time all connect to the one daemon; commands go to the one that connected first, and nothing shows which one that is.

## Architecture

A monorepo of four TypeScript packages:

| Package | Role |
|---|---|
| `packages/shared` | Shared zod schemas, action names, and constants used by the other three packages. |
| `packages/mcp-server` | Two roles in one executable. By default it is a thin stdio relay: the process Claude Code starts, one per session, which lists the `fox_*` tools and forwards each call to the shared daemon. With `--daemon` it is that shared daemon: the single process that owns the HTTP/WebSocket ports, runs the safety guard, and dispatches commands to the Native Host over WebSocket (preferred) or to the headless Playwright backend (advanced). |
| `packages/native-host` | A Native Messaging bridge process between the daemon and the Firefox extension. Starts the daemon if none is running and restarts it only if its process is gone (a slow daemon is never killed). |
| `packages/extension` | The Firefox WebExtension (Manifest V2) that actually clicks, types, and reads the DOM, and shows approval requests in its toolbar popup. |

Command flow: Claude Code → stdio relay → HTTP → shared daemon → safety guard → WebSocket → Native Host → Native Messaging → extension background script → content script → page DOM, and the result flows back the same way.

The `claude mcp add` command stays the same: the relay starts the daemon on first use (and the Native Host does the same when Firefox starts first), and the daemon exits by itself after 10 minutes unused (`FOX_DAEMON_IDLE_TIMEOUT`). Because every session gets its own relay and they all share one daemon, you can run several Claude Code sessions at the same time without port conflicts. They share the safety guard state too (rate limit, audit log, current URL).

The relay and the Native Host authenticate the daemon, and the daemon them, with HMAC challenge–response over the API token in `~/.kitsune-mcp/api_token` (the token itself never travels): a program that takes over the port cannot pose as the daemon. `GET /health` needs no authentication; with a nonce it adds a `proof`, and it reports the `protocol` version the relay and Native Host check. The `X-API-Key: <token>` header is still accepted by the HTTP API, for manual debugging only (such answers are not signed). A `FOX_HOST` that is not a loopback address makes the daemon log a warning: the ports are then reachable from other machines.

## Configuration

### Environment variables

The names below are the ones the code reads. Where noted, the old `CLAUDE_BROWSER_*` name (inherited from the fork) still works as a fallback when the `FOX_*` one isn't set.

| Variable | Default | Read by | Description |
|---|---|---|---|
| `FOX_HOST` | `127.0.0.1` | daemon, relay, Native Host | Address of the HTTP/WS server. A non-loopback value logs a warning. Legacy: `CLAUDE_BROWSER_HOST` |
| `FOX_HTTP_PORT` | `8765` | daemon, relay, Native Host, uninstaller | HTTP port (also the daemon's singleton lock). Legacy: `CLAUDE_BROWSER_HTTP_PORT` |
| `FOX_WS_PORT` | `8766` | daemon, Native Host | WebSocket port the Native Host connects to. Legacy: `CLAUDE_BROWSER_WS_PORT` |
| `FOX_CAPS` | unset (all tools) | relay | Tool profiles, comma-separated (see [below](#fox_caps-profiles)). **Not a safety boundary** — it only trims which tool schemas this session registers, to save context tokens. The daemon accepts every tool from every caller; actual restrictions (read-only, no scripts, URL limits, container scope) come from `safety.json` / the safety guard |
| `FOX_HEADLESS` | unset | daemon | Use the headless Playwright backend. Currently any non-empty value enables it, including `0` |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45000` | daemon | Meant as the headless browser startup timeout in **milliseconds** (not seconds); currently only logged and not applied to the browser launch |
| `FOX_EXECUTABLE` | Playwright's Firefox | daemon (headless only) | Path to the Firefox binary Playwright launches. Legacy: `CLAUDE_BROWSER_EXECUTABLE` |
| `FOX_SCREENSHOTS_DIR` | `~/.kitsune-mcp/screenshots` | Native Host (extension path), daemon (headless path, `GET /screenshots`) | Where screenshots are saved. Legacy: `CLAUDE_BROWSER_SCREENSHOTS_DIR` |
| `FOX_SCREENSHOT_RETENTION_DAYS` | `30` | Native Host | At each Native Host start, screenshots it saved under a generated name and older than this many days are deleted (`0` keeps everything). Files saved under a `filename` you chose, and headless screenshots, are never deleted |
| `FOX_READ_ONLY` | unset | daemon | Exactly `1` forces read-only mode. Legacy: `CLAUDE_BROWSER_READ_ONLY` |
| `FOX_ALLOW_SCRIPTS` | unset | daemon | Exactly `0` disables the script tools (`fox_execute_script`, `fox_eval_chain`, `fox_wait_and_act`, `fox_inject_observer`). Legacy: `CLAUDE_BROWSER_ALLOW_SCRIPTS` |
| `FOX_SAFETY_CONFIG` | `~/.kitsune-mcp/safety.json` | daemon | Alternate path of the safety policy file. Legacy: `CLAUDE_BROWSER_SAFETY_CONFIG` |
| `FOX_APPROVAL_ELICITATION` | on | relay, daemon | `0` / `false` / `off` / `no` turns approval through MCP elicitation off: protected-site actions are then always approved in the Firefox popup |
| `FOX_DAEMON_IDLE_TIMEOUT` | `600` | daemon | Seconds without a relay, a Native Host or a running call before the daemon exits (`0` = never) |
| `FOX_NATIVE_HOST_LOG` | `~/.kitsune-mcp/logs/native-host.log` | Native Host | Log file path; `0` / `off` / `false` / `no` / `none` disables file logging |

`FOX_PORT`, `FOX_DEBUG` and `FOX_CONTAINER` are defined in `packages/shared` but not read anywhere; `CLAUDE_BROWSER_HEADLESS` and `CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT` are not read either.

### `FOX_CAPS` profiles

| Profile | Tools |
|---|---|
| `core` | `fox_navigate`, `fox_click`, `fox_type`, `fox_press_key`, `fox_screenshot`, `fox_snapshot`, `fox_get_elements`, `fox_get_text`, `fox_find_text`, `fox_get_tabs`, `fox_create_tab`, `fox_close_tab`, `fox_switch_tab`, `fox_wait_for_element` |
| `logs` | `fox_start_logging`, `fox_stop_logging`, `fox_get_console_logs`, `fox_get_network_logs`, `fox_clear_logs` |
| `script` | `fox_execute_script`, `fox_eval_chain`, `fox_inject_observer`, `fox_remove_observer` |
| `workflow` | `fox_run_workflow`, `fox_audit_page`, `fox_wait_and_act` |
| `human` | `fox_request_approval`, `fox_detect_captcha` |
| `container` | `fox_list_containers`, `fox_open_in_container` |
| `wait` | `fox_wait_for_element`, `fox_wait_for_network_idle`, `fox_wait_for_navigation`, `fox_wait_for_url` |
| `all` | every tool (same as leaving `FOX_CAPS` unset) |

`fox_safety_status` is always registered. Seven tools belong to no profile and are only registered with `all` or without `FOX_CAPS`: `fox_get_page_info`, `fox_set_value`, `fox_select_option`, `fox_hover`, `fox_scroll`, `fox_highlight`, `fox_handle_dialog`. Unknown profile names are ignored with a warning on stderr.

### `safety.json`

Auto-generated on first run at `~/.kitsune-mcp/safety.json` (or `FOX_SAFETY_CONFIG`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Safety guard on |
| `read_only` | `false` | Refuse every tool that is not an observation tool |
| `allow_script_execution` | `true` | Allow the script tools |
| `confirm_protected_actions` | `true` | Ask a human before acting on (or screenshotting / logging) a protected site |
| `allow_password_typing` | `false` | Allow typing into password fields (see [known issues](docs/known-issues.md)) |
| `max_actions_per_minute` | `120` | Rate limit, shared by all sessions (`0` = no limit) |
| `audit_log` | `true` | Write `~/.kitsune-mcp/logs/audit.jsonl` |
| `blocked_url_patterns` | `[]` | URLs to refuse |
| `allowed_url_patterns` | `[]` | When not empty, only these URLs are allowed |
| `protected_url_patterns` | banks, payment processors, `.gov`, … | Sites that need human approval |
| `container_scope` | `{ "enabled": false, "container_name": "KitsuneMCP Agent" }` | Layer 0: restrict the agent to one Firefox container |

URL patterns are case-insensitive regular expressions, currently matched anywhere in the URL (not only against the host name), so anchor them yourself. If the file cannot be parsed, the daemon logs the error to stderr and runs with the defaults.

### Human approval for protected sites

When a tool would act on a URL matching `protected_url_patterns` (and `confirm_protected_actions` is on), the call is not run. The daemon opens a one-time approval request, and your Claude Code session asks you:

1. in Claude Code's own confirmation dialog (MCP elicitation), when the client supports it and `FOX_APPROVAL_ELICITATION` is not turned off;
2. otherwise in Firefox: the KitsuneMCP toolbar button shows an amber count (plus an OS notification), and you approve or deny in its popup.

An approval covers one call of that tool with exactly those arguments on that host, must be given before the request expires (120 s; the Firefox popup waits at most 60 s), and is carried by a one-time token that only the relay sees (the model never does). Nothing in the page — buttons, `fox_click`, `fox_execute_script` — can approve it. One risk is accepted while elicitation approval is on: the answer reaches the daemon over local HTTP, so a local process that can read `~/.kitsune-mcp/api_token` could approve its own requests. Set `FOX_APPROVAL_ELICITATION=0` to require the Firefox popup (headless mode then cannot approve at all).

`fox_request_approval` is a separate, plain yes/no question to you in the same popup; its answer does not unlock protected sites.

### Whichever side starts the daemon first, its config wins

The daemon isn't started fresh per session — whoever gets there first (your Claude Code relay, or Firefox via the Native Host) starts it, and everyone else just talks to that one running daemon. That matters for env vars: `FOX_READ_ONLY`, `FOX_HEADLESS`, `FOX_ALLOW_SCRIPTS`, `FOX_APPROVAL_ELICITATION`, etc. are only read from the environment of whichever process actually launched the daemon. A daemon started by the Native Host gets Firefox's environment, not that of any Claude Code session. If Firefox starts the daemon first, a later Claude Code session's `FOX_READ_ONLY=1` in its MCP config does nothing — you'll see a warning (at session start and in `fox_safety_status`), but the existing daemon keeps running with its original settings.

`safety.json` doesn't have this problem: it's read from the same fixed path (`~/.kitsune-mcp/safety.json` by default) no matter which side starts the daemon. If you need `read_only` or similar to reliably take effect, set it in `safety.json` rather than relying on the env var.

## Status

This project is **under active, incremental development** — not ready for general use yet. It has moved past "source you can read and build": you can now load the extension yourself (`about:debugging` temporary add-on) and drive your real Firefox end-to-end. What's missing is packaging it up so anyone can install it without doing that by hand.

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
- Installer (`scripts/install.ps1` / `scripts/uninstall.ps1` for Windows, `scripts/install.sh` / `scripts/uninstall.sh` for macOS/Linux) — verified end-to-end on real Windows 11 hardware and on Linux (WSL2 Ubuntu 24.04 with the deb build of Firefox 156, 2026-09-28); the macOS paths haven't been run on real macOS yet. `scripts/e2e/` has the smoke tests used for the Linux check
- Distribution prep: the real Extension ID is confirmed (`kitsune-mcp@elys0912.github.io`), AMO's `data_collection_permissions` is set, and `web-ext lint` passes with 0 errors/warnings (P8)
- Human approval moved out of the page (toolbar popup / MCP elicitation, one-time approval tokens), and HMAC mutual authentication between the daemon, the relays and the Native Host

**Not done yet:**
- AMO signing and distributing the signed package via GitHub Releases

Version numbers are not unified yet: the extension is 0.1.4, the npm packages (and the daemon's `/health`) report 0.1.0.

### Tool availability

| Tools | Extension path | Headless |
|---|---|---|
| `fox_run_workflow`, `fox_audit_page` | not implemented | not implemented |
| `fox_snapshot` | not implemented | returns a PNG screenshot (base64), not an accessibility tree |
| `fox_eval_chain`, `fox_wait_and_act`, `fox_inject_observer`, `fox_remove_observer`, `fox_handle_dialog` | not implemented | work |
| `fox_start_logging`, `fox_stop_logging`, `fox_get_console_logs`, `fox_get_network_logs`, `fox_clear_logs` | work | not supported |
| `fox_navigate` with `action: "hard_refresh"`; `fox_screenshot` with `scope: "all_tabs"` or `"scroll_capture"` | work | not supported |
| `fox_list_containers`, `fox_open_in_container` | work | not supported (no containers) |
| `fox_request_approval` | work | always refused (nobody to ask) |
| everything else | work | work, but many parameters are ignored (see [known issues](docs/known-issues.md)) |

A tool that is not implemented returns an error (`Not implemented in extension: …` / `Unsupported headless action: …`) rather than doing nothing silently.

Current limitations are listed in [`docs/known-issues.md`](docs/known-issues.md) ([日本語](docs/known-issues.ja.md)).

## Development

```bash
npm ci
npm run build
npm test
```

`npm test` runs the Vitest suites (unit tests per package and contract tests in `tests/contract/`). Vitest needs Node.js 22.12 or later (or 24), although running KitsuneMCP only needs Node.js 18.

## Credits

Forked from [nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser), originally written in Python. This project ports it to TypeScript, narrows it to Firefox, and extends the safety model (container isolation, human approval outside the page with one-time tokens, HMAC mutual authentication between its processes). Thanks to the original author for doing the hard part first.

## License

MIT — see [LICENSE](./LICENSE).
