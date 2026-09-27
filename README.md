# KitsuneMCP

**English** | [日本語](./README.ja.md)

**Control your everyday Firefox from Claude Code.** A Firefox-only MCP addon — your real profile, your real logins, no throwaway browser.

> Status: **early WIP, not yet installable end-to-end.** See [Status](#status) below.

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

> These steps reflect what's implemented today (P1–P5). Extension packaging/install and end-to-end wiring are not finished yet — see [Status](#status).

### Prerequisites

- Node.js >= 18.0.0
- Firefox >= 78 (for `contextualIdentities` / `browser.find` / Manifest V2)
- (Headless mode only) Playwright: `npx playwright install firefox`

### Install

```bash
git clone <this-repo>
cd KitsuneMCP
npm install
npm run build
```

This builds all four workspace packages: `shared`, `mcp-server`, `native-host`, `extension`.

### Add to Claude Code

```bash
claude mcp add kitsune-mcp -- node <INSTALL_PATH>/packages/mcp-server/dist/index.js
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

See `docs/design.md` for the full design doc (architecture diagrams, protocol specs, the complete tool list, and the safety-layer breakdown).

## Configuration

### Environment variables

All prefixed `FOX_`; the old `CLAUDE_BROWSER_*` names (inherited from the fork) still work as a compatibility fallback when the `FOX_*` version isn't set.

| Variable | Default | Description |
|---|---|---|
| `FOX_HOST` | `127.0.0.1` | Bind address for the HTTP/WS server |
| `FOX_HTTP_PORT` | `8765` | HTTP server port |
| `FOX_WS_PORT` | `8766` | WebSocket server port |
| `FOX_CAPS` | (all tools) | Tool profile: `core`, `logs`, `script`, `workflow`, `human`, `container`, `wait` — comma-separated. **Not a safety boundary** — it only trims which tool schemas get registered to save context tokens. Actual restrictions (read-only, no scripts, URL limits, container scope) come from `safety.json` / the SafetyGuard below, and a client can always register a wider `FOX_CAPS` to reach any tool anyway |
| `FOX_HEADLESS` | `0` | `1` to enable the headless Playwright backend |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45` | Headless browser startup timeout (seconds) |
| `FOX_EXECUTABLE` | — | Explicit path to a Firefox binary |
| `FOX_SCREENSHOTS_DIR` | OS temp dir | Where screenshots are saved |
| `FOX_READ_ONLY` | — | `1` to force read-only mode |
| `FOX_ALLOW_SCRIPTS` | — | `0` to disable script-execution tools |
| `FOX_SAFETY_CONFIG` | `~/.kitsune-mcp/safety.json` | Alternate path for the safety policy file |

### `safety.json`

Auto-generated on first run at `~/.kitsune-mcp/safety.json` with sane defaults (safety guard on, scripts allowed, protected-domain confirmation on, password typing off, 120 actions/minute rate limit, a starter list of protected domains like banks and `.gov`). Edit it to add your own blocked/allowed URL patterns or to turn on container scoping. Full schema is documented in `docs/design.md` §9.1.

### Whichever side starts the daemon first, its config wins

The daemon isn't started fresh per session — whoever gets there first (your Claude Code relay, or Firefox via the native host) starts it, and everyone else just talks to that one running daemon. That matters for env vars: `FOX_READ_ONLY`, `FOX_HEADLESS`, `FOX_ALLOW_SCRIPTS`, etc. are only read from the environment of whichever process actually launched the daemon. If Firefox starts the daemon first, a later Claude Code session's `FOX_READ_ONLY=1` in its MCP config does nothing — you'll see a warning, but the existing daemon keeps running with its original settings.

`safety.json` doesn't have this problem: it's read from the same fixed path (`~/.kitsune-mcp/safety.json` by default) no matter which side starts the daemon. If you need `read_only` or similar to reliably take effect, set it in `safety.json` rather than relying on the env var.

## Status

This project is **under active, incremental development** — not ready for general use yet.

**Done:**
- Design doc + multi-angle review (`docs/design.md`)
- Monorepo scaffolding (P1)
- Safety guard, 8 layers (P2)
- MCP server core + all 41 tool schemas/handlers (P3)
- Headless Playwright backend (P4)
- Native messaging host (P5)

**Not done yet:**
- Extension bugfixes and KitsuneMCP rebranding (P6)
- Firefox-native container/`browser.find`/sidebar integration (P7)
- Installers, AMO packaging, and a real Extension ID (P8)

Until P6–P8 land, treat this as source you can read and build, not something to install and rely on. Track progress in `docs/design.md` and `docs/引き継ぎ.md`.

## Credits

Forked from [nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser), originally written in Python. This project ports it to TypeScript, narrows it to Firefox, and extends the safety model (container isolation, MCP elicitation instead of confirm tokens, timing-safe auth). Thanks to the original author for doing the hard part first.

## License

MIT — see [LICENSE](./LICENSE).
