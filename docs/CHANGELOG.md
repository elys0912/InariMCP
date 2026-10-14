# Changelog

**English** | [日本語](./CHANGELOG.ja.md)

User-facing changes of Inari MCP for Firefox, newest first.

Inari MCP for Firefox started on 2026-10-14 as a copy of [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0 (commit b2642a9). It is the edition prepared for listing on addons.mozilla.org: it has a different add-on ID, a different native-messaging host name (`inari_mcp`) and a different state directory (`~/.inari-mcp`), so both editions can be installed side by side. For the history before the split, see the KitsuneMCP changelog.

## Unreleased (0.1.0)

### Changed

- Renamed from KitsuneMCP to Inari MCP for Firefox. Add-on ID `inari-mcp@elys0912.github.io`, host manifest `inari_mcp`, state directory `~/.inari-mcp`, npm packages `@inari-mcp/*`.
- Line endings in the repository are fixed to LF with `.gitattributes`, so the extension built on any OS is byte-identical to the one submitted for review.
- `manifest.json`: `incognito` is `not_allowed` (the extension never sees private-browsing tabs), and `data_collection_permissions` declares `websiteContent` and `browsingActivity` (page content, screenshots and URLs are sent to the local native host and from there to the MCP client).
- Screenshots saved under a `filename` you chose are now deleted after `FOX_SCREENSHOT_RETENTION_DAYS` (default 30) like the others; the Native Host lists them in `.named-screenshots` in the screenshots directory and never deletes any other file there.
- README: a Permissions section lists what each of the nine extension permissions is used for and where (`cookies` reads no cookie; it is what Firefox requires to open a tab in a container), and that the agent can create a Firefox container.

### Security

- Values are masked as `[MASKED]` in more fields, on the extension and in headless mode alike: besides password fields, `type="hidden"` fields and fields whose `autocomplete` is `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month` or `cc-exp-year` (`current-password` / `new-password` as before). `allow_password_typing` still only allows typing into password fields and unmasks nothing.
- The daemon refuses to start when `FOX_HOST` is not a loopback address (127.0.0.0/8, `::1`, `localhost`), instead of logging a warning and serving plain HTTP / WebSocket to the network.
- Tools that act on a page are refused on a tab without a host (`view-source:`, `blob:`, `data:`, …; `about:` and `file:` excepted), which no URL pattern of `safety.json` can match. Reading tools still work there.
- A `urlPattern` argument longer than 256 characters, or with a repeated group that contains a repeat (such as `(a+)+`), is refused before it is compiled, by the daemon and again by the extension, so one pattern cannot stall the extension's background page.
