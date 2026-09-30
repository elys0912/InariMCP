# Known issues and caveats

**English** | [日本語](./known-issues.ja.md)

Limitations and caveats known in the current version of KitsuneMCP (v0.1.x).

## Safety guard

- **Protected-domain confirmation can be asked for on a tab that is not protected**: acting tools without a `url` argument (`fox_click`, `fox_type`, …) are checked by the Extension against the real URL of the target tab, so an action on another tab or from another session cannot slip through. The shared daemon, however, runs the same check against the "last URL seen", which all sessions share. Right after a refusal on a protected site, an action on a different, unprotected tab can therefore be asked for confirmation too. Running a tool such as `fox_get_text` once on the target tab clears it (the server-side check stays as a safeguard for older Extensions). In headless mode only the server-side check applies
- **URL patterns match anywhere in the URL**: `blocked_url_patterns` / `allowed_url_patterns` / `protected_url_patterns` in `safety.json` are case-insensitive regular expressions that match if they occur anywhere in the whole URL, not only in the host name. `example\.com` also matches `https://example.com.attacker.net/` and `https://attacker.net/?q=example.com`. Anchor allow-list entries, e.g. `^https://example\.com/`
- **`allow_password_typing: true` does not allow typing into password fields on the extension path**: the setting never reaches the Extension, which always refuses `fox_type` / `fox_set_value` on a password field (`type="password"`, or `autocomplete` `current-password` / `new-password`). The server-side check only looks for `type=password` in the `selector` string
- **A broken `safety.json` falls back to the defaults**: when the file is not valid JSON or a value has the wrong type, the daemon logs the error to stderr (`daemon.log`) and runs with the defaults (guard on, protected-domain confirmation on, scripts allowed, no allow/block lists). Check the result with `fox_safety_status` after editing it
- **Read-only mode also refuses `fox_switch_tab` and `fox_detect_captcha`**: the list of observation tools that read-only mode lets through has them under old names (`fox_focus_tab`, `fox_solve_captcha`)
- **The shared daemon uses the environment of whoever started it**: environment variables such as `FOX_READ_ONLY` are read only from the process that actually launched the daemon. A daemon started by Firefox (the Native Host) inherits Firefox's environment; `claude mcp add --env` values are not used. Put settings that must apply in `~/.kitsune-mcp/safety.json` (see the README). When a session and the daemon disagree, a warning appears at session start and in the `fox_safety_status` result

## Human approval

- **A local process can approve its own requests through MCP elicitation**: approval for a protected-site action is asked in Claude Code's confirmation dialog (MCP elicitation) when available, otherwise in the Firefox toolbar popup. The elicitation answer reaches the daemon over local HTTP, so a process that can read `~/.kitsune-mcp/api_token` can approve its own request (an accepted risk). Set `FOX_APPROVAL_ELICITATION=0` to allow approvals in the popup only
- **Headless mode may be unable to approve**: headless has no popup to ask in. When the client does not support elicitation, or `FOX_APPROVAL_ELICITATION=0` is set, protected-site actions cannot be approved and are refused. `fox_request_approval` always fails in headless mode
- **Withdrawing a CAPTCHA banner is not guaranteed**: approvals moved out of the page (to the popup), but the CAPTCHA banner of `fox_detect_captcha` is still shown in the page. The banner closes on its own timer, before the server gives up. If the server times out first (e.g. a delayed message), it tells the Extension to withdraw the banner; if that message does not arrive either, the banner can stay. Clicking a leftover banner does nothing: the server discards the answer (Claude has already received the timeout error)

## Tools

