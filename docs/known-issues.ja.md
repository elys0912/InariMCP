# 既知の制約と注意点

[English](./known-issues.md) | **日本語**

KitsuneMCPの現行版（v0.1.x）で分かっている制約と注意点。

## 安全ガード

- **保護対象でないタブで保護対象ドメインの確認を求められることがある**: `url`引数を取らない操作系ツール（`fox_click`、`fox_type`など）は、拡張機能が対象タブの実際のURLで確認するので、別のタブや別のセッションの操作がすり抜けることはない。共有daemonも同じ確認を、そのタブについて最後に見たURLで行う。`tabId`を付けない呼び出しでは、全セッション共通の「最後にアクティブだと見たタブ」になる。daemonの知らないところでアクティブなタブが変わる（手でタブを切り替える）と、前のタブのせいで確認を求められることがある。`fox_tabs`を1回実行すると、daemonの把握している状態が更新される。ヘッドレスモードではサーバー側の確認だけが働く
- **ブロック / 保護対象のリストの旧形式の正規表現は、URLのどこにでも一致する**: 以前の版のパターンのうち、ホストパターンとして読めないもの（READMEの「`safety.json`」を参照）は、そこでは以前の意味（URL全体に対するアンカーなしの正規表現）のまま使われ、daemonが警告をログに出す。ホストパターンか、`re:`（常にURL全体に一致）に書き直すこと。`allowed_url_patterns`ではこのようなパターンは設定エラーになる
- **`safety.json`が壊れているとすべてのツールが拒否される**: ファイルが読めない、JSONとして正しくない、知らないキーがある（`readonly`のような綴りの誤り）、値の型が違う、使えないURLパターンがある場合、daemonはエラーをstderr（`daemon.log`）に出し、ファイルを直してdaemonを再起動するまで、`fox_safety_status`（エラーを表示する）以外のすべてのツールを拒否する。編集したら`fox_safety_status`で結果を確認すること
- **URLパターンはパスと比べ、クエリやフラグメントとは比べない**: パスに`?`や`#`（`%3F`、`%23`も）を含むホストパターンは、決して一致しないので設定エラーになる。クエリ文字列で一致させたいときは、`re:`（URL全体に対する正規表現）で書くこと
- **拡張機能とMCP Serverの版が違うと、コマンドが`config_error`で拒否されることがある**: MCP Serverがコマンドに付けたコンテナスコープやURLルールを拡張機能が使えないとき、拡張機能はその検査を飛ばして実行せず、コマンドを拒否する。拡張機能とMCP Serverは一緒に更新すること（READMEの「更新」を参照）
- **共有daemonは、起動したプロセスの環境変数を使う**: `FOX_READ_ONLY`などの環境変数は、実際にdaemonを起動したプロセスのものだけが読まれる。Firefox（Native Host）が起動したdaemonはFirefoxの環境変数を引き継ぎ、`claude mcp add --env`の値は使われない。確実に効かせたい設定は`~/.kitsune-mcp/safety.json`に書くこと（READMEを参照）。セッションとdaemonで設定が食い違うと、セッション開始時と`fox_safety_status`の結果に警告が出る
- **`blocked_url_patterns` / `allowed_url_patterns`はhttp(s)のタブにだけ効く**: ユーザーが開いた`file://`のページやブラウザ内部のページ（`about:`、`moz-extension://`）はサイトではないので、リストの対象にならない。許可リストのモードでも、そのようなタブは読み取り・操作の対象になる。`fox_navigate`ではそこへ行けない（http(s)と`about:blank`以外は`blocked_scheme`で拒否する）

## 人による承認

