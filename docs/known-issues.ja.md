# 既知の制約と注意点

[English](./known-issues.md) | **日本語**

KitsuneMCP の現行版（v0.1.x）で分かっている制約・注意点をまとめたもの。

## 安全ガード

- **保護ドメインの確認が、保護されていないタブでも求められることがある**: `url` 引数を取らない操作系ツール（`fox_click`, `fox_type` など）は、Extension が実際の対象タブの URL で保護ドメインかを判定するので、別のタブやセッションの操作ですり抜けることはない。ただし共有サーバー（daemon）も、全セッション共通の「最後に見た URL」で同じ確認をしている。そのため、保護サイトで拒否された直後などは、別の保護されていないタブへの操作も確認を求められることがある。対象のタブで `fox_get_text` などを一度実行すると解消する（古い Extension と組み合わせたときの守りとして、サーバー側の確認は残している）。headless ではサーバー側の確認だけが働く
- **URL パターンは URL 全体への部分一致で判定される**: `safety.json` の `blocked_url_patterns` / `allowed_url_patterns` / `protected_url_patterns` は大文字小文字を区別しない正規表現で、ホスト名ではなく URL 全体のどこかに一致すれば当たりになる。`example\.com` は `https://example.com.attacker.net/` や `https://attacker.net/?q=example.com` にも一致する。許可リストは `^https://example\.com/` のように先頭から書く
- **`allow_password_typing: true` にしても、Extension 経路ではパスワード欄に入力できない**: この設定は Extension に届かず、Extension 側はパスワード欄（`type="password"`、`autocomplete` が `current-password` / `new-password`）への `fox_type` / `fox_set_value` を常に拒否する。サーバー側の判定は `selector` の文字列に `type=password` が含まれるかどうかだけを見る
- **`safety.json` が壊れていると既定値で動く**: JSON として読めない、または値の型が合わない場合、daemon はエラーを stderr（`daemon.log`）に出して既定値（ガード有効、保護ドメイン確認有効、スクリプト許可、許可・禁止リストなし）で動く。書き換えた後は `fox_safety_status` で反映を確認する
- **読み取り専用モードで `fox_switch_tab` と `fox_detect_captcha` も拒否される**: 読み取り専用モードで通す観察系ツールの一覧に、この 2 つが旧名（`fox_focus_tab`, `fox_solve_captcha`）で載っているため
- **共有サーバーの設定は、最初に起動した側の環境変数が使われる**: `FOX_READ_ONLY` などの環境変数は、daemon を実際に起動したプロセスのものだけが読まれる。Firefox（Native Host）が起動した daemon は Firefox の環境変数を引き継ぎ、Claude Code 側の `claude mcp add --env` の値は使われない。確実に効かせたい設定は `~/.kitsune-mcp/safety.json` に書く（README の該当節を参照）。セッションと daemon で設定が食い違っているときは、セッション開始時と `fox_safety_status` の結果に警告が出る

## 人による承認

- **MCP elicitation での承認は、ローカルのプロセスが自分で出せる**: 保護サイトでの操作の承認は、Claude Code の確認ダイアログ（MCP elicitation）が使えればそちらで、使えなければ Firefox のツールバーのポップアップで行う。elicitation の回答はローカルの HTTP で daemon に届くので、`~/.kitsune-mcp/api_token` を読めるプロセスは自分の要求を自分で承認できる（受け入れているリスク）。ポップアップでの承認だけにするには `FOX_APPROVAL_ELICITATION=0` を設定する
- **headless では承認できない場合がある**: headless には承認を尋ねるポップアップがない。クライアントが elicitation に対応していない、または `FOX_APPROVAL_ELICITATION=0` のときは、保護サイトでの操作は承認できずに拒否される。`fox_request_approval` も headless では常に失敗する
- **CAPTCHA バナーの取り下げは確実ではない**: 承認はページの外（ポップアップ）に移したが、`fox_detect_captcha` の CAPTCHA バナーはページ内に出る。バナーは自前のタイマーでサーバーより先に閉じる。通信の遅れなどでサーバーが先にタイムアウトした場合も、サーバーが拡張に取り下げを指示して閉じる。ただしその指示自体が届かないと、バナーが残ることがある。残ったバナーを押しても、答えはサーバーで捨てられるだけで何も実行されない（Claude には既にタイムアウトのエラーが返っている）

## ツール