- **Some tools are not implemented**: on the extension path, `fox_snapshot`, `fox_run_workflow`, `fox_audit_page`, `fox_inject_observer`, `fox_remove_observer`, `fox_handle_dialog`, `fox_eval_chain` and `fox_wait_and_act` return `Not implemented in extension: <name>`. `fox_run_workflow` and `fox_audit_page` are not implemented in headless mode either. Headless `fox_snapshot` returns a PNG screenshot (base64), not an accessibility tree. See "Tool availability" in the README
- **On pages with iframes, a result can come from another frame**: DOM tools on the extension path (`fox_click`, `fox_type`, `fox_get_elements`, `fox_get_text`, …) are sent to the content scripts of every frame in the tab, and the first frame to answer (an error included) wins. Logging and `fox_wait_for_network_idle` go to the top frame only
- **Target `fox_type` with `selector`**: the string to type (`text`) is also used as a locator, tried before `placeholder` / `name` / `id`. Without `selector`, a `placeholder` (etc.) can end up picking another element that contains the text being typed
- **`fox_type`'s Enter does not really submit**: `pressEnter` sends synthetic Enter key events and a `submit` event to the enclosing form; the browser's own form submission does not happen. Click the submit button with `fox_click`. `delay: 0` counts as the default 50 ms; typing waits per character, so with the default about 600 characters exceed the 30 s command timeout. Use `fox_set_value` for long values
- **Clicks, typing, keys and hover are synthetic events**: `fox_click`, `fox_type`, `fox_press_key` and `fox_hover` dispatch DOM events in the page (`isTrusted` is `false`). Pages that require real user input (opening pop-ups, clipboard access, some frameworks) may ignore them
- **`fox_click`'s `text` only looks at an element's own text**: text inside child elements (the "Send" in `<button><span>Send</span></button>`) is not found. Only the first match is used, and shadow DOM is not searched
- **`fox_wait_for_navigation` only waits for navigations that start after the call**: a navigation that already finished (after a click, say) does not count, so fast navigations time out. When the destination is known, use `fox_wait_for_url` (it returns at once if the URL already matches)
- **`fox_wait_for_network_idle` reports success on timeout**: check `idle: false` / `timedOut: true` in the result. Only the page's own fetch / XHR calls are counted, and requests already running before the wait started are not seen
- **Some `fox_screenshot` arguments have no effect**: on the extension path the image is always saved to a file (`saveToFile: false` and `includeData` are ignored); the result carries the file path and a link, never base64. Saving under the same `filename` overwrites the file. `scope: "viewport"` with a background tab briefly brings that tab to the front, captures it and switches back. `scope: "scroll_capture"` takes no images: it returns element information per scroll position (the `browser_screenshot` its result mentions does not exist; use `fox_screenshot`)
- **`fox_select_option` and `fox_set_value` report success even when nothing matched**: check `value` / `text` in the `fox_select_option` result for what was actually selected. `fox_set_value` succeeds without changing anything on elements that are not an input, a select or contenteditable
- **Some tool annotations do not match the behavior**: `fox_hover`, `fox_scroll`, `fox_highlight` and `fox_switch_tab` change the page or tab state but are registered with `readOnlyHint: true`
- **While a native dialog (alert / confirm / prompt) is open, commands to that tab time out**: the extension path cannot see or handle the dialog
- **Headless `fox_handle_dialog` cannot be combined with a click**: headless commands run one at a time, so while `fox_handle_dialog` waits, a `fox_click` queues behind it. It only catches dialogs the page opens by itself (e.g. from a timer)
- **Pages that content scripts cannot enter do not support the reading and acting tools**: Firefox's JSON viewer, `about:` pages, addons.mozilla.org, etc. Tools that only use the tabs API, such as `fox_screenshot` and `fox_get_tabs`, still work
- **`fox_execute_script` runs in the content script's isolated world**:
  - it sees the page's DOM, but not the variables and functions the page's own scripts define (`window.myApp`, …)
  - `console.log` inside the script is not logged. Return the result instead (a JSON-compatible value)
  - `fetch` / XHR called from the script is neither logged nor counted by `fox_wait_for_network_idle`. To observe the page's own traffic, `fox_click` a button in the page
  - `script` is evaluated as a script and the value of its last expression is returned. A top-level `return` is not allowed (wrap it: `(() => { ...; return x; })()`)
  - it runs in the top frame only
  - in headless mode it runs in the page's own world through Playwright's `page.evaluate`, so the points above do not apply there

## Headless mode

- **`FOX_HEADLESS=0` still enables headless mode**: any non-empty value turns it on. Leave the variable unset to disable it
- **`FOX_HEADLESS_STARTUP_TIMEOUT` has no effect**: the value is read as milliseconds but only logged, not passed to the Firefox launch
- **Some tools are not supported**: the 5 logging tools, `fox_navigate`'s `hard_refresh`, `fox_screenshot`'s `all_tabs` / `scroll_capture`, the 2 container tools, `fox_run_workflow` and `fox_audit_page`. `fox_request_approval` always fails
- **Many arguments are ignored**:
  - `fox_navigate`: `waitForLoad`, `bypassCache` (`refresh` is a normal reload)
  - `fox_click`: only `selector` or `x` + `y` (no `xpath`, `text`, `doubleClick`, `rightClick`)
  - `fox_type`: only `selector` and `text` (with `selector` the existing content is replaced, without it the focused element receives the text; `clear`, `pressEnter`, `delay`, `placeholder`, `name`, `id` are ignored)
  - `fox_scroll`: `direction`, `amount`, `selector`, `toElement` are ignored; it always scrolls down 300 px
  - `fox_screenshot`: only `fullPage` (`scope: "full_page"`) and `filename`
  - `fox_get_page_info`: returns the URL and title only
  - `fox_get_elements`: `limit` is ignored (at most 50, tag / text / position only)
  - `fox_find_text`: returns the count only (`caseSensitive`, `entireWord`, `includeRectData` ignored)
  - `fox_get_tabs`: all arguments ignored
  - `fox_highlight`: `duration`, `label` ignored (red outline for 2 s)
  - `fox_wait_for_element`: `visible: false` is ignored (waits until visible)
  - `fox_wait_for_network_idle`: `idleTime` ignored
  - `fox_wait_for_navigation`: `waitUntil`, `urlPattern` ignored
  - `fox_snapshot`: `selector`, `maxDepth`, `includeText`, `roles` ignored
  - `fox_inject_observer` / `fox_remove_observer`: `observerId` is ignored (one observer only). Changes collect in `window.__fox_mutations`; `fox_remove_observer` returns only their count