- **ローカルのプロセスはMCP elicitationで自分の要求を承認できる**: 保護対象サイトでの操作の承認は、使えればClaude Codeの確認ダイアログ（MCP elicitation）で、そうでなければFirefoxのツールバーのポップアップで尋ねる。elicitationの回答はローカルのHTTPでdaemonに届くので、`~/.kitsune-mcp/api_token`を読めるプロセスは自分の要求を自分で承認できる（受け入れているリスク）。ポップアップでの承認だけにするには`FOX_APPROVAL_ELICITATION=0`を設定する
- **承認はホスト名に結び付き、パスやポートには結び付かない**（仕様）: 承認した呼び出しは、承認したホスト名のどのパス・ポート・スキームでも動く。ツールと引数の完全一致と1回限りであることは変わらない
- **UIだけを変えるツールは保護対象サイトの確認を通らない**（仕様）: `fox_interact`と、`action: "switch"`の`fox_tab`（分類`interact`）はページのデータを変えないので、観察系のツールと同じく、保護対象サイトでも承認なしで動く（読み取り専用モードでも使える）
- **ヘッドレスモードでは承認できない場合がある**: ヘッドレスには尋ねるためのポップアップがない。クライアントがelicitationに対応していないか、`FOX_APPROVAL_ELICITATION=0`が設定されていると、保護対象サイトでの操作は承認できずに拒否される。ヘッドレスモードの`fox_request_approval`は常に失敗する
- **CAPTCHAバナーの取り下げは保証されない**: 承認はページの外（ポップアップ）で尋ねるが、`fox_detect_captcha`のCAPTCHAバナーは今もページの中に出る。バナーは自分のタイマーで、サーバーが待つのをやめる前に閉じる。サーバーが先にタイムアウトした場合（メッセージが遅れたときなど）は拡張機能にバナーの取り下げを指示するが、そのメッセージも届かないとバナーが残ることがある。残ったバナーを押しても何も起きない（Claudeはすでにタイムアウトのエラーを受け取っていて、サーバーはその回答を捨てる）

## ツール

- **実装されていないツールがある**: 拡張機能経路では`fox_snapshot`、`fox_handle_dialog`、`mode: "chain"`または`"wait_and_act"`の`fox_evaluate`が`Not implemented in extension: <action>`を返す（`<action>`はツール名ではなく内部のアクション名）。以前の`fox_run_workflow`と`fox_audit_page`（既定のツール一覧にはない。`FOX_CAPS=legacy`では`[Deprecated]`付きで一覧に出る）はどのバックエンドでも未実装。READMEの「ツールの対応状況」を参照
- **DOMを扱うツールはトップフレームでだけ動く**: 拡張機能経路の`fox_click`、`fox_type`、`by: "selector"`の`fox_find`、`fox_read`、`fox_evaluate`、ログ収集のツール、`fox_wait`は、タブのトップの文書に対して動く。iframeやshadow DOMの中には届かない（`text`での要素の検索もそこは探さない）。`by: "text"`の`fox_find`（`browser.find`）はすべてのフレームを探す
- **クリック・入力・キー・ホバーは合成イベント**: `fox_click`、`fox_type`、`fox_press_key`、`action: "hover"`の`fox_interact`はページ内でDOMイベントを発行する（`isTrusted`は`false`）。実際のユーザー操作を必要とするページ（ポップアップを開く、クリップボードにアクセスする、一部のフレームワーク）では無視されることがあり、キーに対するブラウザの既定の動作（Tabでのフォーカス移動、スクロール）も起きない。例外はフォーム内の入力欄でのEnterで、本物のEnterと同じようにフォームを送信する。`fox_type`は1文字ごとに`delay`ミリ秒待つが、待ち時間の合計が10秒に収まるよう短くする
- **`for: "navigation"`の`fox_wait`は呼び出した後に終わったナビゲーションだけを待つ**: すでに終わったナビゲーション（クリックの直後など）は数えないので、速いナビゲーションはタイムアウトする。行き先が分かっているなら`for: "url"`を使う（すでにURLが一致していればすぐに返る）
- **`for: "network_idle"`の`fox_wait`が見る通信は一部だけ**: 数えるのはトップフレームのページ自身のfetch / XHRだけ。そのページで最初に呼ぶ前から続いているリクエストと、`fox_evaluate`が出したリクエストは見えない
- **`fox_screenshot`の引数には思いどおりに動かないものがある**: 画像はクライアントに保存したファイル（パスと`resource_link`）としてだけ届き、base64では返らない。そのため`saveToFile: false`では何も撮らずタブの情報だけを返し、`includeData`は効かない。既存の`filename`で保存するとファイルを上書きする（結果に`imageOverwritten`と警告が付く）。背景タブは切り替えずに撮るが、破棄済み（discarded）のタブは撮れず、そのタブに切り替える（`action: "switch"`の`fox_tab`）までエラーになる。`scope: "scroll_capture"`は画像を撮らず、スクロール位置ごとの要素の情報を返す
- **`kind: "input"`の`fox_set_value`は何も変わらなくても成功を返す**: 入力欄・textarea・select・contenteditableのどれでもない要素や、その値のoptionがないselectに対しても成功になる
- **ネイティブのダイアログ（alert / confirm / prompt）が開いている間、そのタブへのコマンドはタイムアウトする**: 拡張機能経路ではダイアログを見ることも操作することもできない
- **コンテンツスクリプトが入れないページでは、読み取り・操作のツールが使えない**: FirefoxのJSONビューアー、`about:`のページ、addons.mozilla.org、ほかの拡張機能のページなど。KitsuneMCPをインストール・更新する前に開いたタブにもコンテンツスクリプトがないので、再読み込みする。`fox_screenshot`や`fox_tabs`のように、tabs APIだけを使うツールは動く
- **`mode: "script"`の`fox_evaluate`はコンテンツスクリプトの隔離された環境で動く**:
  - ページのDOMは見えるが、ページ自身のスクリプトが定義した変数や関数（`window.myApp`など）は見えない
  - スクリプト内の`console.log`はログに残らない。結果は戻り値（JSONにできる値）で返すこと
  - スクリプトから呼んだ`fetch` / XHRはログに残らず、`for: "network_idle"`の`fox_wait`にも数えられない。ページ自身の通信を観察したいなら、`fox_click`でページ内のボタンを押す
  - `script`はスクリプトとして評価され、最後の式の値が返る。トップレベルの`return`は使えない（`(() => { ...; return x; })()`のように包む）
  - ヘッドレスモードではPlaywrightの`page.evaluate`でページ自身の環境で動くので、上記は当てはまらない

