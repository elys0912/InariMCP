# Changelog fragment: R3 native-host / shared / scripts

Entries to merge into the Unreleased section of docs/CHANGELOG.md and docs/CHANGELOG.ja.md (no commit hashes yet).

## English

### Fixed

- **A blank `FOX_HOST` / `FOX_HTTP_PORT` / `FOX_WS_PORT` counts as unset**: the daemon, the relays, the Native Host and the installer / uninstaller now take a value of only spaces as not set (the legacy `CLAUDE_BROWSER_*` name, then the default, applies) and use a set value without its surrounding spaces, like every other `FOX_*` variable. `FOX_HOST=' '` used to be passed on as the address, so the daemon could not listen and the Native Host could not reach it; a blank port no longer logs an "ignoring … not a port number" warning. The installer and uninstaller read `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `ComSpec`, `PATH` and `PATHEXT` the same way
- **The uninstaller recognises the daemon as `/health` does elsewhere**: an answer is taken as a KitsuneMCP daemon only with `status: "ok"`, the same test the relays and the Native Host use
- **Installer / uninstaller output errors**: an error writing to stdout other than a closed pipe is reported in one line and exits with code 1, instead of a stack trace

### Developer

- **Native Host and scripts cleaned up without changing behaviour**: the Native Host's daemon start is split into named steps (log preparation, start outside Firefox's job object, plain spawn), and so are the uninstaller's process and data-directory steps and the installer's Claude Code step. File modes, retry counts and time units are named constants; the Native Host log line prefix comes from `@kitsune-mcp/shared`
- **`shortId()` always gives 6 base-36 characters**: it could be shorter (even empty) before, so generated screenshot names, relay IDs (`relay:<id>` in the audit log) and outside-job spec names now have a fixed length. Screenshot files from earlier versions with a shorter ID are still removed by the retention rule
- **Tests**: `trampoline.test.ts` keeps the detached test daemon's directory apart from the per-test directory, so deleting it no longer depends on when that process exits (EPERM on Windows under load). Tests for blank endpoint variables, `stopDaemonGracefully`, `resolveLogPath`, `logStamp` / `stderrLogger` / `readPackageVersion` and malformed `/mcp/call` answers were added; the shared `parsePort` / `evaluateHealth` tests moved to `packages/shared/tests`

## 日本語

### 修正

- **空白だけの`FOX_HOST` / `FOX_HTTP_PORT` / `FOX_WS_PORT`を未設定として扱う**: daemon・中継・Native Host・インストーラ / アンインストーラは、空白だけの値を未設定とし（旧名`CLAUDE_BROWSER_*`、次に既定値を使う）、設定された値は前後の空白を除いて使う。ほかの`FOX_*`変数と同じ扱いになる。以前は`FOX_HOST=' '`がそのままアドレスになり、daemonが待ち受けできず、Native Hostも接続できなかった。空白だけのポートで「ignoring … not a port number」の警告も出なくなった。インストーラとアンインストーラは`CLAUDE_CONFIG_DIR`・`XDG_CONFIG_HOME`・`ComSpec`・`PATH`・`PATHEXT`も同じ規則で読む
- **アンインストーラのdaemon判定を他と揃えた**: `/health`の応答は`status: "ok"`があるときだけKitsuneMCPのdaemonとみなす（中継とNative Hostと同じ判定）
- **インストーラ / アンインストーラの出力エラー**: 標準出力への書き込みエラーのうちパイプが閉じた場合以外は、スタックトレースではなく1行で報告して終了コード1で終わる

### 開発者向け

- **Native Hostとscriptsのコードを挙動を変えずに整理した**: Native Hostのdaemon起動を名前の付いた手順（ログの準備、Firefoxのジョブオブジェクト外での起動、通常の起動）に分け、アンインストーラのプロセス停止とデータディレクトリの手順、インストーラのClaude Codeの手順も分けた。ファイルモード・再試行回数・時間の単位は名前付き定数にし、Native Hostのログ行の接頭辞は`@kitsune-mcp/shared`のものを使う
- **`shortId()`は常に36進6文字を返す**: 以前は短く（空にも）なることがあったため、生成するスクリーンショット名・中継ID（監査ログの`relay:<id>`）・ジョブオブジェクト外起動の作業ファイル名の長さが一定になる。以前の版が作ったIDの短いスクリーンショットも保持期限で削除される
- **テスト**: `trampoline.test.ts`はテスト用daemonの作業ディレクトリをテストごとの一時ディレクトリから分け、その削除がプロセスの終了時刻に左右されないようにした（高負荷時のWindowsでのEPERM）。空白のエンドポイント変数、`stopDaemonGracefully`、`resolveLogPath`、`logStamp` / `stderrLogger` / `readPackageVersion`、不正な`/mcp/call`応答のテストを追加し、共有の`parsePort` / `evaluateHealth`のテストを`packages/shared/tests`へ移した
