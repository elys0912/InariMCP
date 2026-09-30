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

- **41 `fox_*` tools** covering navigation, click/type/scroll, screenshots (visible/fullpage/all-tabs), tab management, console/network log capture, script execution, structured page snapshots, and workflow helpers. Prefixed `fox_` instead of `browser_` so it doesn't collide with Playwright MCP if you run both.
- **Tool profiles (`FOX_CAPS`)** — registering all 41 tools costs real context tokens. Pick a profile (`core`, `logs`, `script`, `workflow`, `human`, …) to only load what you need.
- **8-layer safety guard** — rate limiting, URL scheme checks, block/allow lists, read-only mode, a script-execution toggle, protected-domain confirmation (banks, payment processors, `.gov`, etc. via MCP elicitation), and JSONL audit logging. Off by default doesn't mean unsafe by default — the guard runs regardless; only container scoping (Layer 0) needs opt-in.
- **Container isolation (opt-in)** — using Firefox's `contextualIdentities`, you can restrict the agent to a dedicated container so your banking/email sessions in other tabs stay invisible to it. This is a Firefox-only capability; Chromium has nothing equivalent.
- **Headless mode (advanced)** — a Playwright-driven, Firefox-only headless backend for when you don't want the extension path. Some features (human-approval banners, container tools) don't apply here.
- **Firefox-native APIs** — `browser.find` for token-cheap in-page text search, `tabs.captureTab` for screenshotting background tabs without stealing focus.

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Firefox >= 78 (for `contextualIdentities` / `browser.find` / Manifest V2)
- (Headless mode only) Playwright: `npx playwright install firefox`

### Install

```bash
git clone <this-repo>
cd KitsuneMCP
npm run install:windows
```