## ヘッドレスモード

- **対応していないツールがある**: `fox_logging`と`fox_get_logs`、`fox_navigate`の`hard_refresh`、`fox_screenshot`の`all_tabs` / `scroll_capture`、コンテナ（`what: "containers"`の`fox_tabs`、`container`を付けた`fox_tab`）。`fox_request_approval`は常に失敗する（「人による承認」を参照）
- **Playwrightは任意の依存**: 入っていないと（`npm ci --omit=optional`）、`FOX_HEADLESS=1`のdaemonは起動時に`daemon.log`へ`FOX_HEADLESS needs the optional dependency playwright, which is not installed`と出して終了する。拡張機能経路では不要。`npm run build`には必要（ヘッドレスバックエンドがその型をimportする）で、`npm run test:e2e`と`npm run e2e:extension`にも必要
- **コンテナスコープを有効にするとすべて拒否される**: ヘッドレスモードにはFirefoxのコンテナがないので、`safety.json`で`container_scope.enabled`にしているとブラウザへのコマンドはすべて拒否される（daemonは起動時に警告を出す）。ヘッドレスのdaemonは、コンテナスコープを切った専用の`safety.json`（`FOX_SAFETY_CONFIG`）で起動すること
- **無視される引数が多い**（結果の`warnings`に並ぶ）:
  - `fox_navigate`: `waitForLoad`（常に`domcontentloaded`まで待つ）、`bypassCache`（`refresh`は通常の再読み込み）
  - `fox_click`: `selector`か`x` + `y`だけ（`xpath`、`text`、`doubleClick`、`rightClick`は使えない）
  - `fox_type`: `selector`と`text`だけ（`selector`があれば既存の内容を置き換え、なければフォーカスのある要素に入力する。`clear`、`pressEnter`、`delay`、`placeholder`、`name`、`id`は無視）
  - `fox_screenshot`: `saveToFile`（常にファイルに保存する）、`timeout`（`all_tabs`の制限時間で、ヘッドレスは`all_tabs`に対応しない）
  - `fox_press_key`: `xpath`、`text`、`id`（`selector`を使う）
  - `fox_read` `mode: "info"`: URLとタイトルだけを返す
  - `fox_find` `by: "selector"`: `limit`は無視（最大50件、タグ / テキスト / 位置だけ）
  - `fox_find` `by: "text"`: 件数だけを返す（`caseSensitive`、`entireWord`、`includeRectData`は無視）
  - `fox_tabs` `what: "tabs"`: `urlPattern`、`includeFavicon`、`limit`は無視（id、URL、タイトル、activeだけ）
  - `fox_tab` `action: "create"`: `active`は無視（新しいタブは常にアクティブになる）
  - `fox_interact` `action: "highlight"`: `duration`、`label`は無視（2秒間の赤い枠）
  - `fox_wait` `for: "element"`: `visible: false`は無視（表示されるまで待つ）
  - `fox_wait` `for: "network_idle"`: `idleTime`は無視
  - `fox_wait` `for: "navigation"`: `waitUntil`、`urlPattern`は無視
  - `fox_observer`: `observerId`は無視（1ページに1つ）。`action: "remove"`は変更の件数だけを返す
