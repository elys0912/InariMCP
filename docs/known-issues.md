# 既知の制約と注意点

KitsuneMCP の現行版（v0.1.x）で分かっている制約・注意点をまとめたもの。

## 安全ガード

- **保護ドメインの確認が、保護されていないタブでも求められることがある**: `url` 引数を取らない操作系ツール（`fox_click`, `fox_type` など）は、Extension が実際の対象タブの URL で保護ドメインかを判定するので、別のタブやセッションの操作ですり抜けることはない。ただし共有サーバー（daemon）も、全セッション共通の「最後に見た URL」で同じ確認をしている。そのため、保護サイトで拒否された直後などは、別の保護されていないタブへの操作も確認を求められることがある。`fox_get_page_info` などで対象のページを一度読むと解消する（古い Extension と組み合わせたときの守りとして、サーバー側の確認は残している）。headless ではサーバー側の確認だけが働く
- **承認・CAPTCHA バナーの取り下げは確実ではない**: バナーは自前のタイマーでサーバーより先に閉じる。通信の遅れなどでサーバーが先にタイムアウトした場合も、サーバーが拡張に取り下げを指示して閉じる。ただしその指示自体が届かないと、バナーが残ることがある。残ったバナーを押しても、答えはサーバーで捨てられるだけで何も実行されない（Claude には既にタイムアウトのエラーが返っている）
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

## ログ収集

- **ページ読み込み直後のインラインスクリプトのログは取り逃すことがある**: `<head>` / `<body>` 直下のインライン `<script>` の `console.log` は、content script の起動が間に合わないと記録されない。`setTimeout` などで遅れて動く処理のログは取れる（全ページに常時フックを入れれば確実に取れるが、プライバシーの観点で採らない）
- **iframe 内のログは収集しない**: トップフレームだけが対象
- **ページを移動すると、直前のページのログは消える**
- **ログ収集はタブ単位で続く**: 一度 `fox_start_logging` したタブは、別のサイトに移動しても `fox_stop_logging` するかタブを閉じるまで収集が続く

## インストール・運用

- **Node.js を入れ替えたらインストーラを再実行する**: Native Host のラッパー（`run-host.cmd` / `run-host.sh`）には、インストール時点の node の絶対パスが埋め込まれる。Node をアップグレード・切り替えた後は `scripts/install.ps1` / `scripts/install.sh` を再実行する
- **Ubuntu の Snap 版 Firefox では Native Messaging が動かない可能性がある**: `apt install firefox` で入るのは Snap 版。Mozilla の APT リポジトリから deb 版を入れること（`install.sh` も警告を出す）
- **macOS は未検証**: `install.sh` / `uninstall.sh` は Linux（WSL2 の Ubuntu 24.04）では確認済みだが、macOS 固有のパス（`~/Library/Application Support/...`）の処理は実機の macOS で動かしたことがない
- **daemon.log は共有サーバーの起動時にしか切り替わらない**: `~/.kitsune-mcp/logs/` のログは 5 MB を超えると `<ファイル名>.old` に退避される（1世代だけ残る）。`native-host.log` と監査ログは書き込みのたびに確認するが、`daemon.log` は共有サーバー（daemon）の出力をそのままつないでいるので、確認するのは daemon を起動するときだけ。daemon を再起動しないまま長く動かすと、それまで 5 MB を超えて伸び続ける