On macOS/Linux, use `npm run install:unix` instead (verified on Linux; untested on real macOS hardware — see [Status](#status)). On Linux, use Firefox from a distribution package or Mozilla's APT repository: the Flatpak build cannot start Native Messaging hosts, and the Snap build (the default `firefox` on Ubuntu) may not either. Either one runs `npm install` + `npm run build` for you, writes the Native Messaging host under `~/.kitsune-mcp/native-host/`, registers it with Firefox, and offers to register the MCP server with Claude Code. Equivalent direct invocations:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

```bash
bash scripts/install.sh
```

Run `-SkipBuild`/`--skip-build`, `-NoRegisterClaude`/`--no-register-claude`, or `-ClaudeScope`/`--claude-scope` (default `user`, i.e. available to every project) to adjust behavior; see the script's own `--help`/header comment for the full list.

**If you ever swap out or upgrade Node.js**, re-run the installer — the generated wrapper embeds the absolute path to the `node` binary that built it.

### Load the extension in Firefox

A signed, one-click-install `.xpi` isn't published yet (AMO signing + GitHub Releases distribution is still in progress). For now, load it as a temporary add-on:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. "Load Temporary Add-on..." → select `packages/extension/manifest.json`.
3. It's removed when Firefox restarts, so you'll need to load it again after each restart.

### Check the connection

```bash
curl -s http://127.0.0.1:8765/health
```

`browsers_connected` should be `1` once the extension has connected (takes a few seconds after loading it).

### Manual setup / detailed verification

### Uninstall

```bash
npm run uninstall:windows   # or: npm run uninstall:unix
```

This stops a running daemon (with confirmation), and removes the Firefox registration, the native-host files, and the Claude Code registration. Add `-Purge`/`--purge` to also delete the rest of `~/.kitsune-mcp/` (API token, `safety.json`, logs, screenshots).

### Logs

Native Host logs go to `~/.kitsune-mcp/logs/native-host.log` by default. Override the path with `FOX_NATIVE_HOST_LOG`, or set it to `0`/`off` to disable logging.

### Add to Claude Code

The installer registers KitsuneMCP with Claude Code for you (`claude mcp add`, scope `user` by default — available from any project). If you skipped that step, or `claude` wasn't on your `PATH` at install time, register it manually:

```bash
claude mcp add --scope user kitsune-mcp -- node <INSTALL_PATH>/packages/mcp-server/dist/index.js
```

Or add it manually to your MCP config (see `config/mcp_config.json` for a template):

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

### Headless mode

If you don't want to install the extension, set `FOX_HEADLESS=1` and the MCP server drives a Playwright-managed Firefox instance directly instead of talking to your real browser:

```bash
FOX_HEADLESS=1 node packages/mcp-server/dist/index.js
```

Note this loses your real sessions/cookies/logged-in state — it's a disposable profile, same tradeoff as Playwright MCP. Use the extension path if you want your actual logged-in Firefox.

Headless has no Firefox containers, so with `container_scope.enabled` every command is refused (fail-closed). For a headless daemon, point `FOX_SAFETY_CONFIG` at a separate `safety.json` with `container_scope.enabled: false`. Parameters the headless backend ignores are listed in the `warnings` of each result.

## Architecture

A monorepo of four TypeScript packages:

| Package | Role |
|---|---|
| `packages/shared` | Shared zod schemas, action names, and constants used by the other three packages. |
| `packages/mcp-server` | Two roles in one executable. By default it is a thin stdio relay: the process Claude Code starts, one per session, which lists the `fox_*` tools and forwards each call to the shared daemon. With `--daemon` it is that shared daemon: the single process that owns the HTTP/WebSocket ports, runs the safety guard, and dispatches commands to the Native Host over WebSocket (preferred) or to the headless Playwright backend (advanced). |
| `packages/native-host` | A Native Messaging bridge process between the daemon and the Firefox extension. Starts the daemon if none is running and restarts it only if its process is gone (a slow daemon is never killed). |
| `packages/extension` | The Firefox WebExtension (Manifest V2) that actually clicks, types, and reads the DOM. |

Command flow: Claude Code → stdio relay → HTTP → shared daemon → safety guard → WebSocket → Native Host → Native Messaging → extension background script → content script → page DOM, and the result flows back the same way.

The `claude mcp add` command stays the same: the relay starts the daemon on first use (and the Native Host does the same when Firefox starts first), and the daemon exits by itself after 10 minutes unused. Because every session gets its own relay and they all share one daemon, you can run several Claude Code sessions at the same time without port conflicts. They share the safety guard state too (rate limit, audit log, current URL).

## Configuration

### Environment variables

All prefixed `FOX_`; the old `CLAUDE_BROWSER_*` names (inherited from the fork) still work as a compatibility fallback when the `FOX_*` version isn't set.

| Variable | Default | Description |
|---|---|---|
| `FOX_HOST` | `127.0.0.1` | Bind address for the HTTP/WS server |
| `FOX_HTTP_PORT` | `8765` | HTTP server port |
| `FOX_WS_PORT` | `8766` | WebSocket server port |
| `FOX_CAPS` | (all tools) | Tool profile: `core`, `logs`, `script`, `workflow`, `human`, `container`, `wait` — comma-separated. **Not a safety boundary** — it only trims which tool schemas get registered to save context tokens. Actual restrictions (read-only, no scripts, URL limits, container scope) come from `safety.json` / the SafetyGuard below, and a client can always register a wider `FOX_CAPS` to reach any tool anyway |
| `FOX_HEADLESS` | `0` | `1`, `true` or `yes` to enable the headless Playwright backend (anything else, e.g. `0`, is off) |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45000` | Headless browser startup timeout (milliseconds) |
| `FOX_EXECUTABLE` | — | Explicit path to a Firefox binary |
| `FOX_SCREENSHOTS_DIR` | OS temp dir | Where screenshots are saved |
| `FOX_READ_ONLY` | — | `1` to force read-only mode |
| `FOX_ALLOW_SCRIPTS` | — | `0` to disable script-execution tools |
| `FOX_SAFETY_CONFIG` | `~/.kitsune-mcp/safety.json` | Alternate path for the safety policy file |

### `safety.json`

Auto-generated on first run at `~/.kitsune-mcp/safety.json` with sane defaults (safety guard on, scripts allowed, protected-domain confirmation on, password typing off, 120 actions/minute rate limit, a starter list of protected domains like banks and `.gov`). Edit it to add your own blocked/allowed URL patterns or to turn on container scoping.

### Whichever side starts the daemon first, its config wins

The daemon isn't started fresh per session — whoever gets there first (your Claude Code relay, or Firefox via the native host) starts it, and everyone else just talks to that one running daemon. That matters for env vars: `FOX_READ_ONLY`, `FOX_HEADLESS`, `FOX_ALLOW_SCRIPTS`, etc. are only read from the environment of whichever process actually launched the daemon. If Firefox starts the daemon first, a later Claude Code session's `FOX_READ_ONLY=1` in its MCP config does nothing — you'll see a warning, but the existing daemon keeps running with its original settings.

`safety.json` doesn't have this problem: it's read from the same fixed path (`~/.kitsune-mcp/safety.json` by default) no matter which side starts the daemon. If you need `read_only` or similar to reliably take effect, set it in `safety.json` rather than relying on the env var.

## Status

This project is **under active, incremental development** — not ready for general use yet. It has moved past "source you can read and build": you can now load the extension yourself (`about:debugging` temporary add-on) and drive your real Firefox end-to-end. What's missing is packaging it up so anyone can install it without doing that by hand.

**Done:**
- Design doc + multi-angle review
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

**Not done yet:**
- AMO signing and distributing the signed package via GitHub Releases

Of the 41 registered `fox_*` tools, 8 aren't implemented on the extension path yet (`fox_snapshot`, `fox_run_workflow`, `fox_audit_page`, `fox_inject_observer`, `fox_remove_observer`, `fox_handle_dialog`, `fox_eval_chain`, `fox_wait_and_act`) — calling one returns a clear "not implemented" error rather than doing nothing silently; some of these already work under headless mode.

Current limitations are listed in [`docs/known-issues.md`](docs/known-issues.md) (in Japanese).

## Credits

Forked from [nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser), originally written in Python. This project ports it to TypeScript, narrows it to Firefox, and extends the safety model (container isolation, MCP elicitation instead of confirm tokens, timing-safe auth). Thanks to the original author for doing the hard part first.

## License

MIT — see [LICENSE](./LICENSE).
