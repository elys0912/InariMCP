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
- ツールバーのポップアップから常に許可の画面を開けるようにした。許可した後は、一時停止スイッチの下の「許可を取り消す」で開き、そこで「許可しない」を押すと、拡張機能はその場で接続を切る。
- `npm run smoke:reviewer`（`scripts/e2e/reviewer-smoke.mjs`）と [docs/amo/reviewer-smoke.md](amo/reviewer-smoke.md)（英語）：127.0.0.1 のテストページで基本機能（タブ、タブを開く、マスク付きの読み取り、検索、スクリーンショット、クリック、タブを閉じる。操作はポップアップで 1 回ずつ承認する）を試す smoke テスト。Claude Code・アカウント・インターネット接続は要らない。`-- --headless` で拡張機能なしでも動くが、誰も承認できないので、動くのはタブの一覧だけ。`scripts/e2e/tools-smoke.mjs` も example.com の代わりに同じテストページを使う。
- ESLint（推奨のルールと、警告にする複雑度のルール。complexity、max-depth、max-params、max-nested-callbacks、max-lines-per-function）。提出の前に `npm run lint:install` と `npm run lint` で実行する。lint だけ `tools/lint` の TypeScript 6 で動く（typescript-eslint のピア依存のため）。ビルドは TypeScript 7 のまま。エラーがあると `npm run lint` は失敗する。警告では失敗しない。
- 拡張のパッケージに `dist/LICENSE` を入れた。リポジトリの `LICENSE`（Inari MCP for Firefox と、その元になったプロジェクトの MIT の表示）の写し。

### 変更

