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
- Every action on a page or the browser (clicking, typing, pressing keys, setting a field, hovering, navigating, opening or closing a tab) waits for your approval, each time and on every site, in the MCP client or in the toolbar popup. Reading, waiting, scrolling, highlighting an element and switching tabs do not ask, except that reading a page and taking screenshots ask on the sites you list in confirm_read_sites.
- An approval given in the MCP client's dialog reaches the local Inari MCP server over 127.0.0.1. A program on your computer that can read its key (~/.inari-mcp/api_token) could approve its own requests. To approve only in the toolbar popup, set FOX_APPROVAL_ELICITATION=0.
- A badge shows while a tool is working. A pause switch in the popup refuses every call and stops the one that is running.

What it does not do
- It runs no code that comes from the MCP client or the AI.
- It does not work in private windows.
- It does not solve CAPTCHAs; it hands control back to you.

While a tool waits for a page's network to be idle, the extension wraps the page's fetch and XMLHttpRequest send for that wait only: it counts the requests, passes each one on unchanged, reads nothing of them, and puts the original functions back when the wait ends.

Screenshots taken through the extension are kept on your computer for 30 days. A log of tool calls (time, tool name, URL) is kept on your computer.
Privacy policy: https://github.com/elys0912/InariMCP/blob/v<version>/docs/PRIVACY.md

Inari MCP for Firefox is the addons.mozilla.org edition of KitsuneMCP, a fork of ClaudeCodeBrowser (MIT). It is not made by Anthropic or Mozilla.
```

## 日本語 (ja)

### 概要（Summary）

（250 文字以内。この文は 150 文字。）

```text
Claude Code などの MCP クライアントから、普段使いの Firefox のタブを読んで操作できるようにする。ページの文字・URL・スクリーンショットは、同じ PC のネイティブホストを経て MCP クライアントとその AI の提供元へ渡る。クリック・入力・移動は毎回あなたの承認を待つ。
```

### 説明（Description）

```text
Inari MCP for Firefox は、普段使いの Firefox を Claude Code などの MCP クライアントにつなぐ。そこで使う AI が、あなたの実際のプロファイルとログイン状態のまま、ページを読む、要素を探す、スクリーンショットを撮る、タブを開く・切り替える、クリック・入力・ページの移動をする、といったことを行える。

送るもの
MCP クライアントがツールを呼ぶと、拡張機能はそのツールに要るものだけをタブから読む：ページの文字と要素、フォームの値、URL とタイトル、開いているタブの一覧、スクリーンショット。それを同じ PC のネイティブホストへ送り、ネイティブホストは接続した MCP クライアントへ渡す。MCP クライアントはそれを自分の AI の提供元へ送る。開発者には何も送らない（開発者のサーバーは無い）。
パスワード・hidden・ワンタイムコード・クレジットカードの欄の値は伏せて、送らない。スクリーンショットは画面の画像なので伏せない。cookie は読まない。

要るもの
- Node.js 20 以上
- https://github.com/elys0912/InariMCP のネイティブホストと MCP サーバー（clone して npm ci、npm run build、npm run setup）。これが無いと拡張機能は何もしない。
- Claude Code などの MCP クライアント

制御はあなたの手に
- 初回の起動で許可を求める。許可するまでネイティブホストに繋がない。ツールバーのポップアップから許可の画面を開き直して、許可を取り消せる。
- ページやブラウザへの操作（クリック、入力、キーの入力、入力欄の値の設定、hover、ページの移動、タブを開く・閉じる）は、どのサイトでも毎回、MCP クライアントかツールバーのポップアップであなたの承認を待つ。読み取り・待機・スクロール・要素の強調表示・タブの切り替えは承認を求めない。ただし confirm_read_sites に書いたサイトでは、ページの読み取りとスクリーンショットも承認を待つ。
- MCP クライアントのダイアログでの承認は、127.0.0.1 を通って手元の Inari MCP のサーバーに届く。その鍵（~/.inari-mcp/api_token）を読める手元の PC のプログラムは、自分の要求を自分で承認できる。ツールバーのポップアップでだけ承認するには FOX_APPROVAL_ELICITATION=0 を設定する。
- ツールが動いている間はバッジが付く。ポップアップの一時停止スイッチで、すべての呼び出しを断り、実行中のものも中断できる。

できないこと
- MCP クライアントや AI から来たコードは実行しない。
- プライベートウィンドウでは動かない。
- CAPTCHA は解かない。あなたに操作を返す。

ツールがページの通信が止むのを待つ間だけ、拡張機能はページの fetch と XMLHttpRequest の send を包む。リクエストを数えるだけで、そのまま元の関数に渡し、中身は読まない。待ちが終わると元の関数に戻す。

拡張機能で撮ったスクリーンショットは手元の PC に 30 日残る。ツールの呼び出しの記録（時刻・ツール名・URL）も手元の PC に残る。
プライバシーポリシー：https://github.com/elys0912/InariMCP/blob/v<version>/docs/PRIVACY.ja.md

Inari MCP for Firefox は KitsuneMCP の addons.mozilla.org 版で、KitsuneMCP は ClaudeCodeBrowser（MIT）のフォーク。Anthropic や Mozilla が作ったものではない。
```

## Images

The listing needs images that are not in this file: an icon (PNG, from `packages/extension/icons/icon.svg`) and screenshots (the permission page, an approval in the popup, a result in the MCP client).