- **未実装のツールがある**: Extension 経路では `fox_snapshot`, `fox_run_workflow`, `fox_audit_page`, `fox_inject_observer`, `fox_remove_observer`, `fox_handle_dialog`, `fox_eval_chain`, `fox_wait_and_act` の 8 本が未実装で、呼ぶと `Not implemented in extension: <名前>` が返る。このうち `fox_run_workflow` と `fox_audit_page` は headless でも未実装。headless の `fox_snapshot` はアクセシビリティツリーではなく PNG のスクリーンショット（base64）を返す。一覧は README の「Tool availability」を参照
- **iframe があるページでは、別のフレームの結果が返ることがある**: Extension 経路の DOM 操作・読み取り系ツール（`fox_click`, `fox_type`, `fox_get_elements`, `fox_get_text` など）は、タブ内の全フレームの content script に送られ、最初に応答したフレームの結果（エラーを含む）が使われる。ログ収集と `fox_wait_for_network_idle` はトップフレームだけに送る
- **`fox_type` は `selector` で入力欄を指定する**: 入力する文字列の `text` が、要素を探す手がかりとしても使われる（`placeholder` / `name` / `id` より先に試される）。`selector` を付けずに `placeholder` などだけで指定すると、入力する文字列を含む別の要素が選ばれることがある
- **`fox_type` の Enter は実際には送信しない**: `pressEnter` は合成の Enter キーイベントと、親フォームへの `submit` イベントを送るだけで、ブラウザの本来のフォーム送信は起きない。送信ボタンを `fox_click` する。`delay: 0` は既定の 50 ms として扱われ、1 文字ごとに待つので、既定値では約 600 文字でコマンドの制限時間（30 秒）を超える。長い値は `fox_set_value` を使う
- **クリック・入力・キー・ホバーは合成イベント**: `fox_click`, `fox_type`, `fox_press_key`, `fox_hover` はページ内で DOM イベントを発生させる（`isTrusted` は `false`）。実際のユーザー操作を要求するページ（ポップアップの表示、クリップボード、一部のフレームワーク）では効かないことがある
- **`fox_click` の `text` は要素直下のテキストだけを見る**: 子要素の中にある文字列（`<button><span>送信</span></button>` の「送信」など）では見つからない。最初に一致した要素だけが対象で、shadow DOM の中は探さない
- **`fox_wait_for_navigation` は呼び出した後に始まった遷移だけを待つ**: クリックなどで既に終わった遷移は数えないので、速い遷移ではタイムアウトする。行き先が分かっているときは `fox_wait_for_url` を使う（既に一致していればすぐ返る）
- **`fox_wait_for_network_idle` はタイムアウトしても成功として返る**: 結果の `idle: false` / `timedOut: true` で判断する。数えるのはページ自身の fetch / XHR だけで、待ち始める前から続いている通信は見えない
- **`fox_screenshot` の一部の引数は効かない**: Extension 経路では画像は常にファイルに保存され（`saveToFile: false` と `includeData` は無視）、結果には base64 ではなくファイルのパスとリンクが入る。同じ `filename` を指定すると上書きされる。`scope: "viewport"` で背景のタブを指定すると、そのタブを一瞬前面に出して撮り、元のタブに戻す。`scope: "scroll_capture"` は画像を撮らず、スクロール位置ごとの要素の情報だけを返す（結果の案内にある `browser_screenshot` は存在しない。`fox_screenshot` を使う）
- **`fox_select_option` と `fox_set_value` は、値が一致しなくても成功を返す**: `fox_select_option` は結果の `value` / `text` で実際に選ばれたものを確認する。`fox_set_value` は入力欄・select・contenteditable 以外の要素では値を変えずに成功を返す
- **ツールの annotation が実際の動作と合わないものがある**: `fox_hover`, `fox_scroll`, `fox_highlight`, `fox_switch_tab` はページやタブの状態を変えるが、`readOnlyHint: true` で登録される
- **ネイティブダイアログ（alert / confirm / prompt）の表示中は、そのタブへのコマンドがタイムアウトする**: Extension 経路ではダイアログを検知・操作できない
- **headless の `fox_handle_dialog` は待機中に他の操作を止めない**: 待っている間にダイアログが出なければ、次のダイアログ（30 秒以内）を指定の動作で処理する「予約」になる。予約も待機もないダイアログは 2 秒後に自動で dismiss され、そのとき実行中の操作の結果に `dialogs` と警告が付く。承認したいときは、ダイアログを開く操作の前に `fox_handle_dialog` を呼ぶ
- **headless では `container_scope` が有効だと全コマンドが拒否される**: headless に Firefox のコンテナがないため、安全側（fail-closed）で拒否する。headless 用に `container_scope.enabled: false` の `safety.json` を別に作り、`FOX_SAFETY_CONFIG` で指定して daemon を起動し直すか、Extension 経路を使う。`fox_safety_status` は拒否されない
- **content script が入れないページでは、読み取り・操作系のツールが使えない**: Firefox の JSON ビューア、`about:` ページ、addons.mozilla.org など。`fox_screenshot` や `fox_get_tabs` のようにタブ API だけで動くツールは使える
- **`fox_execute_script` は content script の隔離された環境で実行される**:
  - ページの DOM は見えるが、ページ自身のスクリプトが定義した変数・関数（`window.myApp` など）は見えない
  - スクリプト内の `console.log` はログに残らない。結果は戻り値で返す（JSON にできる値にする）
  - スクリプトから呼んだ `fetch` / XHR は、ログにも `fox_wait_for_network_idle` の判定にも数えられない。ページ自身の通信を確認したいときは、ページ内のボタンを `fox_click` する
  - `script` はスクリプトとして評価され、最後の式の値が返る。トップレベルの `return` は使えない（`(() => { ...; return x; })()` の形にする）
  - トップフレームでだけ実行される
  - headless では Playwright の `page.evaluate` でページ自身の環境で実行されるので、上の制約とは動作が異なる

