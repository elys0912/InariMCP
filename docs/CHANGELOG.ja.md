# 変更履歴

[English](./CHANGELOG.md) | **日本語**

KitsuneMCPの利用者向けの変更を新しい順に記す。括弧内はコミットのハッシュ。

## Unreleased

0.1.4からの変更。更新の前に**互換性のない変更**を読み、READMEの[更新](../README.ja.md#更新)の手順に従うこと。

### セキュリティ

- **`safety.json`の未知のキーは設定エラーにする**: 綴りの誤りや存在しないキー（`readonly`、`allow_scripts`、`container_scope`の中の未知のキー）は、これまで何も言わずに捨てられ、ポリシーを締めるつもりの設定が効いていなかった。今後は他の壊れた設定と同じくすべてのツールを拒否し、エラー（`daemon.log`、`fox_safety_status`、`--doctor`）にそのキーを示す。互換性のない変更を参照（4fcbc9f）
- **URLパターンは解析したURLで照合し、拡張機能も同じ方法で判定する**: `safety.json`のパターンは、解析したURLのホスト（とサブドメイン）・パス・スキームと比べる。`example.com.attacker.net`や、ホスト名を含むクエリ文字列には一致しなくなった。ユーザー名やパスワードを含むURLは拒否し、最終的なURL（リダイレクトやクリックの後）がブロック対象になった結果は返さない。更新したら`fox_safety_status`でリストを確認すること（db0e662、b1ebced、9f5a61d、f8d6496）
- **壊れた`safety.json`ではすべてのツールを拒否する（fail-closed）**: ファイルが読めない、JSONとして正しくない、値の型が違う、使えないURLパターンがある場合、`enabled: false`でも`fox_safety_status`以外のすべてのツールを拒否する。ファイルを直してdaemonを再起動し、`fox_safety_status`で確認すること（db0e662）
- **人による承認をページの外へ移し、1回限りの承認トークンにした**: 保護対象サイトでの操作は、Claude Codeの確認ダイアログ（MCP elicitation）かツールバーのポップアップで承認する。ページ内のボタン、`fox_click`、`fox_execute_script`では承認できない。1回の承認が許すのは、そのホストでのそのツールの、引数が完全に一致する1回の呼び出しだけで、トークンは中継だけが見る（282ec53、bb005ba）
- **daemonとNative Host / 中継をHMACで相互認証する**: APIトークンを送らなくなった。双方がHMACのチャレンジ応答でトークンを持つことを証明するので、ポートを乗っ取ったプログラムはdaemonになりすませない。起動したdaemonは、ポートが使用中なら相手の証明を確かめ、同じトークンを持つKitsuneMCPのdaemonでなければエラーで終了する（1de3ecf、4d2b712）
- **`re:`のURLパターンはURL全体に一致しなければならない**: `^(?:<正規表現>)$`として扱うので、`allowed_url_patterns`の`re:example\.com`は`https://example.com.attacker.net/`を通さなくなった。既存のパターンは「互換性のない変更」を参照（a015fa5）
- **URLパターンでIPv6リテラルと`host:port`を使える**: `[::1]`はホストとして読む（以前は`:`を含むすべてのURLに一致していた）。`example.com:8443`はそのポートだけに一致する。解釈できないIPv6アドレス、不正なポート、IPアドレスへの`*.`は設定エラーになる（7ba27cf）
- **未認証の接続と遅いリクエストbodyに上限を設けた**: 認証を待つWebSocket接続は最大8本（それぞれ5秒、認証フレームまで64 KB）で、拒否した接続は切断する。HTTPのリクエストbodyは30秒以内に届かなければならない（146fc2d、2fe3e69）
- **iframeが結果を偽装できない**: ページへのコマンドはトップフレームだけに送るので、ページ内のフレームが代わりに応答することはない（47d43c6）
- **結果と監査ログでマスクする秘密情報を広げた**: 認証系のヘッダとキー（`x-api-key`、`proxy-authorization`、`accessToken`など）、Basic認証の値、クエリ文字列・フォーム・JSONの`token=` / `password=`、URLのフラグメントをマスクする。結果からは不可視文字と双方向制御文字を取り除く（0f0ad33、b1ebced）
- **`container_scope.container_name`が空文字なら設定エラーにする**: `safety.json`の`"container_name": ""`は、これまで何も言わずにコンテナスコープを無効にしていた。今後は他の壊れた設定と同じく、すべてのツールを拒否する（`fox_safety_status`に表示される）。スコープが有効かどうかは問わない。コンテナに名前を付けること（3bb171d）
- **拡張機能は、使えない安全メタデータの付いたコマンドを拒否する**: MCP Serverが付けたコンテナスコープやURLルールの項目（protected / blocked / allowed）が不正な形（配列でない、コンテナ名が空など）のとき、その検査を飛ばして実行するのをやめ、`config_error`で拒否する。拡張機能とMCP Serverの版が合っていないときにだけ起きるので、両方を更新すること（3bb171d、f1db501）
- **パスに`?`や`#`を含むURLパターンは設定エラーにする**: パターンはURLのパスだけと比べるので、`example.com/a?x=1`や`example.com/a#top`は何にも一致せず、`blocked_url_patterns` / `protected_url_patterns`に書いても警告なしで何も止めなかった。このようなパターン（`%3F` / `%23`を含むものも）は、どのリストでもエラーになる。クエリやフラグメントを外すか、`re:`で書くこと（f1db501）
- **Native Hostから届くコマンドはwire上のaction名に限る**: Native Messaging経由で内部のaction名が届いたら`Unknown action`を返す（拡張機能自身のポップアップは引き続き内部名を使う）（d32eefb）
- **コマンドのデータが拡張機能の検査したactionを置き換えられない**: 拡張機能はページへのメッセージを、検査したactionを最後に置いて組み立てる。コマンドの引数に`action`キーがあっても、実行するページ側のコマンドは変わらない（469b88e）

### 互換性のない変更

- **未知のキーがある`safety.json`ではすべてのツールを拒否する**: 更新したら`--doctor`（`safety-config`）か`fox_safety_status`でファイルを確認し、示されたキーを直すか消すこと。既知のキーのcamelCase表記（`readOnly`）は引き続き使える（4fcbc9f）
- **ページ内の承認バナーを廃止した**: 承認待ちはKitsuneMCPのツールバーボタンに琥珀色の件数として出る（OSの通知も出る）。ポップアップを開いて承認または拒否する。クライアントがMCP elicitationに対応していれば、Claude Codeの確認ダイアログが先に使われる。ポップアップを使えるように、更新後は拡張機能を再読み込みすること（bb005ba、282ec53）
- **`re:`のパターンは前方一致しなくなった**: `re:^https://example\.com/`のようなパターンは、それより長いURLに一致しなくなり、警告も出ない。`allowed_url_patterns`ではそのURLが拒否され、ブロック・保護対象のリストではブロック・保護の対象から外れる。前方一致のままにするには末尾に`.*`を付け（`re:^https://example\.com/.*`）、daemonを再起動してから`fox_safety_status`で確認すること（a015fa5）
- **`allowed_url_patterns`の旧形式の正規表現は設定エラーになる**: 単純なもの（`paypal\.com`、`^https://a\.example/`）はホストパターンとして読む。それ以外があると`safety.json`が使えなくなる（すべてのツールを拒否する）。ホストパターンか`re:`に書き直すこと。ブロック・保護対象のリストでは、そのようなパターンは警告付きで以前の意味のまま使われる（db0e662、b1ebced）
- **古い版のdaemonは止める必要がある**: daemon・中継・Native HostはHMACで認証し合い、protocolの版を確かめるようになった。古いNative Hostの平文トークンは拒否する。中継やNative Hostが、動いているdaemonについて「speaks protocol …」「is from another version」と報告したら、そのdaemonのプロセスを止め（Native Hostが起動したものならFirefoxも再起動する）、拡張機能を再読み込みする。次のツール呼び出しで対応する版のdaemonが起動する（1de3ecf、7ba27cf）
- **`install.ps1` / `install.sh` / `uninstall.ps1` / `uninstall.sh`を`npm run setup` / `npm run teardown`に置き換えた**: Node.jsのインストーラはPowerShellが不要で、指定しなければビルドしない。`npm ci`、`npm run build`、`npm run setup`の順に実行する（または`npm run setup -- --build`）。`npm run install:*` / `uninstall:*`は別名として残る。手作業で設定する場合、マニフェストのテンプレートは`packages/native-host/kitsune_mcp.json`になり、`run-host.cmd` / `run-host.sh`はリポジトリから無くなった。手順は`node scripts/install.mjs --manual`が表示する（5b8645f、fae166b）
- **`FOX_HEADLESS`が有効になるのは`1`・`true`・`yes`だけ**: 以前は`FOX_HEADLESS=0`や`false`でもヘッドレスモードになっていた。拡張機能経路を使うなら変数を消すか`0`にする。`FOX_READ_ONLY`は`true` / `yes`も、`FOX_ALLOW_SCRIPTS`は`false` / `no` / `off`も受け付けるようになった（2e9ab03、dcf7bfa）
- **`fox_type`は`text`で要素を探さなくなり、`pressEnter`でフォームを送信する**: 入力する文字列をロケータには使わない。`selector`、`xpath`、`placeholder`、`name`、`id`のいずれかを渡すか、省略してフォーカス中の要素に入力する。`pressEnter`（と`fox_press_key`のEnter）は実際のEnterと同じようにフォームを送信する（47d43c6）
- **ヘッドレスの`fox_snapshot`と`fox_scroll`が変わった**: `fox_snapshot`はbase64のスクリーンショットではなく、アクセシビリティツリーをYAMLテキストで返す（`maxDepth`、`includeText`、`roles`が効く）。画像が要るなら`fox_screenshot`を使う。`fox_scroll`は常に300 px下へスクロールするのをやめ、`direction`、`amount`、`selector`、`toElement`に従う（208cb30）
- **ツールの分類をツールのスキーマから導くようにした**: `fox_remove_observer`はスクリプト系のツールになり、スクリプト実行が無効なら拒否される。`fox_hover`、`fox_scroll`、`fox_highlight`、`fox_switch_tab`は分類`interact`になり、読み取り専用モードでも、保護対象サイトでも承認なしで動き、`readOnlyHint`は`false`になる（7febaa5）
- **全パッケージが版0.1.4を名乗る**: 以前は拡張機能が0.1.4で、daemon・中継・Native Hostは0.1.0を名乗っていた。すべての`package.json`とマニフェストが同じ版になり、`--doctor`がそれを確かめる。すべての部分を一緒に更新すること（c9cbd41）
- **41個のツールを21個にまとめ、セッションは新しい名前を一覧にする**: 以前のツール名を書いたプロンプトや設定は、新しい名前にするか`FOX_CAPS=legacy`にする必要がある。以前の名前は呼び出せば引き続き動く。[ツール名の統合（41 → 21）](#ツール名の統合41--21)を参照（59dee5c、00bca2b）

### ツール名の統合（41 → 21）

関連する操作を、モード引数（`mode`、`action`、`kind`などの判別キー）を持つ1つのツールにした。ブラウザ側は変わっておらず、新しいツールの呼び出しは以前のツールが実行していたものを実行する。詳細はREADMEの[ツール名の移行](../README.ja.md#ツール名の移行)（93054cc、00bca2b、59dee5c、7713270、c4bd216）。

- **既定の`tools/list`は新しい21個のツールを一覧にする**: `FOX_CAPS`が未設定でも、`all`やプロファイルを指定しても、セッションは新しい名前を一覧にする。`FOX_CAPS=legacy`（単独、または他のプロファイルと一緒に: `legacy,core`）は、代わりに以前の41個のツールとその以前のプロファイルを一覧にする。置き換わった28個と削除予定の2個は、説明が`[Deprecated: …]`で始まる。`fox_safety_status`は常に一覧に入る（59dee5c、93054cc）
- **以前の名前は引き続き使える**: daemonは`FOX_CAPS`の設定に関係なく両方の名前を受け付け、HTTP（`POST /mcp/call`）でも使える。プロセスの中で以前の名前ごとに最初の呼び出しだけ、結果の末尾に置き換え先を示す`Note:`（`fox_get_text is deprecated; use fox_read with mode='text'.`）が付き、同じ内容をstderr（`daemon.log`）に書く。同じ名前の2回目以降には付かない（00bca2b）
- **監査ログは新しい名前で記録する**: 以前の名前での呼び出しは、`tool`に新しい名前、`legacyTool`に以前の名前を入れて記録する（93054cc）
- **承認は呼び出した名前に結び付く**: 承認の要求とトークンの照合は、呼び出した名前と呼び出しの引数のハッシュを使う。承認された呼び出しと同じ名前と引数で再試行すること（93054cc）
- **ツールの結果をcompactなJSONにした**: 成功時の結果、`fox_snapshot`のメタ情報、`fox_safety_status`の結果を、インデント無しのJSONで返す（7713270）
- **メッセージは新しい名前を使う**: ツールの説明を短くし、承認の案内、ヘッドレスの警告、拡張機能のエラーは新しいツール名を示す（c4bd216）

| 以前のツール | 新しい呼び出し | 引数の変更 |
|---|---|---|
| `fox_get_page_info`、`fox_get_text` | `fox_read` `mode: "info"` / `"text"` | |
| `fox_get_elements`、`fox_find_text` | `fox_find` `by: "selector"` / `"text"` | `fox_find_text`: `query` → `text` |
| `fox_get_tabs`、`fox_list_containers` | `fox_tabs` `what: "tabs"` / `"containers"` | |
| `fox_create_tab`、`fox_open_in_container`、`fox_close_tab`、`fox_switch_tab` | `fox_tab` `action: "create"` / `"create"`（`container`付き） / `"close"` / `"switch"` | `fox_open_in_container`: `containerName` → `container.name`、`cookieStoreId` → `container.cookieStoreId`。`url`は必須 |
| `fox_select_option` | `fox_set_value` `kind: "select"`（`fox_set_value`自体は名前が変わらず、既定は`kind: "input"`） | `value` / `text` / `index` → `option: { value }` / `{ text }` / `{ index }`（どれか1つだけ） |
| `fox_hover`、`fox_scroll`、`fox_highlight` | `fox_interact` `action: "hover"` / `"scroll"` / `"highlight"` | |
| `fox_wait_for_element`、`fox_wait_for_network_idle`、`fox_wait_for_navigation`、`fox_wait_for_url` | `fox_wait` `for: "element"` / `"network_idle"` / `"navigation"` / `"url"` | `for: "url"`には`url`か`urlPattern`が要る |
| `fox_start_logging`、`fox_stop_logging`、`fox_clear_logs` | `fox_logging` `action: "start"` / `"stop"` / `"clear"` | |
| `fox_get_console_logs`、`fox_get_network_logs` | `fox_get_logs` `kind: "console"` / `"network"` | |
| `fox_execute_script`、`fox_eval_chain`、`fox_wait_and_act` | `fox_evaluate` `mode: "script"` / `"chain"` / `"wait_and_act"` | `wait_and_act`: `timeoutMs` → `timeout` |
| `fox_inject_observer`、`fox_remove_observer` | `fox_observer` `action: "inject"` / `"remove"` | |
| `fox_run_workflow`、`fox_audit_page`（削除予定） | なし | どのバックエンドでも未実装だった。名前での呼び出しは今もでき、同じエラーになる |

変更なし: `fox_screenshot`、`fox_snapshot`、`fox_navigate`、`fox_click`、`fox_type`、`fox_press_key`、`fox_set_value`、`fox_handle_dialog`、`fox_request_approval`、`fox_detect_captcha`、`fox_safety_status`。

### 追加

- **`--help`、`--version`、`--doctor`**: `node packages/mcp-server/dist/index.js --doctor`は14項目（ビルド、FirefoxとClaude Codeへの登録、daemon、トークン、ログなど）を読み取りだけで確認し、問題ごとに対処を表示する。FAILの項目があれば終了コード1で終わる。`native-messaging`が未登録ならWARN（終了コード0。拡張機能経路では必要だが、ヘッドレスだけなら不要）、壊れた登録（JSONとして不正、name・type・allowed extension・pathの不備）はFAILで、対処文は`npm run setup`を案内する。`--help` / `--version`はdaemon・トークン・ログを作る前に終わる。知らない引数は、中継として起動せずに終了コード2で終わるようになった（5afc516、0e06a30、7a4e61f）
- **`--stop-daemon`**: `node packages/mcp-server/dist/index.js --stop-daemon`は、動いているdaemonを署名付きの`POST /daemon/shutdown`で停止する。実行中のツール呼び出しは最大10秒まで完了を待ち（`--force`では待たない）、ヘッドレスのFirefoxを閉じ、Native Hostとの接続を切って（WebSocketのclose 1001）から終了する。`npm run teardown`とdoctorの対処文もこれを使う。アンインストーラがシグナルで止めるのは、APIトークンが無いかその要求が失敗した場合だけになった
- **`FOX_APPROVAL_ELICITATION`**: `0` / `false` / `off` / `no`にすると、保護対象サイトでの操作はFirefoxのポップアップでしか承認できなくなる（ヘッドレスモードでは承認できなくなる）。既定は有効（4a785bb）
- **`FOX_SCREENSHOT_RETENTION_DAYS`**（既定`30`）: Native Hostの起動のたびに、自動生成の名前で保存した、この日数より古いスクリーンショットを削除する。`0`ですべて残す。自分で指定した`filename`で保存したファイルは削除しない（69b1af9）
- **ログがリロードと遷移を跨いで残る**: コンソールとネットワークのログは拡張機能のbackgroundにタブごとに保持する（それぞれ最新500件）ので、`fox_get_console_logs` / `fox_get_network_logs`は遷移前の記録も返す（47d43c6）
- **`daemon.log`の時刻**: 各行は`native-host.log`と同じく`<ISO 8601の時刻> [<pid>] `で始まる（7b03a8f）
- **ヘッドレスモードは無視した引数を示す**: ヘッドレスのバックエンドが対応していない引数は、結果の`warnings`に並ぶ（失敗時は`error`に含める）（208cb30、59597b6）
- **`playwright`を任意の依存にした**: 中継と拡張機能経路のdaemonは`playwright`が無くても起動する。`FOX_HEADLESS`のdaemonは、無ければ導入方法を含むメッセージを出して終了する。`npm run build`には引き続き必要（1cf3974、2e9ab03）
- **E2Eのスモークテスト**: `npm run test:e2e`は一時的なホームディレクトリと空きポートで、中継 → daemon → ヘッドレスFirefoxをMCP経由で動かす。`npm run e2e:extension`は拡張機能がFirefoxに読み込まれるかを確かめる（2bd20a0）
- **`@kitsune-mcp/shared/node`**: daemon・中継・Native HostのNode.js向けの処理（パス、接続先、トークン、`/health`、ログ、daemonの起動、版、HMAC）を1つのサブパスにまとめた。パッケージのルートはブラウザでも使えるまま（9896141）

### 修正

- **設定と承認要求の文面**: `safety.json`の`container_scope`を一部だけ書いた場合（`container_name`だけ、`enabled`だけ）、残りは既定値になり、すべてのツールを拒否しなくなった。空白だけの`FOX_SAFETY_CONFIG` / `FOX_SCREENSHOTS_DIR`はdaemonと`--doctor`で未設定として扱い（旧名を読む）、相対パスの`FOX_SCREENSHOTS_DIR`はNative Hostと同じく絶対パスにする。承認要求の要約は絵文字を途中で切らない。単一ラベルのホストパターン（`intranet`）への警告を、`LOCALHOST`・`intranet/`・`intranet:8080`・`http://intranet`にも出す（4fcbc9f、c54bfe2、176858f、71aafd0）
- **Native Hostの起動**: daemonの起動中でも`ping`に応答する。Windowsでは必要ならPowerShellを使わずに（WMI、次に`schtasks`）Firefoxのジョブオブジェクトの外でdaemonを起動するので、Firefoxを閉じてもdaemonは止まらない。動いているdaemonが開いたままの`daemon.log`はcopy-truncateで回転する（82172be、c1521e9、6856992、099da45、69b1af9）
- **ヘッドレスのバックエンド**: `fox_select_option`は一致するoptionが無ければ`availableOptions`を付けて失敗する。`fox_handle_dialog`はほかのコマンドを止めなくなった（誰も待っていないダイアログは2秒後に閉じて報告する）。`FOX_HEADLESS_STARTUP_TIMEOUT`をFirefoxの起動に適用する（208cb30、36cb870、2e9ab03）
- **中継はdaemonを待たずに接続する**: Claude CodeのMCP接続はすぐに返り、最初のツール呼び出しがdaemonの起動を待つ（81294f6）
- **設定の差異は正規化してから比べる**: `true` / `1`や旧名 / 新名を同じものとして扱うので、同じ意味の値で「設定が違う」という警告は出なくなった。古いdaemonとの比較でも同じ（dcf7bfa、f6ad469）
- **`allow_password_typing`が拡張機能に届く**: パスワード欄の判定は、サーバー・拡張機能・ヘッドレスモードで1つの規則になり、`fox_set_value`、`xpath`、`autocomplete`の`current-password` / `new-password`も対象になる（4b070f5）
- **読み取り専用モードとレート制限が正しい呼び出しを数える**: 読み取り専用モードで`fox_switch_tab`と`fox_detect_captcha`を拒否しなくなった。拒否した呼び出しと`fox_safety_status`はレート制限の回数に入らない（7febaa5、354730c）
- **拡張機能のツールが失敗を報告する**: `fox_wait_for_network_idle`はタイムアウトで失敗し、`fox_select_option`は一致するoptionが無ければ失敗し、`fox_click` / `fox_type`は無効（disabled）な要素で失敗し、ページの読み込みがタイムアウトするかタブが閉じると失敗する。`fox_type`は`delay: 0`を受け付け、遅延の合計を10秒以内に収める（47d43c6）
- **スクリーンショット**: `all_tabs`の`fox_screenshot`には時間の予算があり、1つのタブも撮影・保存できなければ失敗する。`saveToFile: false`では撮影しない。既存の`filename`に保存すると`imageOverwritten`と警告が付く（47d43c6、e3cb939）
- **取り消した呼び出しはブラウザのコマンドも止める**: リクエストIDはdaemonの起動ごとに一意になり、ツール呼び出しを取り消すと待機中のブラウザのコマンドを失敗させる（4f2fb52）
- **拡張機能: タブのコマンドとNative Hostとの接続を安定させた**: 複数タブの一括再読み込み（拡張機能の`reload_all` / `reload_by_url`コマンド）は、1つのタブが失敗してもすべてのタブを再読み込みし、失敗したタブを`reloaded: false`・`error`・`failedCount`で報告する。1つも再読み込みできなかったときだけ失敗する。`fox_wait`の`for: "navigation"`は、ページの読み込み直後にタブが閉じても成功する。`fox_tabs`の`limit`が0以下なら既定値（50）を使い、`fox_find`の`by: "text"`は`text`が空なら分かりやすいエラーで失敗する。送信に失敗した後、古い接続の切断通知が遅れて届いても新しい接続を捨てなくなった。古いセットアップ確認の結果がツールバーのバッジに古い「!」を出すこともなくなった（eddccfd、bd09818）
- **拡張機能のポップアップと承認**: バックグラウンドが応答しないとき、ポップアップは「Connecting...」のままにせず理由付きのエラーを表示する。現在のタブを読めなくてもボタンと承認一覧は動く。承認した操作は、末尾にドットを付けて書いたホスト（`example.com.`）でも受け付ける。承認要求・通知・ログの長い文字列は絵文字を割らずに切り詰める（bd09818）
- **`fox_interact`の`highlight`は新しい強調表示を残す**: 前の強調表示の消去タイマーが、後の強調表示を早く消さなくなった（コンテキストメニューの「要素を調べる」も同じ）。拡張機能のcaptcha待ちバナーは、同じタブで新しいバナーに置き換わるとすぐに終わり（`superseded: true`）、captchaのトークンが入って閉じたバナーを`cancel_human_wait`が取り消したと報告しなくなった（a59434a）
- **拡張機能のコマンドは不明な値を拒否し、ログに残す範囲を広げた**: `fox_interact`の`scroll`は不明な`direction`で`scrolled: true`を返さず失敗する。拡張機能の変化待ちは、`selector`が何にも一致しないとき（ページ全体を監視せず）と`changeType`が不明なときに失敗する。自動生成する`fox_inject_observer`のIDは同じミリ秒内でも重ならない（重なると先の監視を置き換えていた）。ネットワークログは中断（`error: "Aborted"`）とタイムアウト（`error: "Timeout"`）で終わったXHRも記録する。長さの上限で切る文字列（要素のテキストと値、`fox_get_text`、コンソールとネットワークのログ）は絵文字などBMP外の文字を途中で割らない。数値の値を持つ要素（`<li value>`）で要素一覧が失敗しなくなった（eb227e7）
- **拡張機能: `fox_read`の`mode: "info"`は届かないページを説明する（エラー文の変更）**: 拡張機能のcontent scriptがないページでは、Firefox自身の`Could not establish connection. Receiving end does not exist.`で失敗していた。ほかのページ操作ツールと同じ`KitsuneMCP cannot reach this page: Firefox does not let extensions into it (JSON viewer, about: pages, addons.mozilla.org, other extensions' pages), or it was opened before KitsuneMCP was installed or updated (reload the tab). Tab-level tools such as fox_screenshot and fox_tabs still work.`で失敗するようにした。それ以外の失敗の文は変わらない（e330de3）
- **拡張機能: 再試行をすべて失敗した送信が壊れた接続を残さない**: Native Hostへの送信が最後の再試行でも失敗したとき、壊れた接続を閉じ、通常の間隔で再接続する（来ないかもしれない切断通知まで使い続けていた）。自動生成する`fox_inject_observer`のIDは`obs_<時刻>_<番号>`になった（末尾の乱数をやめた。ページ内では番号で重ならない）（14d75ee、725bdda）
- **空の設定とトークンファイル**: 空の`FOX_HOST`は未設定として扱い、空の`FOX_HTTP_PORT` / `FOX_WS_PORT`は旧名の`CLAUDE_BROWSER_*`を使う。空または読めない`~/.kitsune-mcp/api_token`は上書きしなくなり、削除を求めるメッセージを出してdaemonが終了する（5cf492a）
- **Native Hostの再起動回数の上限が実際の上限になった**: daemonの起動に10回失敗すると、確認のたびに起動し直すのではなく、使えるdaemonが現れるまで起動しない。PNG・JPEG・WebP以外のMIMEタイプのスクリーンショットの`data:` URLは拒否する（b82e98d）
- **アンインストーラとインストーラの表示**: 読めないか壊れた`~/.claude.json` / `.mcp.json`は「未登録」ではなく問題として報告し（終了コード1）、別のチェックアウトを指すFirefoxの登録は警告を出す。`--help`と`--manual`の出力のパスは引用符で囲み、インストーラと`--help`が示すdaemonの確認コマンド（`curl`での/health、ポートの確認）は設定したホストとポートを使う。`cmd`に渡すことになるパスに`%`があれば拒否する（d04e56a）

### 開発者向け

- **拡張機能をesbuildでbundleする**: ソースはES moduleになり、`npm run build`が`dist/background.js`、`dist/content.js`、`dist/popup/popup.js`を書き出す。bundleにzodや`@kitsune-mcp/shared/node`が入るとビルドが失敗する。`npm run build`の後に`packages/extension/manifest.json`を読み込む（0e3376e、156600f）
- **Vitest**: `npm test`は単体・契約・インストーラのテストを、テストファイルごとに一時的なホームディレクトリで実行する。開発にはNode.js 22.12以降（または24）が必要（1925170、146fc2d）
- **`npm run typecheck`はテストも型検査する**: 拡張機能の型検査（`typecheck`スクリプトを持つworkspaceは拡張機能だけ）のあと、`npm run typecheck:tests`（`tsc -p tsconfig.test.json`。対象は`packages/*/tests`と`tests/`）を実行する。`npm run lint:ext`は`web-ext lint`を実行する（f93909a、156e11d）
- **`background.ts` / `content.ts`をモジュールに分割した**: `packages/extension/src/background/`と`src/content/`の下にあり、テストから直接importできる（d71c331、cacfcda、c7d6512、9f51441、176937b）
- **`docs/development.ja.md`**: ビルド、作業の流れ、`@kitsune-mcp/shared`の入口、テストの構成（[development.ja.md](./development.ja.md)）（9f342ae）
- **ツール統合のためのgoldenファイル**: `tests/golden/`に、各ツール呼び出しのBrowserCommandと安全ガードの判定、セッションの`tools/list`（既定と`FOX_CAPS=legacy`）を記録する。意図した変更なら`UPDATE_GOLDEN=1 npx vitest run <テストファイル>`で作り直す。`node scripts/tools-list-size.mjs`は両方のツール一覧の大きさを表示する（e2d711b、93054cc、59dee5c）
- **e2eのスモークテストは署名付きのリクエストを使う**: `X-API-Key`を送らなくなり、HTTPのエラーやJSONでない応答はテストの失敗になる（724b23b）
- **拡張機能の内部整理（WP-D）**: 既定値・上限・待ち時間を2つの`constants.ts`に名前付きで置いた（値は同じ）。型ガードで型アサーション（`as`）を149から88に減らした。content scriptへ送るaction名をunion型にして網羅を検査し、両側で共有するメッセージ種別とログの上限を`src/wire-messages.ts`に置いた。スクリーンショットと人の操作待ちは解決済みのタブを使う。要素の走査は上限で止まる。文字列の切り詰めはバックグラウンド・ポップアップ・content scriptとも1つの関数（`src/text-clip.ts`の`clipText`）で行う。`handleCommand`は呼び出し元（`"host"` / `"page"`）を既定値なしで受け取る（469b88e、c278604、1c6439d、725bdda）
