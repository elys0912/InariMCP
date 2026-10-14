# Smoke test for add-on reviewers

How to check the basic features of Inari MCP for Firefox without Claude Code, without any account and without internet access during the test. A script acts as the MCP client and drives Firefox through the add-on against a local test page served on 127.0.0.1.

What it checks, in order:

| Step | Tool | Expected |
|---|---|---|
| 1 | `fox_tabs` | the tabs are listed |
| 2 | `fox_tab` (create) | a new tab opens the local test page |
| 3 | `fox_read` | the page is read; the password field and the hidden field are reported as `[MASKED]`, and their values appear nowhere in the answer |
| 4 | `fox_find` | the heading text is found |
| 5 | `fox_screenshot` | a PNG file is written |
| 6 | `fox_click` | you approve the click in the add-on's toolbar popup; the tab then moves to page 2 |
| 7 | `fox_tab` (close) | the test tab is closed |

The script never approves anything by itself and has no option to skip the approval.

## Requirements

- Node.js 20 or later, with npm
- Firefox 142 or later. On Linux, use a Firefox from a deb/rpm package, Mozilla's APT repository or the tarball from mozilla.org: the Snap and Flatpak builds start native messaging hosts through the desktop portal, which may not work (see "Platform notes" in the README).
- The source code of this repository (the source archive or a clone)

`npm ci` downloads the dependencies from the npm registry. After that, nothing in these steps uses the network: the test page is served by the script itself on 127.0.0.1.

## Steps

Run the commands from the repository root.

### 1. Install the dependencies and build

```bash
npm ci
npm run build
```

### 2. Register the native messaging host

```bash
npm run setup
```

The add-on talks to a native messaging host on this computer; Firefox only starts a host that is registered. `npm run setup` (`scripts/install.mjs`) writes:

- `~/.inari-mcp/native-host/run-host.cmd` (Windows) or `run-host.sh` (macOS, Linux): a wrapper that starts the host with the absolute path of this Node.js and this checkout
- the host manifest `inari_mcp.json` (name `inari_mcp`, allowed extension `inari-mcp@elys0912.github.io`, path of the wrapper) where Firefox reads it:
  - Windows: `~/.inari-mcp/native-host/inari_mcp.json`, and the registry key `HKCU\Software\Mozilla\NativeMessagingHosts\inari_mcp` pointing to it
  - macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/inari_mcp.json`
  - Linux: `~/.mozilla/native-messaging-hosts/inari_mcp.json`, plus the XDG, Snap and Flatpak locations when those builds seem to be present

It also prints a `claude mcp add` command for Claude Code. You do not need it for this test; nothing is registered with Claude Code unless `--register-claude` is given.

When the add-on connects, the host starts a local daemon (HTTP and WebSocket on 127.0.0.1, ports 8765 and 8766). The daemon creates `~/.inari-mcp/api_token` (the key its processes authenticate each other with), `~/.inari-mcp/safety.json`, `~/.inari-mcp/logs/` and `~/.inari-mcp/screenshots/`.

### 3. Install the add-on

Either:

- the `.xpi` under review: in Firefox, open `about:addons`, click the gear icon, choose "Install Add-on From File..." and select it, or
- a temporary add-on built from this source: `npx web-ext run` (from the repository root; `web-ext-config.mjs` points it at `packages/extension`). Add `--firefox=<path to firefox>` when web-ext does not find Firefox.

Both have the add-on ID `inari-mcp@elys0912.github.io`, the one the host manifest allows.

### 4. Allow the connection

On first start the add-on opens its permission page ("Allow Inari MCP for Firefox to connect?"). It explains what the add-on sends and where. Press "Allow". Until you do, the add-on does not connect to the native host. If you closed the page, open it again from the toolbar button.

The toolbar popup should now show the add-on as connected (a red `!` with "No session" only means that no MCP client is connected yet). The pause switch in the popup must be off.

### 5. Run the smoke test

Keep Firefox open and run:

```bash
npm run smoke:reviewer
```

The script waits up to 30 s for Firefox with the add-on to connect to the daemon, then serves the test page and calls the tools one by one, printing a line per check.

### 6. Approve the click

Before `fox_click`, the script prints:

```
      fox_click is an action on the page: Inari MCP for Firefox asks you before it runs.
      Click the InariMCP button in the Firefox toolbar (it shows a badge) and press "Approve".
      Waiting for your answer (the popup gives you 60 s). This script never approves by itself.
