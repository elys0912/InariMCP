# 変更履歴

[English](./CHANGELOG.md) | **日本語**

Inari MCP for Firefox の利用者に見える変更。新しいものが上。

Inari MCP for Firefox は 2026-10-14 に [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0（コミット b2642a9）の写しとして始めた。addons.mozilla.org への掲載に向けて整えた版で、アドオンの ID、ネイティブメッセージングのホスト名（`inari_mcp`）、状態ディレクトリ（`~/.inari-mcp`）が KitsuneMCP と異なるため、両方を同じ Firefox に入れられる。分岐前の履歴は KitsuneMCP の変更履歴を参照。

## Unreleased (0.1.0)

### 変更

- KitsuneMCP から Inari MCP for Firefox に改名。アドオン ID `inari-mcp@elys0912.github.io`、ホストのマニフェスト `inari_mcp`、状態ディレクトリ `~/.inari-mcp`、npm パッケージ `@inari-mcp/*`。
- リポジトリの改行を `.gitattributes` で LF に固定した。どの OS でビルドしても、審査に出す拡張とバイト単位で同じになる。
- `manifest.json`：`incognito` を `not_allowed` にした（プライベートブラウジングのタブは拡張から見えない）。`data_collection_permissions` で `websiteContent` と `browsingActivity` を申告した（ページの内容・スクリーンショット・URL を手元のネイティブホストへ送り、そこから MCP クライアントへ渡る）。
- `filename` を指定して保存したスクリーンショットも、ほかと同じく `FOX_SCREENSHOT_RETENTION_DAYS`（既定 30 日）を過ぎたら削除するようにした。ネイティブホストはその名前をスクリーンショットのディレクトリの `.named-screenshots` に記録し、ディレクトリにあるほかのファイルは削除しない。
- README：権限の節を設け、拡張の 9 つの権限それぞれの用途と使用箇所を書いた（`cookies` は Cookie を読まない。コンテナでタブを開くのに Firefox が求める）。エージェントが Firefox のコンテナを作成できることも書いた。

### セキュリティ

- 値を `[MASKED]` で伏せる欄を広げた（拡張機能とヘッドレスの両方）。パスワード欄に加えて、`type="hidden"` の欄と、`autocomplete` が `one-time-code`・`cc-number`・`cc-csc`・`cc-exp`・`cc-exp-month`・`cc-exp-year` の欄（`current-password`・`new-password` は従来どおり）。`allow_password_typing` は従来どおりパスワード欄への入力を許すだけで、伏せ字は解かない。
- `FOX_HOST` がループバックのアドレス（127.0.0.0/8、`::1`、`localhost`）でなければ daemon は起動しないようにした。従来は警告をログに出して、平文の HTTP・WebSocket をネットワークに開いていた。
- ホストの無いページ（`view-source:`、`blob:`、`data:` など。`about:` と `file:` は除く）にあるタブでは、ページを操作するツールを拒否するようにした。こうしたページには `safety.json` のどの URL パターンも一致しない。読み取るツールは動く。
- 引数 `urlPattern` が 256 文字を超えるとき、または繰り返す括弧の中に繰り返しがあるとき（`(a+)+` など）は、コンパイルする前に拒否するようにした（daemon と拡張機能の両方で）。1 つのパターンで拡張機能のバックグラウンドページが止まらないようにするため。
