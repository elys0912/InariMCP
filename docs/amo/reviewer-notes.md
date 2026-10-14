# Notes for Reviewers

Paste the text below into "Notes for Reviewers" when submitting a version. Replace `<version>` with the version being submitted.

```text
Inari MCP for Firefox <version>: notes for reviewers

1. What it is
The extension lets an MCP client (for example Claude Code) on the same computer read and operate Firefox tabs. It has three parts, all running locally:
- the extension (this submission),
- a native messaging host (Node.js, name "inari_mcp"), installed from the repository,
- a local MCP server process ("daemon"), started by the native host or by the MCP client, listening on 127.0.0.1 only.
Command flow: MCP client -> daemon (127.0.0.1) -> native host -> native messaging -> extension -> content script, and the result back the same way. There is no developer server and no remote service: the extension makes no network requests, and the native host and daemon talk only to each other and to the MCP client on the same computer.
Source: https://github.com/elys0912/InariMCP (tag v<version>). The native host and the daemon are in packages/native-host and packages/mcp-server; they are not part of the .xpi.

2. Permissions
- tabs: list tabs for the tab-listing tool, create / close / switch / reload tabs, read the URL and title of the target tab (URL checks run on them), and tabs.captureTab for screenshots.
- nativeMessaging: runtime.connectNative("inari_mcp"), the only channel to the local host.
- notifications: an OS notification when an action waits for the user's approval, and when a CAPTCHA is detected and the user has to act.
- storage: storage.local keeps the user's answer on the permission page and the state of the pause switch.
- <all_urls>: the packaged content script runs on web pages to read text and elements and to perform approved clicks and typing; captureTab needs it for screenshots.
- contextMenus: one menu item, "Take Screenshot for InariMCP" (page).
- contextualIdentities: optional container scope (the agent is limited to one container, off by default), listing containers, and opening a tab in a container.
- cookies: only because Firefox requires it to pass cookieStoreId to tabs.create (opening a tab in a container). The cookies API is never called; no cookie is read or sent.
- find: browser.find.find for the text search mode of fox_find.
- webNavigation: onCompleted / onDOMContentLoaded to wait for a navigation to finish (fox_wait with for: "navigation").

3. Data sent over native messaging (policy section 6)
Native messaging carries tool results to the local host: page text and elements, form values, URL and title, the tab list, container names, and screenshots (data URLs; the native host saves them as files under ~/.inari-mcp/screenshots and passes on only the path). This is declared in manifest.json as data_collection_permissions.required = ["websiteContent", "browsingActivity"].
- Masked in the content script and never sent: password fields, hidden fields, autocomplete="one-time-code", and autocomplete cc-* (cc-number, cc-csc, cc-exp, ...).
- No cookies, no history, no user activity is recorded.
- Consent: on first run the extension opens a permission page (add-on name, what is sent and where, that the native host is required, what happens if declined). It does not connect to the native host until the user allows it. The popup has a pause switch (every call refused while paused), and a badge shows while a tool is working.
- Every action that changes a page or the browser (click, type, submit, navigate, open or close a tab) waits for the user's approval, on every site and for each call, given in the MCP client's dialog or in the toolbar popup; nothing in the page can give it. An approval covers one call on one site: the host name of the page, or for a local file or a blank tab the scheme (file:, about:). The extension itself refuses an action that was not approved for the site of its tab. When the daemon does not yet know which page the target tab shows, the action cannot be approved until the tab list is read (fox_tabs). Reading tools (read, find, screenshot, tabs) run without approval; reading a page and screenshots ask as well on the sites the user lists in confirm_read_sites in ~/.inari-mcp/safety.json (empty by default).
- "incognito": "not_allowed": private windows are never read or stored.
- Local files: screenshots are deleted after 30 days; ~/.inari-mcp/logs/audit.jsonl records time, tool name, URL and masked arguments, not page content.
Privacy policy: https://github.com/elys0912/InariMCP/blob/main/docs/PRIVACY.md

4. No remote code
- No eval, no new Function, no string passed to setTimeout, no tabs.executeScript. Nothing received from the native host is executed as code.
- The only content script is the packaged file dist/content.js (with dist/content.css), declared in manifest.json. Extension pages load only packaged scripts; the default CSP is not changed.

5. How to test
No account or credentials are needed. Testing needs Node.js 20 or later and the native host:
  git clone https://github.com/elys0912/InariMCP.git && cd InariMCP && git checkout v<version>
  npm ci && npm run build && npm run setup
Then follow docs/amo/reviewer-smoke.md: scripts/e2e/reviewer-smoke.mjs drives the basic functions (open a tab, read it, find, screenshot, click, close the tab; the reviewer approves each action in the toolbar popup) against a local test page, without the internet and without an MCP client.
On Ubuntu, use a Firefox from Mozilla's APT repository or the mozilla.org tarball: the Snap build starts native messaging hosts through the desktop portal, which may not work.
On Windows, the native host starts the daemon outside Firefox's job object (PowerShell, then WMI via cscript, then a one-off Task Scheduler task), so that closing Firefox does not end the MCP client's sessions. This is in the native host, not in the extension.

6. Source code and build
The .xpi is bundled with esbuild from TypeScript. Build it from the source package with:
  npm ci && npm run build
The source package is made with "npm run pack:source". BUILD.md lists the build environment (OS, Node.js and npm versions) and the exact commands.
```