```

The toolbar button shows an amber number (the approval requests waiting for you). Open the popup: it shows the tool, the site (`127.0.0.1`) and the arguments. Press "Approve". The click runs once, and the tab moves to page 2. Pressing "Deny", or not answering within 60 s, makes the click check FAIL (that is the expected behaviour of the add-on, not a defect of the test).

If Firefox asks for approval of another step (opening or closing the test tab), approve it the same way; the script prints a reminder before those steps.

### 7. Read the result

At the end the script prints a table and a summary line. Each check is `PASS`, `FAIL` or `SKIP`. The exit code is 0 when no check failed and 1 otherwise. When a check fails, the last lines of the MCP server's log follow the table.

### 8. Remove everything

```bash
npm run teardown -- --purge
```

`npm run teardown` (`scripts/uninstall.mjs`) removes the native messaging registration (registry key or manifest files), `~/.inari-mcp/native-host/`, and stops the native host and the daemon. With `--purge` it also deletes the rest of `~/.inari-mcp/` (API token, `safety.json`, logs, screenshots); without it, what is left is listed. Remove the add-on itself in `about:addons` (a temporary add-on goes away when web-ext's Firefox is closed). The repository is not touched.

## Expected output

With the add-on (the port and the paths differ):

```
mode: Firefox with the add-on
Waiting up to 30 s for Firefox with the add-on to connect ...
test page: http://127.0.0.1:50123/index.html

PASS  fox_tabs: list the tabs  — tabs=1
PASS  fox_tab create: open the local test page  — http://127.0.0.1:50123/index.html
PASS  fox_read: page 1 is loaded  — title: InariMCP reviewer smoke: page 1
PASS  fox_read: password field is [MASKED]  — values: ["[MASKED]"]
PASS  fox_read: hidden field is [MASKED]  — values: ["[MASKED]"]
PASS  fox_find: find the heading text  — count=1
PASS  fox_screenshot: a PNG file is written  — <home>/.inari-mcp/screenshots/screenshot_1760425312345.png

      fox_click is an action on the page: Inari MCP for Firefox asks you before it runs.
      Click the InariMCP button in the Firefox toolbar (it shows a badge) and press "Approve".
      Waiting for your answer (the popup gives you 60 s). This script never approves by itself.
PASS  fox_click: click "Go to page 2" (after your approval)  — #to-page-2
PASS  fox_click: the tab moved to page 2  — http://127.0.0.1:50123/page2.html
PASS  fox_tab close: close the test tab  — tabId=12

#   Check                                                    Tool            Result  Detail
--  -------------------------------------------------------  --------------  ------  ------------------------------
1   fox_tabs: list the tabs                                  fox_tabs        PASS    tabs=1
...
10  fox_tab close: close the test tab                        fox_tab         PASS    tabId=12

10 PASS, 0 FAIL, 0 SKIP
```

## Without the add-on (headless)

```bash
npx playwright install firefox     # once; downloads Playwright's Firefox
npm run smoke:reviewer -- --headless
```

The daemon drives Playwright's headless Firefox instead of the add-on, so this checks the MCP server alone; it needs neither the add-on nor `npm run setup`. It runs on free ports (a running daemon is not touched) and stops its daemon at the end. Headless mode has no popup in which a human could approve, so a step that needs approval is reported as `SKIP`, and `fox_read` returns only the URL and the title there, so the two `[MASKED]` checks are `SKIP` as well.

## When it does not work

- "No Firefox with the add-on is connected": check that Firefox runs with the add-on, that "Allow" was pressed on the permission page and that the popup is not paused. The popup's status and its badge tell what is missing ("Setup needed" means Firefox cannot find or start the native host: run `npm run setup` again).
- Run the diagnostics: `node packages/mcp-server/dist/index.js --doctor`. It prints one line per item (`OK`, `WARN`, `FAIL`, `SKIP`) with a fix for each problem: the build, the native messaging registration, the daemon, the connected browsers, the logs. It changes nothing.
- Check the native messaging host alone (no Firefox needed): `node scripts/e2e/nm-probe.mjs`. It starts the registered host as Firefox would and checks that it reaches the daemon.
- Logs: `~/.inari-mcp/logs/native-host.log` (the native host) and `~/.inari-mcp/logs/daemon.log` (the daemon).
- "not found: run npm run build first": run `npm run build`.
- On Linux with the Snap or Flatpak Firefox, the native host may not start (see Requirements).
