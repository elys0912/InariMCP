# AMO listing material

Text to paste into the listing of Inari MCP for Firefox on addons.mozilla.org (Developer Hub → Edit Product Page). English first, then Japanese (add it as the `ja` locale of the listing).

## Fields shared by both languages

| Field | Value |
|---|---|
| Name | Inari MCP for Firefox |
| Add-on URL (slug) | `inari-mcp-for-firefox` |
| Categories (up to 2) | Web Development; Tabs |
| Support email | (empty: support is through GitHub issues only) |
| Support site | https://github.com/elys0912/InariMCP/issues |
| Homepage | https://github.com/elys0912/InariMCP |
| License | MIT License (see `LICENSE`) |
| Privacy policy | https://github.com/elys0912/InariMCP/blob/v<version>/docs/PRIVACY.md |
| Notes for Reviewers | [reviewer-notes.md](./reviewer-notes.md) |
| Compatibility (set for each version) | Firefox for desktop only: untick Firefox for Android. The add-on needs native messaging, which Firefox for Android does not have |

Replace `<version>` with the version being submitted (here and in the descriptions below): the privacy policy is linked at the tag of that version, so the page does not change after the review.

Tags: AMO offers tags from its own list on the edit page. Use those of the following that appear there: `container`, `tab`, `screenshot`, `developer`, `automation`.

## English (en-US)

### Summary

(250 characters at most; this text is 246.)

```text
Lets an MCP client such as Claude Code read and operate your Firefox tabs. Page text, URLs and screenshots go via a native host on your computer to the MCP client and its AI provider. Clicking, typing and navigating always wait for your approval.
```

### Description

```text
Inari MCP for Firefox connects your everyday Firefox to an MCP client such as Claude Code, so that the AI you use there can read pages, find elements, take screenshots, open and switch tabs, click, type and navigate in your real profile, with your real logins.

What it sends
When the MCP client calls a tool, the extension reads what that tool needs from your tabs: page text and elements, form values, the URL and title, the list of open tabs, or a screenshot. It sends this to the native host on your computer, which passes it to the MCP client you connected. The MCP client sends it on to its AI provider. Nothing is sent to the developer; there is no developer server.
The values of password, hidden, one-time-code and credit card fields are masked and never sent. Screenshots are images of the screen and are not masked. Cookies are not read.

What you need
- Node.js 20 or later
- The native host and MCP server from https://github.com/elys0912/InariMCP (clone, then npm ci, npm run build, npm run setup). The extension does nothing without it.
- An MCP client, such as Claude Code

You stay in control
- On first start, the extension asks for your permission. It does not connect to the native host until you allow it. The toolbar popup can open the permission page again, where you can withdraw it.
- Every action on a page or the browser (clicking, typing, pressing keys, setting a field, hovering, navigating, opening or closing a tab) waits for your approval, each time and on every site, in the MCP client or in the toolbar popup. Reading, waiting, scrolling, highlighting an element, switching tabs and maximizing or restoring the window do not ask, except that reading a page and taking screenshots ask on the sites you list in confirm_read_sites.
- An approval given in the MCP client's dialog reaches the local Inari MCP server over 127.0.0.1. A program on your computer that can read its key (~/.inari-mcp/api_token) could approve its own requests. To approve only in the toolbar popup, set FOX_APPROVAL_ELICITATION=0.
- A badge shows while a tool is working. A pause switch in the popup refuses every call; a running one is answered "paused" at once, its work in the page stops at the next step, and an operation done by the browser alone runs to its end with its result dropped.

What it does not do
- It runs no code that comes from the MCP client or the AI.
- It does not work in private windows.
- It does not solve CAPTCHAs; it hands control back to you.

While a tool waits for a page's network to be idle, the extension wraps the page's fetch and XMLHttpRequest send for that wait only: it counts the requests, passes each one on unchanged, reads nothing of them, and puts the original functions back when the wait ends.

Screenshots taken through the extension are kept on your computer for 30 days. A log of tool calls (time, tool name, URL) is kept on your computer.
Privacy policy: https://github.com/elys0912/InariMCP/blob/v<version>/docs/PRIVACY.md

Inari MCP for Firefox is derived from ClaudeCodeBrowser (MIT). It is not made by Anthropic or Mozilla.
```

