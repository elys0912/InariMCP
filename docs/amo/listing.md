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
| Privacy policy | https://github.com/elys0912/InariMCP/blob/main/docs/PRIVACY.md |
| Notes for Reviewers | [reviewer-notes.md](./reviewer-notes.md) |

Tags: AMO offers tags from its own list on the edit page. Use those of the following that appear there: `container`, `tab`, `screenshot`, `developer`, `automation`.

## English (en-US)

### Summary

(250 characters at most; this text is 216.)

```text
Lets an MCP client such as Claude Code read and operate your own Firefox tabs. Page text, URLs and screenshots go only to a native host on your computer. Clicking, typing and navigating always wait for your approval.
```

### Description

```text
Inari MCP for Firefox connects your everyday Firefox to an MCP client such as Claude Code, so that the AI you use there can read pages, find elements, take screenshots, open and switch tabs, click, type and navigate in your real profile, with your real logins.

What it sends
When the MCP client calls a tool, the extension reads what that tool needs from your tabs: page text and elements, form values, the URL and title, the list of open tabs, or a screenshot. It sends this to the native host on your computer, which passes it to the MCP client you connected. The MCP client sends it on to its AI provider. Nothing is sent to the developer; there is no developer server.
Password, hidden, one-time-code and credit card fields are masked and never sent. Cookies are not read.

What you need
- Node.js 20 or later
- The native host and MCP server from https://github.com/elys0912/InariMCP (clone, then npm ci, npm run build, npm run setup). The extension does nothing without it.
- An MCP client, such as Claude Code

You stay in control
- On first start, the extension asks for your permission. It does not connect to the native host until you allow it.
- Clicking, typing, submitting and navigating always wait for your approval, in the MCP client or in the toolbar popup. Reading pages does not ask.
- A badge shows while a tool is working. A pause switch in the popup refuses every call.

What it does not do
- It never runs scripts in pages: no code from the MCP client or the AI is executed.
- It does not work in private windows.
- It does not solve CAPTCHAs; it hands control back to you.

Screenshots are kept on your computer for 30 days. A log of tool calls (time, tool name, URL) is kept on your computer.
Privacy policy: https://github.com/elys0912/InariMCP/blob/main/docs/PRIVACY.md

Inari MCP for Firefox is the addons.mozilla.org edition of KitsuneMCP, a fork of ClaudeCodeBrowser (MIT). It is not made by Anthropic or Mozilla.
```

## 日本語 (ja)

### 概要（Summary）

（250 文字以内。この文は 126 文字。）

```text
Claude Code などの MCP クライアントから、普段使いの Firefox のタブを読んで操作できるようにする。ページの文字・URL・スクリーンショットは同じ PC のネイティブホストにだけ送る。クリック・入力・移動は毎回あなたの承認を待つ。
```

### 説明（Description）

```text
Inari MCP for Firefox は、普段使いの Firefox を Claude Code などの MCP クライアントにつなぐ。そこで使う AI が、あなたの実際のプロファイルとログイン状態のまま、ページを読む、要素を探す、スクリーンショットを撮る、タブを開く・切り替える、クリック・入力・ページの移動をする、といったことを行える。

送るもの
MCP クライアントがツールを呼ぶと、拡張機能はそのツールに要るものだけをタブから読む：ページの文字と要素、フォームの値、URL とタイトル、開いているタブの一覧、スクリーンショット。それを同じ PC のネイティブホストへ送り、ネイティブホストは接続した MCP クライアントへ渡す。MCP クライアントはそれを自分の AI の提供元へ送る。開発者には何も送らない（開発者のサーバーは無い）。
パスワード・hidden・ワンタイムコード・クレジットカードの欄は伏せて、送らない。cookie は読まない。

要るもの
- Node.js 20 以上
- https://github.com/elys0912/InariMCP のネイティブホストと MCP サーバー（clone して npm ci、npm run build、npm run setup）。これが無いと拡張機能は何もしない。
- Claude Code などの MCP クライアント

制御はあなたの手に
- 初回の起動で許可を求める。許可するまでネイティブホストに繋がない。
- クリック・入力・送信・ページの移動は、毎回 MCP クライアントかツールバーのポップアップであなたの承認を待つ。ページを読むだけなら承認を求めない。
- ツールが動いている間はバッジが付く。ポップアップの一時停止スイッチで、すべての呼び出しを断れる。

できないこと
- ページでスクリプトを実行しない。MCP クライアントや AI から来たコードは実行しない。
- プライベートウィンドウでは動かない。
- CAPTCHA は解かない。あなたに操作を返す。

スクリーンショットは手元の PC に 30 日残る。ツールの呼び出しの記録（時刻・ツール名・URL）も手元の PC に残る。
プライバシーポリシー：https://github.com/elys0912/InariMCP/blob/main/docs/PRIVACY.ja.md

Inari MCP for Firefox は KitsuneMCP の addons.mozilla.org 版で、KitsuneMCP は ClaudeCodeBrowser（MIT）のフォーク。Anthropic や Mozilla が作ったものではない。
```

## Images

The listing needs images that are not in this file: an icon (PNG, from `packages/extension/icons/icon.svg`) and screenshots (the permission page, an approval in the popup, a result in the MCP client).
