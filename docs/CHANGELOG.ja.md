# 変更履歴

[English](./CHANGELOG.md) | **日本語**

Inari MCP for Firefox の利用者に見える変更。新しいものが上。

Inari MCP for Firefox は 2026-10-14 に [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0（コミット b2642a9）の写しとして始めた。addons.mozilla.org への掲載に向けて整えた版で、アドオンの ID、ネイティブメッセージングのホスト名（`inari_mcp`）、状態ディレクトリ（`~/.inari-mcp`）が KitsuneMCP と異なるため、両方を同じ Firefox に入れられる。分岐前の履歴は KitsuneMCP の変更履歴を参照。

## Unreleased (0.1.0)

### 追加

- 初回の許可の画面：インストールの直後に、Inari MCP for Firefox の接続を許可するかをタブで尋ねる（何をするか、何を送るか、何が必要か、プライバシーポリシー）。許可するまで Native Host に接続しない。それまでバッジに「未許可」が出て、ポップアップから画面を開き直せる。回答を覚えるために `storage` の権限を使う。
- ツールバーのポップアップに一時停止のスイッチ：オンの間は MCP クライアントからの命令をすべて `paused` で始まるエラーで拒否し、待っている承認の要求を取り下げ、バッジに「停止」が出る。
- MCP クライアントの命令を処理している間、バッジに `●` が出る。バッジの状態の優先順を 1 つに決めた：未許可、一時停止、承認待ちの数、処理中、セットアップの状態。
- README：権限の節を設け、拡張の 10 の権限それぞれの用途と使用箇所を書いた（`cookies` は Cookie を読まない。コンテナでタブを開くのに Firefox が求める）。エージェントが Firefox のコンテナを作成できることも書いた。
- addons.mozilla.org 向けのリリース用の仕組み。`npm run pack:ext` は拡張の zip を作り、中の全ファイルの SHA-256 を書き、`web-ext lint` を実行する（エラー 0・警告 0 が条件）。`npm run pack:source` はコミット済みのファイルからソースの zip を作る。[`docs/BUILD.md`](./BUILD.md)（英語）は、審査者が拡張を再ビルドして提出物と比べる手順（Node.js 24、npm 11）。GitHub Actions のワークフローが Ubuntu 24.04 ARM64 でビルド・型検査・テストを行う。
- プライバシーポリシー：[docs/PRIVACY.ja.md](./PRIVACY.ja.md)（[English](./PRIVACY.md)）。読み取って送るもの、送り先、手元に残るものと期間、消し方、同意と制御、プライベートブラウジング。
- addons.mozilla.org の掲載用の素材（[docs/amo/listing.md](./amo/listing.md)）と、審査者向けのメモ（[docs/amo/reviewer-notes.md](./amo/reviewer-notes.md)）。

### 変更

- KitsuneMCP から Inari MCP for Firefox に改名。アドオン ID `inari-mcp@elys0912.github.io`、ホストのマニフェスト `inari_mcp`、状態ディレクトリ `~/.inari-mcp`、npm パッケージ `@inari-mcp/*`。
- リポジトリの改行を `.gitattributes` で LF に固定した。どの OS でビルドしても、審査に出す拡張とバイト単位で同じになる。
- `manifest.json`：`incognito` を `not_allowed` にした（プライベートブラウジングのタブは拡張から見えない）。`data_collection_permissions` で `websiteContent` と `browsingActivity` を申告した（ページの内容・スクリーンショット・URL を手元のネイティブホストへ送り、そこから MCP クライアントへ渡る）。
- `for: "network_idle"` の `fox_wait`：ページの `fetch` と `XMLHttpRequest.prototype.send` に入れる計数用のフックを、待ちの開始で入れ、待ちの終了で外すようにした（以前はページを閉じるまで残っていた）。フックはリクエストを数えるだけで、中身は何も記録しない。呼び出した時点で続いているリクエストは見えない。
- `filename` を指定して保存したスクリーンショットも、ほかと同じく `FOX_SCREENSHOT_RETENTION_DAYS`（既定 30 日）を過ぎたら削除するようにした。ネイティブホストはその名前をスクリーンショットのディレクトリの `.named-screenshots` に記録し、ディレクトリにあるほかのファイルは削除しない。
- README：インストールを addons.mozilla.org から始める形にした（1. AMO から拡張機能、2. ネイティブホスト、3. MCP クライアントへの登録）。冒頭に送るものと要るものを書いた。「WIP」「AMO 掲載は予定なし」「GitHub Releases の unlisted の .xpi を入れる」の記述を外した。プライバシー・関連リンクの節を足した（権限の節は「追加」を参照）。
- 既定のポートを KitsuneMCP の `8765` / `8766` から `8785`（HTTP）/ `8786`（WebSocket）に変えた。Inari MCP と KitsuneMCP を同時に動かせる。`FOX_HTTP_PORT` / `FOX_WS_PORT` で変えられるのは従来どおり。
- Inari MCP の実行に要る Node.js を 20 以上にした（`engines`、インストーラ、`--doctor`）。審査の再現ビルドは Node.js 24.x と npm 11.x。
- 一時停止中の拒否は、ブラウザのエラーではなく安全上の拒否として MCP クライアントに返す（`decision: "paused"`、文言は `paused:` で始まる）。
- 拡張機能の説明文とポップアップの末尾を「Inari MCP for Firefox」の名前にし、ページの内容は手元の PC のネイティブホストにだけ送ることを書いた。

### 削除

- スクリプト系ツール `fox_evaluate` と `fox_observer`（以前の名前 `fox_execute_script`、`fox_eval_chain`、`fox_wait_and_act`、`fox_inject_observer`、`fox_remove_observer`）を、拡張機能とヘッドレスモードの両方から削除した。拡張機能は文字列で渡されたコードを実行しない（`code` を指定した `tabs.executeScript` を使わない）。
- ログ収集のツール `fox_logging` と `fox_get_logs`（以前の名前 `fox_start_logging`、`fox_stop_logging`、`fox_clear_logs`、`fox_get_console_logs`、`fox_get_network_logs`）を削除した。拡張機能はページのコンソールのメッセージや fetch / XHR の通信を記録しない。
- `safety.json` の `allow_script_execution` と、環境変数 `FOX_ALLOW_SCRIPTS` / `CLAUDE_BROWSER_ALLOW_SCRIPTS` を削除した。このキーが残った `safety.json` は、知らないキーとして、キーを消すまで使えない。
- `FOX_CAPS` のプロファイル `logs` と `script` を削除した（知らないプロファイル名は警告を出して無視する）。
- コンテキストメニューの「InariMCP で要素を調べる」を削除した。結果をどこにも渡していなかった。

### セキュリティ

- 値を `[MASKED]` で伏せる欄を広げた（拡張機能とヘッドレスの両方）。パスワード欄に加えて、`type="hidden"` の欄と、`autocomplete` が `one-time-code`・`cc-number`・`cc-csc`・`cc-exp`・`cc-exp-month`・`cc-exp-year` の欄（`current-password`・`new-password` は従来どおり）。`allow_password_typing` は従来どおりパスワード欄への入力を許すだけで、伏せ字は解かない。
- `FOX_HOST` がループバックのアドレス（127.0.0.0/8、`::1`、`localhost`）でなければ daemon は起動しないようにした。従来は警告をログに出して、平文の HTTP・WebSocket をネットワークに開いていた。
- ホストの無いページ（`view-source:`、`blob:`、`data:` など。`about:` と `file:` は除く）にあるタブでは、ページを操作するツールを拒否するようにした。こうしたページには `safety.json` のどの URL パターンも一致しない。読み取るツールは動く。
- 引数 `urlPattern` が 256 文字を超えるとき、または繰り返す括弧の中に繰り返しがあるとき（`(a+)+` など）は、コンパイルする前に拒否するようにした（daemon と拡張機能の両方で）。1 つのパターンで拡張機能のバックグラウンドページが止まらないようにするため。