- **待たれていないダイアログは閉じられる**: どの`fox_handle_dialog`も待っていないダイアログ（alert / confirm / prompt）は2秒後に閉じられ（dismiss）、そのタブの次の結果で報告される。受け入れたいときは、ダイアログを開く操作の前に`fox_handle_dialog`を呼ぶ。`timeout`の間にダイアログが来なければ、そのタブの次のダイアログに備えて30秒間待機を続ける

## ログ収集

- **ページ読み込み直後のインラインスクリプトのログは取りこぼすことがある**: ログ収集が有効なタブでは、ナビゲーションのたびにコンテンツスクリプトを早い段階（`document_start`）で入れ直すが、これは非同期なので、`<head>` / `<body>`のインラインの`<script>`の`console.log`は、入れ直しが遅れると記録されない。後から動くコード（`setTimeout`など）のログは取れる（すべてのページを常にフックすれば確実に取れるが、プライバシーのためにそうしていない）
- **ナビゲーション直前のログは失われることがある**: ログはタブごとに拡張機能のバックグラウンドに保持され、再読み込みやナビゲーションの後も残るが、ページは小さなまとまりで（250ミリ秒ごとに）送るので、古いページが閉じるときに送信中だったまとまりは失われる
- **ログ収集はタブ単位で続く**: タブで一度`action: "start"`の`fox_logging`を呼ぶと、`action: "stop"`かタブを閉じるまで、サイトをまたいで記録を続ける（タブが保護対象サイトにある間は記録を止める）
- **集めるのは一部の情報源だけ**: コンソールは`console.log` / `warn` / `error` / `info` / `debug`の呼び出しだけで、捕捉されなかった例外やブラウザ自身のエラーは含まない。ネットワークはページの`fetch` / XHRだけで、画像、スクリプト、CSS、WebSocketなどは含まない。どちらもトップフレームのものだけで、iframeの中のものは集めない。それぞれタブごとに最新の500件を残す
- **ネットワークログの秘密情報は一部しか伏せない**: `authorization`、`cookie`、`set-cookie`、`proxy-authorization`、`x-api-key`のヘッダーはページの中で伏せる。daemonはさらに、ほかの認証情報のヘッダーや項目（APIキー、トークン、CSRFトークン、セッションID、パスワード、シークレット）と、URL・フォームの本文・JSONの本文の中の秘密の値（`token=`、`"password": "…"`、Bearer / Basicの値、JWT）も伏せる。それ以外のヘッダーとリクエスト / レスポンスの本文（先頭1000 / 5000文字）はそのまま記録する

## インストールと運用