- KitsuneMCP から Inari MCP for Firefox に改名。アドオン ID `inari-mcp@elys0912.github.io`、ホストのマニフェスト `inari_mcp`、状態ディレクトリ `~/.inari-mcp`、npm パッケージ `@inari-mcp/*`。
- リポジトリの改行を `.gitattributes` で LF に固定した。どの OS でビルドしても、審査に出す拡張とバイト単位で同じになる。
- `manifest.json`：`incognito` を `not_allowed` にした（プライベートブラウジングのタブは拡張から見えない）。`data_collection_permissions` で `websiteContent`・`browsingActivity`・`websiteActivity` を申告した（ページの内容・フォームの値・スクリーンショット・URL を手元のネイティブホストへ送り、そこから MCP クライアントへ渡る。拡張機能は承認されたクリックや入力をページで行う）。
- `for: "network_idle"` の `fox_wait`：ページの `fetch` と `XMLHttpRequest.prototype.send` に入れる計数用のフックを、待ちの開始で入れ、待ちの終了で外すようにした（以前はページを閉じるまで残っていた）。フックはリクエストを数えるだけで、中身は何も記録しない。呼び出した時点で続いているリクエストは見えない。
- `filename` を指定して保存したスクリーンショットも、ほかと同じく `FOX_SCREENSHOT_RETENTION_DAYS`（既定 30 日）を過ぎたら削除するようにした。ネイティブホストはその名前をスクリーンショットのディレクトリの `.named-screenshots` に記録し、ディレクトリにあるほかのファイルは削除しない。
- README：インストールを addons.mozilla.org から始める形にした（1. AMO から拡張機能、2. ネイティブホスト、3. MCP クライアントへの登録）。冒頭に送るものと要るものを書いた。「WIP」「AMO 掲載は予定なし」「GitHub Releases の unlisted の .xpi を入れる」の記述を外した。プライバシー・関連リンクの節を足した（権限の節は「追加」を参照）。
- 既定のポートを KitsuneMCP の `8765` / `8766` から `8785`（HTTP）/ `8786`（WebSocket）に変えた。Inari MCP と KitsuneMCP を同時に動かせる。`FOX_HTTP_PORT` / `FOX_WS_PORT` で変えられるのは従来どおり。
- Inari MCP の実行に要る Node.js を 20 以上にした（`engines`、インストーラ、`--doctor`）。審査の再現ビルドは Node.js 24.x と npm 11.x。
- 一時停止中の拒否は、ブラウザのエラーではなく安全上の拒否として MCP クライアントに返す（`decision: "paused"`、文言は `paused:` で始まる）。
- 拡張機能の説明文とポップアップの末尾を「Inari MCP for Firefox」の名前にした。末尾には、ページの内容が手元の PC のネイティブホストを経て MCP クライアントへ渡ることを書いた。
- ツールバーのボタン、ポップアップ、バッジの説明、コンテキストメニューの名前を短い名前「Inari MCP」にそろえた（以前は「InariMCP」）。承認の確認文とツールの結果の承認の説明も同じ名前にした。承認と CAPTCHA の通知とポップアップは、要求元を「Claude」ではなく「MCP クライアント」と書く。
- 許可の画面に、送るものをすべて書いた：ページの内容（入力欄の値を含む。パスワードなどの欄は伏せる）、スクリーンショット、URL、タブの一覧、コンテナの名前。プライバシーポリシーのリンクは、Firefox の言語が日本語なら日本語版を開く。ポップアップの一時停止の説明に、実行中の命令も中断することを書いた。
- コンテキストメニューの「Inari MCP でスクリーンショットを撮る」は、接続を許可している間だけ出るようにした。以前は許可の前と拒否の後にも出て、撮った画像はどこにも渡らなかった。許可していても Native Host に接続していないときは、送れなかったことを OS の通知で知らせる。
- コンテンツスクリプトはページの最上位のフレームでだけ動くようにした（`all_frames: false`。ほかのフレームに届くツールは無かった）。読み込み時のログも出さない。ページにスタイルシートを入れるのをやめた：`action: "highlight"` の `fox_interact` の枠は要素そのものに見た目を付けるので、ページがアドオンのクラス名やキーフレーム名を探せない。
- プライバシーポリシー、掲載用の素材、審査者向けのメモ：承認を求める呼び出しと求めない呼び出し、スクリーンショットは伏せないこと、ヘッドレスのスクリーンショットは自動では消えないこと、ポップアップの「スクリーンショット」「ページ情報」が残すもの、`for: "network_idle"` の `fox_wait` がページの `fetch` / XHR をどう包むか、MCP クライアントのダイアログで承認するときのリスク、`cookies` の権限が要る理由を書いた。掲載用の素材と審査者向けのメモは、その版のタグのプライバシーポリシーを指す。
- BUILD.md：バンドルは 4 本（`dist/consent/consent.js` を含む）、shared の入口は 5 つ（`approval-site.ts` を含む）、zip に `dist/LICENSE` が入る。提出物との比較では、AMO の署名で足される `META-INF/` フォルダを除く。
- 操作系のツールは、どのサイトでも実行の前に人に尋ねるようにした：`fox_click`、`fox_type`、`fox_press_key`、`fox_set_value`、`fox_navigate`、`fox_tab` の create / close（コンテナの有無を問わない）、`fox_handle_dialog`、`fox_interact` の hover（ページ自身のホバーのハンドラを動かすため。読み取り専用モードでは拒否する）。1 回の承認で許可されるのは、そのサイトでの、その引数による、そのツールの 1 回の呼び出しだけで、操作を続けると 1 回ずつ尋ねる。読み取り・待機・UI だけのツール（`fox_read`、`fox_find`、`fox_screenshot`、`fox_tabs`、`fox_wait`、`fox_interact` の scroll / highlight、`fox_tab` の switch など）は尋ねずに動く。対象タブのページを daemon がまだ見ていないときは、`fox_tabs` を呼ぶまで操作系の呼び出しを承認できない。
- Firefox の拡張機能も、タブ（または開く URL）のサイトについて承認されていない操作系のコマンドを、daemon が何を送ってきても拒否するようにした。
- 承認の確認（MCP elicitation とツールバーのポップアップ）を、保護対象サイトの名前ではなく、ツール・サイト・引数を示して「この操作を許可しますか」と尋ねる形にした。
- `fox_safety_status` は `confirmProtectedActions` と `protectedUrlPatterns` の代わりに、`approvalPolicy`（どの呼び出しで尋ねるか）と `confirmReadSites` を返す。
- 一度だけ使える承認のトークンの接頭辞を `kat_` から `iat_`（Inari approval token）にした。
- `scope: "all_tabs"` の `fox_screenshot` は、`confirm_read_sites` のサイトで除いたタブの理由を `excludedReason` ではなく `excludedReadSitesReason` で返す（`excludedReadSites`、`excludedBlockedReason` と並ぶ名前）。
- `fox_navigate` の `action: "back"`・`"forward"`・`"refresh"` に `newTab: true` を付けたときは、今のタブを操作するものとして、そのタブのサイトについて承認を求めるようにした（従来は新しい空のタブ `about:` について尋ねていた）。
- `scope: "scroll_capture"` の `fox_screenshot` で、`maxScrolls` は 50 まで、`delay` は 2000 ms までにし、拡張機能は合計 25 秒に収まる段数までにした。
- 一時停止のスイッチは、実行中の命令も止める：MCP クライアントにはすぐ `paused` の拒否が返り、ページでの入力・待ち・`scroll_capture` は次の段で止まる。
- 起動時に保存した一時停止の状態を読めなかったときは、一時停止した状態で始める。スイッチを保存できなかったときは、ポップアップにそう出る（その切り替えは Firefox を再起動するまで有効）。
- `fox_request_approval`：ポップアップで同時に待てる質問を 3 件までにし、それを超えた質問はすぐ拒否する。ポップアップはツールの呼び出しの承認を質問より先に出す。