## headless

- **`FOX_HEADLESS=0` でも headless になる**: 値が空でなければ有効とみなされる。無効にするには変数自体を設定しない
- **`FOX_HEADLESS_STARTUP_TIMEOUT` は効かない**: 値はミリ秒として読まれるが、ログに出るだけで Firefox の起動には渡されない
- **非対応のツールがある**: `fox_start_logging` などログ系 5 本、`fox_navigate` の `hard_refresh`、`fox_screenshot` の `all_tabs` / `scroll_capture`、コンテナ系 2 本、`fox_run_workflow`, `fox_audit_page`。`fox_request_approval` は常に失敗する
- **多くの引数が無視される**:
  - `fox_navigate`: `waitForLoad`, `bypassCache`（`refresh` は通常の再読み込み）
  - `fox_click`: `selector` か `x` + `y` だけ（`xpath`, `text`, `doubleClick`, `rightClick` は使えない）
  - `fox_type`: `selector` と `text` だけ（`selector` があれば既存の内容を置き換え、なければフォーカス中の要素に入力。`clear`, `pressEnter`, `delay`, `placeholder`, `name`, `id` は無視）
  - `fox_scroll`: `direction`, `amount`, `selector`, `toElement` は無視され、常に下へ 300 px スクロールする
  - `fox_screenshot`: `fullPage`（`scope: "full_page"`）と `filename` だけ
  - `fox_get_page_info`: URL とタイトルだけを返す
  - `fox_get_elements`: `limit` は無視（最大 50 件、タグ・テキスト・位置だけ）
  - `fox_find_text`: 件数だけを返す（`caseSensitive`, `entireWord`, `includeRectData` は無視）
  - `fox_get_tabs`: 引数はすべて無視
  - `fox_highlight`: `duration`, `label` は無視（2 秒間赤枠）
  - `fox_wait_for_element`: `visible: false` は無視（表示されるまで待つ）
  - `fox_wait_for_network_idle`: `idleTime` は無視
  - `fox_wait_for_navigation`: `waitUntil`, `urlPattern` は無視
  - `fox_snapshot`: `selector`, `maxDepth`, `includeText`, `roles` は無視
  - `fox_inject_observer` / `fox_remove_observer`: `observerId` は無視（observer は 1 つだけ）。変更は `window.__fox_mutations` に溜まり、`fox_remove_observer` は件数だけを返す

## ログ収集

