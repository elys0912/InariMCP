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
- notifications: an OS notification when an action waits for the user's approval, when a CAPTCHA is detected and the user has to act, and when a screenshot from the context menu cannot reach the native host.
- storage: storage.local keeps the user's answer on the permission page and the state of the pause switch.
- <all_urls>: the packaged content script runs on web pages to read text and elements and to perform approved clicks and typing; captureTab needs it for screenshots.
- contextMenus: one menu item, "Take Screenshot for Inari MCP" (page), created only while the user has allowed the connection on the permission page.
- contextualIdentities: optional container scope (the agent is limited to one container, off by default), listing containers, and opening a tab in a container.
- cookies: only because Firefox requires it for two container features: to read the cookieStoreId of a tab (which container it is in: the container scope and the tab list) and to pass cookieStoreId to tabs.create (opening a tab in a container). The cookies API is never called; no cookie is read or sent.
- find: browser.find.find for the text search mode of fox_find.
- webNavigation: onCompleted / onDOMContentLoaded to wait for a navigation to finish (fox_wait with for: "navigation").

3. Data sent over native messaging (policy section 6)
Native messaging carries tool results to the local host: page text and elements, form values, URL and title, the tab list, container names, and screenshots (data URLs; the native host saves them as files under ~/.inari-mcp/screenshots and passes on only the path). This is declared in manifest.json as data_collection_permissions.required = ["websiteContent", "browsingActivity", "websiteActivity"]. websiteActivity is declared because the extension performs the approved clicks, typing and other actions in pages and returns the current values of form fields and the scroll position.
- Masked in the content script and never sent: the values of password fields (also autocomplete="current-password" / "new-password"), hidden fields, autocomplete="one-time-code", and every autocomplete token starting with cc- (cc-number, cc-csc, cc-exp, cc-name, ...); in such a select, the value and text of each option. The reading commands refuse a CSS selector that could test a masked value ([value...], [selected], :checked, :default, or longer than 1024 characters). Screenshots are images of the tab and are not masked.
- No cookies are read and no history is kept. What the user does in the browser is not recorded: form values and the scroll position are read from the page's current state, only when a tool asks for them.
- Consent: on first run the extension opens a permission page (add-on name, what is sent and where, that the native host is required, what happens if declined). It does not connect to the native host until the user allows it. The popup always links to the permission page, where the user can withdraw the permission (the extension then disconnects). The popup has a pause switch (every call refused while paused; a running one is answered "paused" at once, its work in the page stops at the next step, and an operation done by the browser alone runs to its end with its result dropped), and a badge shows while a tool is working.
- Every action on a page or the browser (click, type, press a key, set a field value, hover, navigate, open or close a tab) waits for the user's approval, on every site and for each call, given in the MCP client's dialog or in the toolbar popup; nothing in the page can give it. An approval covers one call on one site: the host name of the page, or for a local file or a blank tab the scheme (file:, about:). The extension itself refuses an action that was not approved for the site of its tab. When the daemon does not yet know which page the target tab shows, the action cannot be approved until the tab list is read (fox_tabs). Reading tools (read, find, screenshot, tabs), waiting, switching tabs, changing the state of a browser window (maximize, restore, full screen), scrolling and highlighting an element run without approval; reading a page and screenshots ask as well on the sites the user lists in confirm_read_sites in ~/.inari-mcp/safety.json (empty by default).
- "incognito": "not_allowed": private windows are never read or stored.
- Local files: screenshots taken through the extension are deleted after 30 days; ~/.inari-mcp/logs/audit.jsonl records time, tool name, URL (secret query parameters masked) and masked arguments, not page content.
Privacy policy: https://github.com/elys0912/InariMCP/blob/v<version>/docs/PRIVACY.md

4. No remote code
- No eval, no new Function, no string passed to setTimeout, no tabs.executeScript. Nothing received from the native host is executed as code.
- The only content script is the packaged file dist/content.js, declared in manifest.json for the top frame only (all_frames is false); no stylesheet is injected into pages. Extension pages load only packaged scripts; the default CSP is not changed.
- Page hooks for one wait (src/content/page-hooks.ts): while fox_wait with for: "network_idle" runs, the content script uses window.wrappedJSObject and exportFunction to wrap the page's own window.fetch and XMLHttpRequest.prototype.send, so that it can count the page's requests in flight. The wrappers only count; every call is passed on unchanged to the page's original function (never the content script's own fetch / XHR), and nothing about a request or its response is read or kept. No script element is inserted and no code string is evaluated. When the last running wait ends, the original functions are put back.

5. How to test
No account or credentials are needed. Testing needs Node.js 20 or later and the native host. In the source package of this version (or a clone of the tag v<version> of the repository above), run:
  npm ci && npm run build && npm run setup
Then follow docs/amo/reviewer-smoke.md: scripts/e2e/reviewer-smoke.mjs drives the basic functions (open a tab, read it, find, screenshot, click, close the tab; the reviewer approves each action in the toolbar popup) against a local test page, without the internet and without an MCP client.
On Ubuntu, use a Firefox from Mozilla's APT repository or the mozilla.org tarball: the Snap build starts native messaging hosts through the desktop portal, which may not work.
On Windows, the native host starts the daemon outside Firefox's job object (PowerShell, then WMI via cscript, then a one-off Task Scheduler task), so that closing Firefox does not end the MCP client's sessions. This is in the native host, not in the extension.

6. Source code and build
The .xpi is bundled with esbuild from TypeScript. Build it in the root directory of the source package with:
  npm ci
  npm run build
  npm run pack:ext
pack:ext writes the add-on zip and the SHA-256 of every file in it to web-ext-artifacts/, to compare with the submitted file. The source package is made with "npm run pack:source". BUILD.md lists the build environment (OS, Node.js and npm versions), the same commands and how to compare the result.

7. Changes since the previous version
The Version Notes hold this version's section of docs/CHANGELOG.md. The permissions and the manifest's data collection declaration are unchanged; the only addition to the data sent over native messaging is the answer of the new window command (the window's state and its outer width and height, like the viewport size the page info has always carried); the changed source files are marked with comments that start with "<version>:". 0.2.0 adds one browser command, set_window_state (browser.windows.update with a state), which changes only the browser's own window and therefore, like switching tabs, runs without the user's approval.
```