## 日本語 (ja)

### 概要（Summary）

（250 文字以内。この文は 150 文字。）

```text
Claude Code などの MCP クライアントから、普段使いの Firefox のタブを読んで操作できるようにする。ページの文字・URL・スクリーンショットは、同じ PC のネイティブホストを経て MCP クライアントとその AI の提供元へ渡る。クリック・入力・移動は毎回あなたの承認を待つ。
```

### 説明（Description）

```text
Inari MCP for Firefox は、Claude Code などの AI ツールが、いま使っている Firefox を代わりに操作できるようにする拡張機能です。AI はページを読み、スクリーンショットを撮り、タブを開いたり切り替えたり、クリックや文字の入力をします。ログイン済みのサイトも、そのまま使えます。

■ AI に渡るもの
AI が必要としたときだけ、ページの文字、入力欄の内容、URL、開いているタブの一覧、スクリーンショットを、この PC の中の補助プログラム（ネイティブホスト）を通して AI ツールへ渡します。AI ツールはそれを AI の提供元（Claude なら Anthropic）に送ります。
開発者には何も送られません。開発者のサーバーはありません。
パスワード、隠し項目（hidden）、ワンタイムコード、クレジットカード番号の欄は伏せ字にして渡しません。スクリーンショットは画面そのままなので、伏せ字になりません。cookie は読みません。

■ あなたが決めること
・最初に起動したとき、使ってよいか確認する画面が出ます。許可するまで何もしません。あとから取り消せます。
・クリック、入力、ページの移動、タブの開閉など、ページを変える操作は、毎回あなたの承認を待ちます。承認は AI ツールの画面か、Firefox のツールバーのボタンから行います。読むだけの操作と、タブの切り替えやウインドウの最大化は承認なしで動きます（設定で特定のサイトを「読むときも確認」にできます）。
・AI ツールの画面での承認は、この PC の中の通信で Inari MCP に届きます。この PC で動く別のプログラムが、その通信の鍵（~/.inari-mcp/api_token）を読めれば、自分で承認を出せてしまいます。気になる場合は、設定 FOX_APPROVAL_ELICITATION=0 でツールバーのボタンからの承認だけにできます。
・ツールバーのボタンに一時停止のスイッチがあります。入れている間、AI からの操作はすべて断ります。

■ 使うために必要なもの
・Node.js 20 以上
・補助プログラム（ネイティブホスト）と MCP サーバー。https://github.com/elys0912/InariMCP から入手し、README の手順で入れます。これが無いと拡張機能は何もしません。
・Claude Code などの MCP 対応の AI ツール

■ しないこと
・AI から送られてきたプログラムを実行しません。
・プライベートウィンドウでは動きません。
・CAPTCHA（人間かどうかの確認）は解きません。あなたに操作を返します。

補足：AI が「ページの通信が落ち着くまで待つ」操作をしている間だけ、ページの通信回数を数えます。通信の中身は読まず、終わると元に戻します。
スクリーンショットは PC の中に 30 日間残ります。操作の記録（時刻、操作名、URL）も PC の中に残ります。
プライバシーポリシー：https://github.com/elys0912/InariMCP/blob/v<version>/docs/PRIVACY.ja.md

Inari MCP for Firefox は ClaudeCodeBrowser（MIT ライセンス）から派生したものです。Anthropic、Mozilla とは関係ありません。
```

## Images

The listing needs images that are not in this file: an icon (PNG, from `packages/extension/icons/icon.svg`) and screenshots (the permission page, an approval in the popup, a result in the MCP client).