- **ページ読み込み直後のインラインスクリプトのログは取り逃すことがある**: ログ収集中のタブでは、ページ移動のたびに content script を早い段階（`document_start`）で入れ直すが、非同期なので、`<head>` / `<body>` 直下のインライン `<script>` の `console.log` は間に合わないと記録されない。`setTimeout` などで遅れて動く処理のログは取れる（全ページに常時フックを入れれば確実に取れるが、プライバシーの観点で採らない）
- **iframe 内のログは収集しない**: トップフレームだけが対象
- **ページを移動すると、直前のページのログは消える**: ログはページ内の content script に溜まるので、移動・再読み込みで消える。必要なログは移動の前に取得する
- **ログ収集はタブ単位で続く**: 一度 `fox_start_logging` したタブは、別のサイトに移動しても `fox_stop_logging` するかタブを閉じるまで収集が続く（保護サイトにいる間は記録を止める）
- **収集対象は限られる**: コンソールは `console.log` / `warn` / `error` / `info` / `debug` の呼び出しだけで、捕捉されなかった例外やブラウザ自身のエラーは入らない。ネットワークはページの `fetch` / XHR だけで、画像・スクリプト・CSS・WebSocket などは入らない。それぞれ最新 500 件まで
- **ネットワークログの秘密情報は一部しか隠さない**: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key` ヘッダーは `[MASKED]` になるが、それ以外のヘッダー（`x-auth-token` など）と、リクエスト・レスポンスの本文（先頭 1000 / 5000 文字）はそのまま記録される

## インストール・運用

- **Node.js を入れ替えたらインストーラを再実行する**: Native Host のラッパー（`~/.kitsune-mcp/native-host/run-host.cmd` / `run-host.sh`）には、インストール時点の node の絶対パスが埋め込まれる。そのパスが無くなった場合は PATH 上の `node` で起動する（現行のインストーラが作るラッパー）が、Firefox を起動した環境の PATH に node が無いと起動できない。Node をアップグレード・切り替えた後は `scripts/install.ps1` / `scripts/install.sh` を再実行する
- **更新したら古い daemon を止める**: daemon と Native Host・中継は互いに署名で確かめ合い、プロトコルの版も確認する。更新後に古い daemon が動いたままだと、中継や Native Host が「another version」「speaks protocol」のエラーを出して使えない。その daemon のプロセスを止める（Native Host が起動した daemon なら Firefox も再起動する）と、次のツール呼び出しで新しい daemon が起動する
- **Ubuntu の Snap 版 Firefox では Native Messaging が動かない可能性がある**: `apt install firefox` で入るのは Snap 版。Mozilla の APT リポジトリから deb 版を入れること（`install.sh` も警告を出す）
- **Flatpak 版 Firefox では Native Messaging が動かない**: サンドボックスの外のホストを起動できない。ポップアップは「Setup needed」と表示してインストーラの実行を案内するが、再実行しても直らない。Flatpak 以外の Firefox を使う
- **macOS は未検証**: `install.sh` / `uninstall.sh` は Linux（WSL2 の Ubuntu 24.04）では確認済みだが、macOS 固有のパス（`~/Library/Application Support/...`）の処理は実機の macOS で動かしたことがない
- **Windows で PowerShell が使えないと、インストーラ・アンインストーラが動かない**: README の「Windows without PowerShell」の手順で手作業で設定する。Native Host は daemon を Firefox のジョブの外で起動するのに PowerShell を使い、使えなければ WMI（`cscript`）、タスク スケジューラ（`schtasks`）の順に試す。すべて失敗すると daemon をジョブの中で起動し、`native-host.log` に警告を出す。その場合、Firefox を閉じると daemon と、それを使う Claude Code のセッションも止まる
- **WSL の Claude Code と Windows の Firefox は組み合わせられない**: それぞれが自分の `~/.kitsune-mcp/`（API トークンも別）で daemon を起動するので、WSL 側のセッションから Windows の Firefox には届かない。Claude Code と Firefox は同じ側で動かす
- **Firefox のプロファイルを複数同時に開くと、先に接続した方だけが使われる**: どちらが使われているかはどこにも表示されない
- **アンインストール中に daemon が再起動されることがある**: Firefox に拡張機能が読み込まれたままだと、Native Host が約 20 秒で daemon を起動し直し、API トークンやログを作り直す。拡張機能を外すか Firefox を閉じてからアンインストーラを実行する
- **Windows ではファイルの権限設定（0o600 / 0o700）が効かない**: `~/.kitsune-mcp/` の API トークン・ログ・スクリーンショットの保護は、ユーザープロファイルのフォルダーのアクセス権に頼る。`FOX_SCREENSHOTS_DIR` をプロファイルの外に置くと、`native-host.log` に警告が出る
- **ログファイルは 5 MB を超えると切り替わる**: `~/.kitsune-mcp/logs/` のログは 5 MB を超えると `<ファイル名>.old` に退避される（1世代だけ残る）。`native-host.log` と監査ログは書き込みのたびに確認する。`daemon.log` は daemon を起動するときと、Native Host が動いている間は 1 時間ごとに確認する。Firefox を開かずに Claude Code だけで長く使うと、daemon を再起動するまで 5 MB を超えて伸びる
- **`node packages/mcp-server/dist/index.js --help` / `--version` はない**: 引数は `--daemon` 以外無視され、中継として起動する（daemon の起動や API トークン・ログの生成も起きる）
- **バージョン番号がそろっていない**: 拡張機能は 0.1.4、npm パッケージと daemon の `/health` は 0.1.0
- **開発時のテストには Node.js 22.12 以上（または 24）が必要**: `npm test`（Vitest）の要件。KitsuneMCP の実行自体は Node.js 18 以上で動く