## Log capture

- **Logs from inline scripts right at page load can be missed**: on a tab with logging on, the content script is injected again early (`document_start`) after every navigation, but that is asynchronous, so `console.log` from inline `<script>` in `<head>` / `<body>` is not recorded if the injection is late. Logs from code that runs later (`setTimeout`, etc.) are captured (hooking every page all the time would catch them reliably, but is not done for privacy reasons)
- **Logs inside iframes are not collected**: the top frame only
- **Navigating away discards the previous page's logs**: logs are kept in the page's content script, so a navigation or reload drops them. Fetch the logs you need before navigating
- **Logging stays on per tab**: once `fox_start_logging` is called on a tab, it keeps recording across sites until `fox_stop_logging` or the tab is closed (recording pauses while the tab is on a protected site)
- **Only some sources are captured**: console means calls to `console.log` / `warn` / `error` / `info` / `debug` only — uncaught exceptions and the browser's own errors are not included. Network means the page's `fetch` / XHR only — images, scripts, CSS, WebSocket, etc. are not. The latest 500 entries of each are kept
- **Secrets in network logs are only partly masked**: the `authorization`, `cookie`, `set-cookie`, `proxy-authorization` and `x-api-key` headers become `[MASKED]`; other headers (`x-auth-token`, …) and request / response bodies (first 1000 / 5000 characters) are recorded as they are

## Installation and operation

- **Re-run the installer after changing Node.js**: the Native Host wrapper (`~/.kitsune-mcp/native-host/run-host.cmd` / `run-host.sh`) embeds the absolute path of the node used at install time. When that path is gone, the wrapper written by the current installer falls back to `node` on the `PATH`, which fails if the environment Firefox was started from has no node on its `PATH`. After upgrading or switching Node.js, run `scripts/install.ps1` / `scripts/install.sh` again
- **Stop the old daemon after an update**: the daemon, the Native Host and the relays verify each other's signatures and check the protocol version. If a daemon from the old version is still running after an update, the relay or the Native Host reports "another version" / "speaks protocol" and cannot use it. Stop that daemon process (and restart Firefox if the Native Host started it); the next tool call starts a new one
- **Native Messaging may not work with Ubuntu's Snap Firefox**: `apt install firefox` installs the Snap. Install the deb from Mozilla's APT repository (`install.sh` warns about it as well)
- **Native Messaging does not work with Flatpak Firefox**: it cannot start hosts outside its sandbox. The popup says "Setup needed" and suggests running the installer, but re-running it does not help. Use a non-Flatpak Firefox
- **macOS is untested**: `install.sh` / `uninstall.sh` are verified on Linux (Ubuntu 24.04 on WSL2), but the macOS-specific paths (`~/Library/Application Support/...`) have never run on a real Mac
- **Without PowerShell on Windows, the installer and uninstaller do not run**: follow "Windows without PowerShell" in the README to set things up by hand. The Native Host uses PowerShell to start the daemon outside Firefox's job object, then tries WMI (`cscript`) and the Task Scheduler (`schtasks`). If all of them fail, it starts the daemon inside the job and logs a warning to `native-host.log`; closing Firefox then stops the daemon and the Claude Code sessions using it
- **Claude Code in WSL cannot use Firefox on Windows**: each side starts its own daemon with its own `~/.kitsune-mcp/` (and API token), so a session in WSL never reaches the Windows Firefox. Run Claude Code and Firefox on the same side
- **With several Firefox profiles open at once, only the one that connected first is used**: nothing shows which one it is
- **The daemon can come back during uninstall**: while the extension is loaded in Firefox, the Native Host restarts the daemon within about 20 seconds, which creates the API token and logs again. Remove the extension or close Firefox before running the uninstaller
- **File modes (0o600 / 0o700) have no effect on Windows**: the API token, logs and screenshots under `~/.kitsune-mcp/` are protected by the access rights of the user profile folder. A `FOX_SCREENSHOTS_DIR` outside the profile makes the Native Host log a warning
- **Log files rotate at 5 MB**: logs in `~/.kitsune-mcp/logs/` are moved to `<name>.old` once they exceed 5 MB (one generation kept). `native-host.log` and the audit log are checked on every write. `daemon.log` is checked when the daemon starts, and every hour while a Native Host is running; used from Claude Code alone, without Firefox, it keeps growing past 5 MB until the daemon restarts
- **There is no `--help` / `--version` for `node packages/mcp-server/dist/index.js`**: every argument except `--daemon` is ignored and it starts as a relay (which also starts a daemon and creates the API token and logs)
- **Version numbers are not unified**: the extension is 0.1.4; the npm packages and the daemon's `/health` report 0.1.0
- **Running the tests needs Node.js 22.12 or later (or 24)**: a requirement of `npm test` (Vitest). KitsuneMCP itself runs on Node.js 18 or later
