# Privacy policy of Inari MCP for Firefox

**English** | [日本語](./PRIVACY.ja.md)

Last updated: 2026-10-14

This policy covers the Firefox extension "Inari MCP for Firefox" and the programs from this repository that work with it on your computer (the native host and the MCP server). Together they are called "Inari MCP" below.

## Who is responsible

Inari MCP is made by the developer with the GitHub handle **elys0912**. The only way to contact the developer is a [GitHub issue](https://github.com/elys0912/InariMCP/issues). Please do not put personal information in an issue: issues are public.

## The short version

- Inari MCP lets a program on your computer, an MCP client such as Claude Code, read and operate the tabs of your Firefox.
- What it reads from your tabs goes to that MCP client on the same computer. The MCP client sends it on to the AI service it uses.
- Nothing is sent to the developer. The developer runs no server and receives no data, no statistics and no crash reports.
- Every action on a page or the browser (clicking, typing, moving the mouse pointer over an element, submitting forms, navigating, opening or closing a tab) waits for your approval, on every site and each time. Reading, waiting, scrolling, highlighting an element and switching tabs do not, except that reading a page and taking screenshots also ask on the sites you list yourself.
- Screenshots taken through the extension are kept on your computer for 30 days. A log of tool calls (time, tool name, URL) is kept on your computer. You can delete both at any time.

## What is read and sent

Inari MCP reads something from your browser only when the MCP client calls one of its tools, and only what that tool needs. Depending on the tool, this is:

- **Page text and elements**: the text of the page, and elements such as links, buttons and form fields (their tag, text, attributes, position and a CSS selector).
- **Form values**: the current value of form fields. The values of these fields are replaced with `[MASKED]` and never sent: password fields (also those with `autocomplete="current-password"` or `"new-password"`), hidden fields, fields for one-time codes (`autocomplete="one-time-code"`), and credit card fields (an `autocomplete` value starting with `cc-`, such as `cc-number`, `cc-csc`, `cc-exp` and `cc-name`). In such a field that is a list (`<select>`), the value and the text of each option are masked too, and the reading tools refuse a CSS selector that could test a masked value (`[value…]`, `[selected]`, `:checked`, `:default`).
- **URLs and titles** of the tab being used.
- **The list of open tabs**: URL, title and container of each tab (by default the current window, at most 50 tabs).
- **Screenshots** of a tab, the whole page, or all tabs.
- **Firefox containers**: the names of your containers, when a tool lists them or opens a tab in one.

**Cookies**: Inari MCP does not read your cookies and does not send them, their names or their values. The `cookies` permission is needed only to see which Firefox container a tab is in and to open a tab in a container.

The page text and screenshots can contain anything shown on the page, including personal information. Only the field types listed above are masked, and only in the values the tools read from the page: a screenshot is an image of the screen and is not masked, so a value shown in a field (a card number typed into a plain text field, for example) appears in it.

**Waiting for the network**: while a tool waits for the page's network to be idle (`fox_wait` with `for: "network_idle"`), the extension wraps the page's own `fetch` and `XMLHttpRequest` `send` functions, only for the time of that wait. The wrappers count the requests that start and end; every call is passed on unchanged to the page's original function, and nothing about a request (URL, headers, body, response) is read or kept. When the wait ends, the original functions are put back.

Inari MCP does not record what you do in the browser yourself and does not keep a browsing history. Nothing is read or sent without a tool call, except when you use the extension's right-click menu or toolbar popup yourself (see "What stays on your computer").

## Where it goes

1. The **extension** sends the data to the **native host**, a program on your computer that Firefox starts through native messaging.
2. The native host passes it to the **Inari MCP server (daemon)**, which runs on the same computer and is reached only over the local address 127.0.0.1. Screenshots are not passed on as images: the native host saves them as files and passes on only the file path.
3. The daemon returns the data to the **MCP client** you connected, for example Claude Code.
4. The MCP client sends it to the **AI provider** it uses, over the internet. If the MCP client opens a screenshot file, the image goes to the AI provider as well.

The extension itself makes no network requests. The developer's servers are not on this path; there are none. The program that sends data to the internet is the MCP client, not Inari MCP. How the MCP client and the AI provider handle the data is decided by their own privacy policies. Read them before you connect an MCP client.

## What stays on your computer

Everything is in the folder `.inari-mcp` in your home directory (`~/.inari-mcp/`):

| File or folder | What it holds | How long |
|---|---|---|
| `screenshots/` | Screenshots taken by a tool or from the right-click menu | Deleted after 30 days (checked each time the native host starts), whatever their name. The number of days can be changed with `FOX_SCREENSHOT_RETENTION_DAYS`. Screenshots taken in headless mode (`FOX_HEADLESS=1`, where the MCP server drives its own Firefox without the extension) are saved here too but are never deleted automatically: delete them yourself |
| `logs/audit.jsonl` | One line per tool call: time, tool name, URL, the decision (allowed, denied, approved, ...) and the arguments of the call. Text typed into the page, keys pressed, form values and passwords in the arguments are replaced with `***`, also inside nested arguments; secret parameters in URLs (such as `token` or `password` in the query) are replaced with `[MASKED]`. The content of the page is not written. It can be turned off with `"audit_log": false` in `safety.json` | Until the file reaches 5 MB; then it is renamed to `audit.jsonl.old` (one older file is kept) |
| `logs/daemon.log`, `logs/native-host.log` | Messages of the programs themselves: start, stop, connections, command names, errors. Page content is not written; an error message can include a tool name or a URL | Same as above: 5 MB, one older file |
| `safety.json`, `api_token` | Your settings, and the key the local programs use to recognise each other | Until you delete them |

Two buttons of the toolbar popup keep something outside this folder, only when you press them: **Screenshot** saves an image of the current tab in Firefox's download folder, and **Page Info** copies information about the current page (URL, title, headings, links, buttons and form fields with their values, masked as above) to the clipboard. Inari MCP does not delete either. Apart from these, the extension does not save page content, screenshots or URLs inside Firefox.

## How to delete it

- Remove the native host and all the data above: in the folder where you installed Inari MCP, run `npm run teardown -- --purge`.
- Or delete the folder `~/.inari-mcp/` yourself (stop Firefox and your MCP client first).
- Remove the extension in Firefox: `about:addons` → Inari MCP for Firefox → Remove.

Data that the MCP client or the AI provider already received is outside Inari MCP. Delete it through them.

## Your consent and control

- **Permission page**: when the extension starts for the first time, it opens a page that names the extension, explains what is sent and where, and that the native host is needed. Until you allow it there, the extension does not connect to the native host and no data is sent. If you decline, the extension stays disconnected. The toolbar popup always has a link that opens this page again, where you can change your answer: "Don't allow" disconnects the extension at once.
- **Approval of actions**: every action on a page or the browser waits until you approve it, on every site and each time: clicking, typing, pressing keys, setting the value of a form field, moving the mouse pointer over an element (hover), navigating, and opening or closing a tab. You approve in the MCP client's confirmation dialog or in the extension's toolbar popup. Nothing in the page can approve it. An approval covers one call on one site: the host name of the page, or for a local file or a blank tab the scheme (`file:`, `about:`). When Inari MCP does not yet know which page a tab shows, an action there cannot be approved until the tab list is read again (`fox_tabs`). Reading pages and the tab list, taking screenshots, waiting, switching tabs, scrolling and highlighting an element do not ask, except that reading a page and taking screenshots ask as well on the sites you list in `confirm_read_sites` in `~/.inari-mcp/safety.json` (empty by default).
- **Approval in the MCP client**: an answer given in the MCP client's confirmation dialog (MCP elicitation, on by default) reaches the Inari MCP server over the local address 127.0.0.1, authenticated with the key in `~/.inari-mcp/api_token`. A program running on your computer that can read that file (any program of your user account, for example) could therefore approve its own requests. To approve only in the toolbar popup, set `FOX_APPROVAL_ELICITATION=0` in the environment of the MCP client and of Firefox.
- **Badge**: while a tool is working on your browser, the toolbar button shows a badge.
- **Pause**: the toolbar popup has a pause switch. While paused, every tool call is refused, a call that is already running is stopped, and the approval requests still waiting are withdrawn.
- **Disable or remove**: disabling the extension in `about:addons` ends all access to your browser at once; removing it, together with the steps above, removes Inari MCP.

## Private browsing

Inari MCP does not work in private windows. The extension is marked "not allowed in private windows", so Firefox does not let it see or operate private tabs, and nothing from private browsing is read or stored.

## Children

Inari MCP is a tool for adults who use AI tools on their own computer. It is not directed at children. The developer collects no data from anyone, including children.

## Changes to this policy

When this policy changes, the change is listed in the [changelog](./CHANGELOG.md) of the version that brings it, and the date at the top of this page is updated.
