# Changelog

**English** | [日本語](./CHANGELOG.ja.md)

User-facing changes of Inari MCP for Firefox, newest first.

Inari MCP for Firefox started on 2026-10-14 as a copy of [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0 (commit b2642a9). It is the edition prepared for listing on addons.mozilla.org: it has a different add-on ID, a different native-messaging host name (`inari_mcp`) and a different state directory (`~/.inari-mcp`), so both editions can be installed side by side. For the history before the split, see the KitsuneMCP changelog.

## Unreleased (0.1.0)

### Changed

- Renamed from KitsuneMCP to Inari MCP for Firefox. Add-on ID `inari-mcp@elys0912.github.io`, host manifest `inari_mcp`, state directory `~/.inari-mcp`, npm packages `@inari-mcp/*`.
- Line endings in the repository are fixed to LF with `.gitattributes`, so the extension built on any OS is byte-identical to the one submitted for review.
- `manifest.json`: `incognito` is `not_allowed` (the extension never sees private-browsing tabs), and `data_collection_permissions` declares `websiteContent` and `browsingActivity` (page content, screenshots and URLs are sent to the local native host and from there to the MCP client).
- `fox_wait` with `for: "network_idle"`: the counting hooks on the page's `fetch` and `XMLHttpRequest.prototype.send` are installed when the wait starts and removed when it ends (before, they stayed until the page unloaded). They count requests and record nothing about them. Requests already running when the call starts are not seen.
- Every acting tool asks the human before it runs, on every site: `fox_click`, `fox_type`, `fox_press_key`, `fox_set_value`, `fox_navigate`, `fox_tab` create / close (with or without a container) and `fox_handle_dialog`. One approval covers one call of that tool with those arguments on that site; a series of acting calls is asked call by call. Reading, waiting and UI-only tools (`fox_read`, `fox_find`, `fox_screenshot`, `fox_tabs`, `fox_wait`, `fox_interact`, `fox_tab` switch, …) run without asking. When the daemon has not yet seen the target tab's page, an acting call cannot be approved until `fox_tabs` is called.
- The Firefox extension itself refuses an acting command that was not approved for the site of its tab (or of the URL it opens), whatever the daemon sends.
- The approval prompt (MCP elicitation and the toolbar popup) asks "Allow this operation?" with the tool, the site and the arguments, instead of naming a protected site.
- `fox_safety_status` reports `approvalPolicy` (which calls ask) and `confirmReadSites`, instead of `confirmProtectedActions` and `protectedUrlPatterns`.

### Removed

- The script tools `fox_evaluate` and `fox_observer` (earlier names `fox_execute_script`, `fox_eval_chain`, `fox_wait_and_act`, `fox_inject_observer`, `fox_remove_observer`), on the extension and in headless mode. The extension no longer runs code given as a string (`tabs.executeScript` with `code`).
- The logging tools `fox_logging` and `fox_get_logs` (earlier names `fox_start_logging`, `fox_stop_logging`, `fox_clear_logs`, `fox_get_console_logs`, `fox_get_network_logs`). The extension no longer records the page's console messages or fetch / XHR traffic.
- The `allow_script_execution` key of `safety.json` and the `FOX_ALLOW_SCRIPTS` / `CLAUDE_BROWSER_ALLOW_SCRIPTS` variables. A `safety.json` that still has the key is refused as an unknown key until the key is deleted.
- The `logs` and `script` profiles of `FOX_CAPS` (an unknown profile name is ignored with a warning).
- The "Inspect Element for InariMCP" context menu entry: it handed its result to nobody.
- The protected-site list: `protected_url_patterns` (16 default sites: banks and other finance or payment services, `.gov`, patient portals) and `confirm_protected_actions` in `safety.json`. Acting tools ask on every site instead; list the sites where reads and screenshots should ask as well in the new `confirm_read_sites` (default empty). A `safety.json` that still has either key is refused as an unknown key until the key is deleted.