### 削除

- スクリプト系ツール `fox_evaluate` と `fox_observer`（以前の名前 `fox_execute_script`、`fox_eval_chain`、`fox_wait_and_act`、`fox_inject_observer`、`fox_remove_observer`）を、拡張機能とヘッドレスモードの両方から削除した。拡張機能は文字列で渡されたコードを実行しない（`code` を指定した `tabs.executeScript` を使わない）。
- ログ収集のツール `fox_logging` と `fox_get_logs`（以前の名前 `fox_start_logging`、`fox_stop_logging`、`fox_clear_logs`、`fox_get_console_logs`、`fox_get_network_logs`）を削除した。拡張機能はページのコンソールのメッセージや fetch / XHR の通信を記録しない。
- `safety.json` の `allow_script_execution` と、環境変数 `FOX_ALLOW_SCRIPTS` / `CLAUDE_BROWSER_ALLOW_SCRIPTS` を削除した。このキーが残った `safety.json` は、知らないキーとして、キーを消すまで使えない。
- `FOX_CAPS` のプロファイル `logs` と `script` を削除した（知らないプロファイル名は警告を出して無視する）。
- コンテキストメニューの「InariMCP で要素を調べる」を削除した。結果をどこにも渡していなかった。
- 保護対象サイトの一覧を削除した：`safety.json` の `protected_url_patterns`（既定の 16 件：銀行などの金融・決済のサービス、`.gov`、患者ポータル）と `confirm_protected_actions`。代わりに操作系ツールはどのサイトでも尋ねる。読み取りとスクリーンショットでも尋ねたいサイトは、新しい `confirm_read_sites`（既定は空）に書く。どちらかのキーが残った `safety.json` は、知らないキーとして、キーを消すまで使えない。
- どのツールも送らないブラウザコマンド `get_tab_info`、`find_tabs`、`get_value`、`reload_all`、`reload_by_url`、`wait_for_change`、`click_and_wait` を削除した。拡張機能もヘッドレスのバックエンドもこれらを処理しない。
- KitsuneMCP の以前のツール名の互換層を削除した：`FOX_CAPS=legacy`（説明が `[Deprecated: …]` で始まる一覧）、ツールでなくなった以前の 20 個の名前（`fox_get_text`、`fox_create_tab`、`fox_wait_for_url` など。`POST /mcp/call` でも知らないツールとして拒否する）、最初の呼び出しに付けた注記、監査ログの `legacyTool`。代わりに 17 個のツール（`fox_read`、`fox_tab`、`fox_wait` など）を呼ぶ。
- 実装されなかった `fox_run_workflow` と `fox_audit_page`、`FOX_CAPS` の空のプロファイル `workflow` を削除した（知らないプロファイル名として、警告を出して無視する）。
- フォーク元から引き継いだ環境変数 `CLAUDE_BROWSER_*`（`CLAUDE_BROWSER_HOST`、`CLAUDE_BROWSER_HTTP_PORT`、`CLAUDE_BROWSER_WS_PORT`、`CLAUDE_BROWSER_HEADLESS`、`CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT`、`CLAUDE_BROWSER_EXECUTABLE`、`CLAUDE_BROWSER_SCREENSHOTS_DIR`、`CLAUDE_BROWSER_READ_ONLY`、`CLAUDE_BROWSER_SAFETY_CONFIG`）を削除した。daemon、中継、Native Host、インストーラ、`--doctor` は `FOX_*` の名前だけを読む。どこからも読まれていなかった `FOX_PORT`、`FOX_DEBUG`、`FOX_CONTAINER` の定義も削除した。
- フォーク元から引き継いだその他の互換の経路を削除した：`safety.json` の URL のリストに正規表現だけを書いたもの（`paypal\.com`。これまではできればホストパターンとして読み、読めなければ URL のどこかに一致させた）は、どのリストでも設定エラーにする。ホストパターンか、URL 全体に一致させる `re:` で書く。ほかに、`POST /browser/command`（`POST /mcp/call` の別名）、`effectiveSettings` を返さない daemon の設定の読み方、平文のトークンを送る Native Host への案内の文を削除した。