- **Node.jsを変えたらインストーラを実行し直す**: Native Hostのラッパー（`~/.kitsune-mcp/native-host/run-host.cmd` / `run-host.sh`）には、インストーラを実行したnodeの絶対パスが埋め込まれている。そのパスが無くなると`PATH`上の`node`で起動しようとするが、Firefoxを起動した環境の`PATH`にnodeがなければ失敗する。Node.jsを更新・切り替えたら`npm run setup`を実行し直す（または`--node`で変わらないパスを指定する）
- **更新したら古いdaemonを止める**: daemon、Native Host、中継は互いの署名を確かめ、プロトコルの版を確認する。更新後も古い版のdaemonが動いていると、中継やNative Hostは「another version」/「speaks protocol」と報告し、そのdaemonを使えない。そのdaemonのプロセスを止める（Native Hostが起動したものならFirefoxも再起動する）。次のツール呼び出しで新しいdaemonが起動する。`node packages/mcp-server/dist/index.js --stop-daemon`で止められるのはそれに対応したdaemonだけで、対応していない古いものはPIDで終了する（ポートは`--doctor`が表示する）
- **UbuntuのSnap版FirefoxではNative Messagingが動かないことがある**: `apt install firefox`で入るのはSnap版で、xdg-desktop-portalを通してhostを起動する。インストーラはそのためのマニフェストも書くが、ポータルがhostを起動できるかはシステムによる。動かなければMozillaのAPTリポジトリからdeb版を入れる
- **Flatpak版FirefoxのNative Messagingにはポータルが必要**: サンドボックスの中からホストのnodeは実行できない。インストーラはFlatpakの置き場にもマニフェストを書くが、Firefoxがhostに届くのは`about:config`で`widget.use-xdg-desktop-portal.native-messaging`を`1`にし、WebExtensionsに対応したxdg-desktop-portalがあるときだけ。そうでなければポップアップに「Setup needed」と出て、インストーラを実行し直しても直らない。この経路は未検証で、Flatpak以外のFirefoxが確実
- **macOSは未検証**: インストーラとアンインストーラのmacOS用の経路（`~/Library/Application Support/...`）は、実機のMacで一度も動かしていない
- **WindowsでPowerShellが使えないと、Firefoxと一緒にdaemonが止まることがある**: Native Hostは、daemonをFirefoxのジョブオブジェクトの外で起動するためにPowerShellを使い、だめならWMI（`cscript`）、タスク スケジューラ（`schtasks`）を試す。すべて失敗するとdaemonをジョブの中で起動して`native-host.log`に警告を出し、そのときはFirefoxを閉じるとdaemonと、それを使うClaude Codeのセッションが止まる。インストーラとアンインストーラ自体にはPowerShellは要らない
- **WSLのClaude CodeからWindowsのFirefoxは使えない**: それぞれが自分の`~/.kitsune-mcp/`（とAPIトークン）でdaemonを起動するので、WSLのセッションはWindowsのFirefoxに届かない。Claude CodeとFirefoxは同じ側で動かす
- **Firefoxのプロファイルを複数同時に開くと、先に接続した1つだけが使われる**: どれが使われているかはどこにも表示されない
- **アンインストールの後にdaemonが戻ってくることがある**: アンインストーラは最初にFirefoxへの登録を外し、daemonより先にこのリポジトリのNative Hostを止めるが、KitsuneMCPを使っているClaude Codeのセッションが残っていると、次のブラウザツールの呼び出しでdaemonを起動し直す（APIトークンも作り直す）。それらのセッションを再起動すること（アンインストーラが一覧を出す）。プロセスの一覧を取れない場合（`ps` / WMIがない）は、拡張機能を外すかFirefoxも終了する
- **空のAPIトークンファイルがあるとdaemonが起動しない**: `~/.kitsune-mcp/api_token`があって中身が空のとき（書き込み中に異常終了した場合など）、ほかのプロセスが書き込み中かもしれないので上書きせず、削除を求めるメッセージを出してdaemonが終了する。ファイルを削除してからやり直す（次のツール呼び出しで新しいトークンを作る）。読めないトークンファイルもエラーになる
- **Windowsではファイルのモード（0o600 / 0o700）が効かない**: `~/.kitsune-mcp/`のAPIトークン、ログ、スクリーンショットは、ユーザープロファイルのフォルダのアクセス権で守られる。プロファイルの外の`FOX_SCREENSHOTS_DIR`を指定すると、Native Hostが警告をログに出す
- **ログファイルは5 MBで切り替わる**: `~/.kitsune-mcp/logs/`のログは5 MBを超えると`<名前>.old`に退避される（1世代だけ残る）。`daemon.log`は動いているdaemonが開いたままなので、複製してから中身を空にする（copy-truncate。その間に書かれた行は失われる）。`native-host.log`と監査ログは書き込みのたびに確認する。`daemon.log`はdaemonの起動時と、Native Hostが動いている間は1時間ごとに確認する。FirefoxなしでClaude Codeだけから使っていると、daemonが再起動するまで5 MBを超えて大きくなる
- **開発にはNode.js 22.12以上（または24）が必要**: `npm test` / `npm run test:e2e`（Vitest）の要件。KitsuneMCP自体はNode.js 18以上で動く
