# R3 relay / transport / daemon / connection / doctor / cli — changelog fragment

Entries for the Unreleased section, in the format of docs/CHANGELOG.md and docs/CHANGELOG.ja.md (commit hashes are added when merged).

## English

### Fixed

- **A tool answer that cannot be written is answered 500**: when the daemon could not serialize a tool or approval result, the request stayed open without an answer until the relay timed out (and the error went unhandled). It now answers HTTP 500 with the reason and writes it to `daemon.log`
- **`--doctor` compares the daemon settings the way the relay does**: the `settings` item compared the raw variable values, so `FOX_READ_ONLY=true` against `1`, or an old `CLAUDE_BROWSER_*` name against its `FOX_*` name, was a WARN although the relay treats them as the same. It now compares the effective values with the relay's own rule, and the WARN reads like the relay's warning (`FOX_READ_ONLY: this session 'on', daemon 'off'`)
- **The relay waits longer when the headless startup timeout is raised**: the relay's wait for the daemon's answer was the longest command timeout plus a fixed 60 s, which a `FOX_HEADLESS_STARTUP_TIMEOUT` above 45 s could exceed. The margin is now that startup timeout plus 15 s (60 s with the default)
- **Messages name the real file locations**: the relay's "no API token" / "daemon unavailable" messages and `--doctor`'s `logs` item build the `api_token` and log paths from the data directory instead of a fixed `~/.kitsune-mcp/...` text. The request size limit in the relay's message is the daemon's own value (in bytes)

### Developer

- **daemon / relay / transport code tidied without changing behaviour**: `runDaemon` is split into named steps (`buildShutdownSteps`, `occupiedPortExit`; the exit can be injected for tests), the relay's startup check is `precheckDaemon`, `DaemonClient.request` takes an options object and `settingsMismatch()` is gone (`checkSettings()` remains), the connection manager's pending-request handling and the WebSocket pre-auth byte budget are separate functions, and error texts come from one `errorMessage()` helper
- **Tests**: added for an answer that cannot be written, `/browser/command` and raw actions, invalid JSON, `GET /mcp/tools` and `/screenshots`, the token re-read after a refused signature, the failure paths of `--stop-daemon`, the relay's startup check, and the doctor's effective-value comparison

## 日本語

### 修正

- **書き出せないツール応答には500を返す**: daemonがツールや承認の結果をJSONにできないとき、要求は応答のないまま中継のタイムアウトまで残っていた（エラーも処理されていなかった）。今後はHTTP 500で理由を返し、`daemon.log`に記録する
- **`--doctor`はdaemonの設定を中継と同じ方法で比べる**: `settings`の項目は変数の値をそのまま比べていたため、`FOX_READ_ONLY=true`と`1`、旧名`CLAUDE_BROWSER_*`と`FOX_*`の違いが、中継では同じ扱いなのにWARNになっていた。中継と同じ規則で実効値を比べ、WARNの文面も中継の警告と同じ形（`FOX_READ_ONLY: this session 'on', daemon 'off'`）になる
- **ヘッドレスの起動待ちを延ばすと中継も長く待つ**: 中継がdaemonの応答を待つ時間は最長のコマンドタイムアウトに固定の60秒を足したもので、`FOX_HEADLESS_STARTUP_TIMEOUT`を45秒より長くすると足りなくなることがあった。上乗せ分をその起動待ち＋15秒（既定では60秒のまま）にした
- **メッセージに実際のファイルの場所を示す**: 中継の「APIトークンが無い」「daemonを使えない」というメッセージと`--doctor`の`logs`の項目は、`api_token`とログの場所を固定の`~/.kitsune-mcp/...`ではなくデータディレクトリから組み立てる。中継のメッセージに示す要求サイズの上限はdaemonの値（バイト数）になる

### 開発者向け

- **daemon・中継・通信部分のコードを挙動を変えずに整理した**: `runDaemon`を名前の付いた段階に分け（`buildShutdownSteps`、`occupiedPortExit`。終了処理はテストから差し替えられる）、中継の起動時チェックを`precheckDaemon`にした。`DaemonClient.request`はオプションのオブジェクトを受け取り、`settingsMismatch()`を廃止した（`checkSettings()`は残る）。接続管理の待ち要求の処理とWebSocketの認証前のバイト上限を別の関数にし、エラーの文字列化を`errorMessage()`の1つにまとめた
- **テスト**: 書き出せない応答、`/browser/command`と生のアクション、不正なJSON、`GET /mcp/tools`と`/screenshots`、署名拒否の後のトークン読み直し、`--stop-daemon`の失敗経路、中継の起動時チェック、doctorの実効値による比較のテストを追加した