### セキュリティ

- 値を `[MASKED]` で伏せる欄を広げた（拡張機能とヘッドレスの両方）。パスワード欄に加えて、`type="hidden"` の欄と、`autocomplete` が `one-time-code` か `cc-` で始まる欄（支払いカードの欄すべて。カード名義人の名前も含む。`current-password`・`new-password` は従来どおり）。伏せる `<select>` では、各 `<option>` の値とテキストも伏せる。`allow_password_typing` は従来どおりパスワード欄への入力を許すだけで、伏せ字は解かない。
- 読み取るツール（selector での `fox_find`、text の `fox_read`、要素を待つ `fox_wait`、scroll / highlight の `fox_interact`）は、`value` 属性か `selected` 属性を調べる CSS セレクタ（`[value^="a"]`、`option[selected]` など）と、`:checked` か `:default` を使うセレクタを、書き方によらず拒否する。1024 文字を超えるセレクタも拒否する。一致の数や待ちが終わるかどうかで、伏せた値を 1 文字ずつ当てられるため。ヘッドレスでは CSS だけを受け付け（`fox_snapshot` も同じ）、`xpath=`・`text=`・`role=`・`//`・`>>` などの Playwright のセレクタの書き方は拒否する。
- 拡張機能の text の `fox_find`（Firefox の検索）は、パスワード・ワンタイムコード・支払いカードの欄が表示されているタブでは拒否する。検索はフォームの欄の文字にも一致することがあり、一致の数で値を 1 文字ずつ当てられるため。拡張機能の読み取る命令は、要素を CSS セレクタだけで探す（XPath・text などのほかの指定は拒否する）。`fox_interact` の select_option は、伏せる対象の `<select>` では選んだ値と文字を `[MASKED]` で返す（ヘッドレスで一致が無いときに返す option の一覧も同じ）。
- 要素を待つ `fox_wait` と `fox_interact`（hover、highlight、`toElement` の scroll）は、要素のタグ・生成したセレクタ・位置だけを返し、テキスト・値・リンク・画像のアドレスは返さないようにした。これらは読み取りではないので `confirm_read_sites` が掛からず、そのサイトのページを尋ねずに読めたため。
- `confirm_read_sites` を設定しているとき、拡張機能が URL を読めないタブの読み取りは、許可ではなく拒否にした。`screenshot` の all_tabs もそのタブを飛ばす。`view-source:` とリーダー表示（`about:reader`）のタブは、表示しているページの URL で照合する。
- `FOX_HOST` がループバックのアドレス（127.0.0.0/8、`::1`、`localhost`）でなければ daemon は起動しないようにした。従来は警告をログに出して、平文の HTTP・WebSocket をネットワークに開いていた。Native Host と stdio の中継も、そのような `FOX_HOST` には接続せずに拒否する。`--doctor` は daemon に届かないと報告する。`127.999.0.1` のようにアドレスに見えるだけの名前は、ループバックとみなさない。
- 監査ログは、`text`・`value` などの伏せる引数を入れ子の object の中でも伏せる（`kind: "select"` の `fox_set_value` の `option`）。`fox_press_key` の `key` も伏せる。
- ホストの無いページ（`view-source:`、`blob:`、`data:` など。`about:` と `file:` は除く）にあるタブでは、ページを操作するツールを拒否するようにした。こうしたページには `safety.json` のどの URL パターンも一致しない。読み取るツールは動く。
- 引数 `urlPattern` を、次のときはコンパイルする前に拒否するようにした（daemon と拡張機能の両方で）。1 つのパターンで拡張機能のバックグラウンドページが止まらないようにするため。256 文字を超えるとき。繰り返す括弧（後ろに `*`・`+`・`{…}` が付く）の中に量指定子か `|` があるとき（`(a+)+`、`(a|aa)+`、`(a?){25}` など。`(a{3})+` も拒否するので `(?:aaa)+` と書く）。量指定子（`*`・`+`・`?`・`{n}`・`{n,m}`・`{n,}`）と `|` が合わせて 7 個を超えるとき。`{n,m}` の m が 32 を超えるとき。量指定子が URL を分ける仕方が多すぎるとき（上限の無い繰り返しを 6、`{n,m}` を log2(m − n + 1)、`?` と `|` を 1 と数え、合計 12 まで。`.*.*` は通り、`.*.*.*` は通らない）。文字クラスは JavaScript の規則で読む（`[]` と `[^]` は最初の `]` で閉じる）。`^https://example\.com/.*$`、`https://[^/]+\.example\.com/.*`、`(https?://)?(www\.)?example\.com/.*` のような普通のパターンは通る。
- ヘッドレスモードでも、拡張機能と同じように、コマンドを実行する直前に、実行するページで承認を確かめ直すようにした。操作系のコマンドは人が承認したサイトでだけ動き、`confirm_read_sites` のページの読み取りはそのサイトの承認があるときだけ動く。承認の後にページが別のサイトへ移っていた場合は、そのサイトについて改めて尋ねる。
- `safety.json` の `enabled: false` で、ヘッドレスモードの人の承認が止まらないようにした。操作系ツールは両方のバックエンドで常に先に尋ねる（`false` で止まるのは、URL の検査と URL の一覧、`confirm_read_sites`、`read_only`、`container_scope`、レート制限）。
- ヘッドレスの `fox_snapshot` で、伏せる対象の欄（パスワード、ワンタイムコード、カード番号など上に挙げたもの）の値を `[MASKED]` にし、伏せる対象の `<select>` で選んだ option に selected の印を付けないようにした。従来は Playwright のアクセシビリティツリーがこれらの値をそのまま出していた。
- URL の query と fragment にある秘密の値（`token`、`access_token`、`password` など）を、監査ログの `url` と、MCP クライアントが受け取る `details.approval` の `url` でも伏せるようにした（引数の `url` では従来から伏せていた）。Firefox の承認のポップアップには URL 全体を出す。
- 拡張機能は、承認を確かめたときの origin（scheme・host・port）にタブがまだあるときだけ、承認済みの操作（`fox_click`、`fox_type`、`fox_press_key`、`fox_set_value` など）をページで実行する。その間にタブが別のページへ移っていたら拒否し、今のページについて改めて承認を求める。
