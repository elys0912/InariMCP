# 既知の制約と注意点

KitsuneMCP の現行版（v0.1.x）で分かっている制約・注意点をまとめたもの。

## 安全ガード

- **保護ドメインの判定に使う「現在の URL」が全セッションで共通**: `url` 引数を取らない act 系ツール（`fox_click`, `fox_type` など）の保護ドメイン確認は、共有サーバー（daemon）が1つだけ持つ「最後に操作した URL」で判定している。タブ単位・セッション単位で分かれていないため、複数のタブやセッションを同時に使うと、別のセッションの操作で確認がすり抜けることがある。`fox_screenshot` は Extension 側で実際のタブ URL を見て判定するので影響を受けない
- **タイムアウト後もブラウザ側の承認バナーが消えない**: サーバーがタイムアウトでエラーを返した後も、Extension の承認バナー・CAPTCHA バナーは表示されたまま残る。後から人間が承認を押すと、その操作が実行されてしまう。タイムアウトしたバナーは押さずに閉じること（取り消しの仕組みは未実装）
- **共有サーバーの設定は、最初に起動した側の環境変数が使われる**: `FOX_READ_ONLY` などの環境変数は、daemon を実際に起動したプロセスのものだけが読まれる。確実に効かせたい設定は `~/.kitsune-mcp/safety.json` に書く（README の該当節を参照）

## ツール

- **Extension 経路で未実装のツールが10本ある**: `fox_snapshot`, `fox_run_workflow`, `fox_audit_page`, `fox_inject_observer`, `fox_remove_observer`, `fox_handle_dialog`, `fox_wait_for_navigation`, `fox_wait_for_url`, `fox_eval_chain`, `fox_wait_and_act`。呼ぶと `Not implemented in extension` が返る（headless では動くものもある）
- **ネイティブダイアログ（alert / confirm / prompt）の表示中は、そのタブへのコマンドがタイムアウトする**: Extension 経路ではダイアログを検知・操作できない
- **headless の `fox_handle_dialog` はクリックと組み合わせられない**: headless のコマンドは1本ずつ順に実行されるので、`fox_handle_dialog` で待っている間は `fox_click` が後ろで待たされる。拾えるのは、ページ自身のタイマーなどで出るダイアログだけ
- **content script が入れないページでは、読み取り・操作系のツールが使えない**: Firefox の JSON ビューア、`about:` ページ、addons.mozilla.org など。`fox_screenshot` や `fox_get_tabs` のようにタブ API だけで動くツールは使える
- **`fox_execute_script` は content script の隔離された環境で実行される**:
  - スクリプト内の `console.log` はログに残らない。結果は戻り値で返す
  - スクリプトから呼んだ `fetch` / XHR は、ログにも `fox_wait_for_network_idle` の判定にも数えられない。ページ自身の通信を確認したいときは、ページ内のボタンを `fox_click` する
  - `script` は式として評価されるので、トップレベルの `return` は使えない（`(() => { ...; return x; })()` の形にする）
- **コンテナスコープ有効時のタブ一覧**: `getAllTabs` などはスコープ内のタブだけを返すが、付随する `windowCount` はスコープ外のウィンドウも数える

## ログ収集

- **ページ読み込み直後のインラインスクリプトのログは取り逃すことがある**: `<head>` / `<body>` 直下のインライン `<script>` の `console.log` は、content script の起動が間に合わないと記録されない。`setTimeout` などで遅れて動く処理のログは取れる（全ページに常時フックを入れれば確実に取れるが、プライバシーの観点で採らない）
- **iframe 内のログは収集しない**: トップフレームだけが対象
- **ページを移動すると、直前のページのログは消える**
- **ログ収集はタブ単位で続く**: 一度 `fox_start_logging` したタブは、別のサイトに移動しても `fox_stop_logging` するかタブを閉じるまで収集が続く

## インストール・運用

- **Node.js を入れ替えたらインストーラを再実行する**: Native Host のラッパー（`run-host.cmd` / `run-host.sh`）には、インストール時点の node の絶対パスが埋め込まれる。Node をアップグレード・切り替えた後は `scripts/install.ps1` / `scripts/install.sh` を再実行する
- **Ubuntu の Snap 版 Firefox では Native Messaging が動かない可能性がある**: `apt install firefox` で入るのは Snap 版。Mozilla の APT リポジトリから deb 版を入れること（`install.sh` も警告を出す）
- **macOS は未検証**: `install.sh` / `uninstall.sh` は Linux（WSL2 の Ubuntu 24.04）では確認済みだが、macOS 固有のパス（`~/Library/Application Support/...`）の処理は実機の macOS で動かしたことがない
- **ログファイルのローテーションなし**: `~/.kitsune-mcp/logs/daemon.log` などは追記されるだけで、サイズ上限や世代管理が無い。長く動かし続ける環境では手動で退避・削除すること
