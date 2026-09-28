# KitsuneMCP

[English](./README.md) | **日本語**

**普段使いのFirefoxをClaude Codeから操作する。** Firefox専用のMCPアドオン — 使い捨てブラウザではなく、あなたの実プロファイル・実ログインをそのまま使う。

> ステータス: **開発初期 — インストーラは完成済み（実機のWindowsとLinuxで確認済み、macOSは未検証）で、拡張機能経路はエンドツーエンドで動く。** AMO / GitHub Releases経由での署名済みパッケージ配布は準備中。下記の[Status](#status)を参照。

![status](https://img.shields.io/badge/status-WIP-yellow) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D18-green)

---

## これは何？

KitsuneMCPは、MCPサーバー + Firefox拡張機能で構成されるツールで、Claude Codeにあなたの実際のFirefox — cookieもセッションも既存の拡張機能もそのままの環境 — を操作させることができる。使い捨てプロファイルを立ち上げる代わりに、WebExtensionとネイティブメッセージングブリッジを通じて実行中のFirefoxと通信し、クリック・入力・スクリーンショット・コンソール/ネットワークログの読み取りなどを行い、今見ているタブに対する高速な「手」として動作する。

これは[nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser)（MIT）のフォークで、PythonからTypeScriptに移植し、Firefox専用に絞ったもの。

## なぜ作ったか？

Chromeにはすでに公式のClaudeブラウザ拡張機能がある。Firefoxにはまだない。KitsuneMCPは、Anthropic（またはMozilla）が公式なものを出すまでのギャップを埋めるために存在する。それが実現した時点で、このプロジェクトの役目はほぼ終わる。

## こんな人には向かない

KitsuneMCPは意図的に用途を絞っている。以下に当てはまる場合は、他の選択肢の方が満足できるはず。

- **Chrome/Edgeユーザー** → [公式Claudeブラウザ拡張機能](https://claude.com)か[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)を使う。
- **CI・自動テスト、クロスブラウザ対応** → [Playwright MCP](https://github.com/microsoft/playwright-mcp)。Chromium/Firefox/WebKitと使い捨てプロファイルに対応していて、その用途には適材適所。
- **大規模スクレイピング** → [browser-use](https://github.com/browser-use/browser-use)や[Browserbase](https://www.browserbase.com/)がその用途向けに作られている。
- **Firefox自体のデバッグ（DevToolsプロトコルレベル）** → [mozilla/firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp)が本命。
- **CAPTCHA突破** → KitsuneMCPはこれをやらない。CAPTCHAを検知したら、あえて制御をあなたに返す。

## 特徴

- **41個の`fox_*`ツール** — ナビゲーション、クリック/入力/スクロール、スクリーンショット（可視範囲/全ページ/全タブ）、タブ管理、コンソール/ネットワークログ収集、スクリプト実行、構造化ページスナップショット、ワークフローヘルパーをカバー。Playwright MCPと併用しても衝突しないよう`browser_`ではなく`fox_`をプレフィックスにしている。
- **ツールプロファイル（`FOX_CAPS`）** — 41個全てのツールを登録すると実際にコンテキストトークンを消費する。プロファイル（`core`、`logs`、`script`、`workflow`、`human`など）を選んで必要な分だけ読み込める。
- **8層の安全ガード** — レート制限、URLスキームチェック、ブロック/許可リスト、読み取り専用モード、スクリプト実行トグル、保護対象ドメインの確認（銀行、決済処理業者、`.gov`など、MCP elicitation経由）、JSONL監査ログ。デフォルトでオフだからといって危険というわけではなく、ガード自体は常に動作している — オプトインが必要なのはコンテナスコープ（レイヤー0）だけ。
- **コンテナ分離（オプトイン）** — Firefoxの`contextualIdentities`を使い、エージェントを専用コンテナに制限できる。これにより、他のタブで開いている銀行・メールのセッションをエージェントから見えなくできる。これはFirefox専用の機能で、Chromiumには同等のものが存在しない。
- **ヘッドレスモード（上級者向け）** — 拡張機能経由を使いたくない場合のための、Playwrightベースの、Firefox専用ヘッドレスバックエンド。一部の機能（人間による承認バナー、コンテナツール）はここでは使えない。
- **Firefoxネイティブなapi** — トークンを節約できるページ内テキスト検索用の`browser.find`、フォーカスを奪わずにバックグラウンドタブをスクリーンショットする`tabs.captureTab`。

## クイックスタート

### 前提条件

- Node.js >= 18.0.0
- Firefox >= 78（`contextualIdentities` / `browser.find` / Manifest V2のため）
- （ヘッドレスモードのみ）Playwright: `npx playwright install firefox`

### インストール

```bash
git clone <this-repo>
cd KitsuneMCP
npm run install:windows
```

macOS/Linuxでは代わりに`npm run install:unix`を使う（Linuxでは確認済み、実機のmacOSではまだ検証していない — [Status](#status)参照）。LinuxのFirefoxはディストリビューションのパッケージかMozillaのAPTリポジトリ版を使うこと。Flatpak版はNative Messaging hostを起動できず、Snap版（Ubuntuの既定の`firefox`）も動かない場合がある。どちらも`npm install`と`npm run build`を自動で行い、`~/.kitsune-mcp/native-host/`にNative Messaging hostを生成してFirefoxに登録し、Claude CodeへのMCPサーバー登録も尋ねてくれる。直接実行する場合の同等コマンド:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

```bash
bash scripts/install.sh
```

`-SkipBuild`/`--skip-build`、`-NoRegisterClaude`/`--no-register-claude`、`-ClaudeScope`/`--claude-scope`（既定は`user`、全プロジェクト共通）などで挙動を調整できる。詳細はスクリプト自身の`--help`・冒頭コメントを参照。

**Node.jsを入れ替えた・アップグレードした場合は、インストーラを実行し直すこと** — 生成されるラッパーには、ビルド時のnodeバイナリの絶対パスが埋め込まれている。

### Firefoxへの拡張機能の読み込み

署名済みでワンクリックインストールできる`.xpi`はまだ配布していない（AMO署名 + GitHub Releasesでの配布は準備中 — [docs/release.md](docs/release.md)参照）。今のところは一時的なアドオンとして読み込む。

1. Firefoxで`about:debugging#/runtime/this-firefox`を開く
2. 「一時的なアドオンを読み込む」→ `packages/extension/manifest.json`を選択
3. Firefoxを再起動すると消えるので、その都度読み込み直す必要がある

### 接続確認

```bash
curl -s http://127.0.0.1:8765/health
```

拡張機能が接続すると（読み込みから数秒後）`browsers_connected`が`1`になる。

### 手動セットアップ・詳細な確認手順

インストーラが何をしているか正確に知りたい場合や、インストーラを使わず手動でセットアップしたい場合、および全ツールを1本ずつ確認する完全な手順は[`docs/e2e-test-plan.md`](docs/e2e-test-plan.md)を参照。

### アンインストール

```bash
npm run uninstall:windows   # または: npm run uninstall:unix
```

実行中のdaemonを止め（確認あり）、Firefoxへの登録・native-hostのファイル・Claude Codeへの登録を削除する。`-Purge`/`--purge`を付けると`~/.kitsune-mcp/`の残り（APIトークン、`safety.json`、ログ、スクリーンショット）も削除する。

### ログ

Native Hostのログは既定で`~/.kitsune-mcp/logs/native-host.log`に出力される。`FOX_NATIVE_HOST_LOG`でパスを変更でき、`0`/`off`を指定すると無効化できる。

### Claude Codeへの追加

インストーラがClaude Codeへの登録（`claude mcp add`、既定スコープ`user` = 全プロジェクト共通）を代わりに行ってくれる。この手順をスキップした場合や、インストール時に`claude`が`PATH`に無かった場合は手動で登録する。

```bash
claude mcp add --scope user kitsune-mcp -- node <INSTALL_PATH>/packages/mcp-server/dist/index.js
```

または、MCP設定に手動で追加する（テンプレートは`config/mcp_config.json`を参照）。

```json
{
  "mcpServers": {
    "kitsune-mcp": {
      "command": "node",
      "args": ["<INSTALL_PATH>/packages/mcp-server/dist/index.js"],
      "env": {
        "FOX_CAPS": "core,logs"
      }
    }
  }
}
```

### ヘッドレスモード

拡張機能をインストールしたくない場合は、`FOX_HEADLESS=1`を設定すると、MCPサーバーが実際のブラウザと通信する代わりにPlaywrightで管理されたFirefoxインスタンスを直接操作する。

```bash
FOX_HEADLESS=1 node packages/mcp-server/dist/index.js
```

これにより実際のセッション/cookie/ログイン状態は失われる点に注意 — 使い捨てプロファイルになる、Playwright MCPと同じトレードオフ。実際にログイン済みのFirefoxを使いたい場合は拡張機能経由を使うこと。

## アーキテクチャ

4つのTypeScriptパッケージからなるモノレポ。

| パッケージ | 役割 |
|---|---|
| `packages/shared` | 他の3パッケージで使われる共有のzodスキーマ、アクション名、定数。 |
| `packages/mcp-server` | 1つの実行ファイルで2つの役割を持つ。既定では薄いstdio中継で、Claude Codeがセッションごとに1つ起動し、`fox_*`ツールの一覧を返して、呼び出しを共有サーバーに転送する。`--daemon`を付けるとその共有サーバーになる。HTTP/WebSocketのポートを持つ唯一のプロセスで、安全ガードを実行し、Native HostへのWebSocket（優先）かヘッドレスPlaywrightバックエンド（上級者向け）にコマンドをディスパッチする。 |
| `packages/native-host` | 共有サーバーとFirefox拡張機能の間のネイティブメッセージングブリッジ。共有サーバーが動いていなければ起動し、プロセスがいなくなったときだけ起動し直す（応答が遅いだけのサーバーは止めない）。 |
| `packages/extension` | 実際にクリック・入力・DOM読み取りを行うFirefox WebExtension（Manifest V2）。 |

コマンドフロー: Claude Code → stdio中継 → HTTP → 共有サーバー → 安全ガード → WebSocket → Native Host → Native Messaging → 拡張機能バックグラウンドスクリプト → コンテンツスクリプト → ページDOM、結果は同じ経路を逆にたどって返ってくる。

`claude mcp add`のコマンドは変わらない。中継が最初の利用時に共有サーバーを起動し（Firefoxが先ならNative Hostが起動する）、共有サーバーは10分使われなければ自分で終了する。セッションごとに中継が1つずつ立ち、全員が1つの共有サーバーを使うので、Claude Codeを複数セッション同時に使ってもポートがぶつからない。安全ガードの状態（レート制限、監査ログ、現在のURL）もセッション間で共有される。

完全な設計ドキュメント（アーキテクチャ図、プロトコル仕様、全ツール一覧、安全レイヤーの内訳）は`docs/design.md`を参照。

## 設定

### 環境変数

すべて`FOX_`をプレフィックスとする。フォーク元から引き継いだ古い`CLAUDE_BROWSER_*`という名前も、`FOX_*`版が未設定の場合の互換フォールバックとして引き続き使える。

| 変数 | デフォルト | 説明 |
|---|---|---|
| `FOX_HOST` | `127.0.0.1` | HTTP/WSサーバーのバインドアドレス |
| `FOX_HTTP_PORT` | `8765` | HTTPサーバーのポート |
| `FOX_WS_PORT` | `8766` | WebSocketサーバーのポート |
| `FOX_CAPS` | （全ツール） | ツールプロファイル: `core`、`logs`、`script`、`workflow`、`human`、`container`、`wait` — カンマ区切り。**安全の境界ではない** — 登録するツールスキーマを絞ってコンテキストトークンを節約するだけの設定。読み取り専用、スクリプト禁止、URL 制限、コンテナスコープといった実際の制限は下記の`safety.json` / SafetyGuardが担う。クライアント側が広い`FOX_CAPS`で中継を起動すればどのツールにも到達できる点も同じ |
| `FOX_HEADLESS` | `0` | `1`でヘッドレスPlaywrightバックエンドを有効化 |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45` | ヘッドレスブラウザの起動タイムアウト（秒） |
| `FOX_EXECUTABLE` | — | Firefoxバイナリの明示的なパス |
| `FOX_SCREENSHOTS_DIR` | OSの一時ディレクトリ | スクリーンショットの保存先 |
| `FOX_READ_ONLY` | — | `1`で読み取り専用モードを強制 |
| `FOX_ALLOW_SCRIPTS` | — | `0`でスクリプト実行ツールを無効化 |
| `FOX_SAFETY_CONFIG` | `~/.kitsune-mcp/safety.json` | 安全ポリシーファイルの代替パス |

### `safety.json`

初回実行時に`~/.kitsune-mcp/safety.json`に妥当なデフォルト値で自動生成される（安全ガード有効、スクリプト実行許可、保護対象ドメインの確認有効、パスワード入力無効、レート制限120アクション/分、銀行や`.gov`などの保護対象ドメインの初期リスト）。独自のブロック/許可URLパターンを追加したり、コンテナスコープを有効にしたりする場合は編集する。完全なスキーマは`docs/design.md` §9.1に記載。

### 先に daemon を起動した側の設定が勝つ

daemon はセッションごとに新しく起動されるわけではない。Claude Codeの中継とFirefox（Native Host経由）のどちらか先に起動した方がdaemonを立ち上げ、残りは全員その1つのdaemonと通信する。これは環境変数に影響する — `FOX_READ_ONLY`、`FOX_HEADLESS`、`FOX_ALLOW_SCRIPTS`などは、実際にdaemonを起動したプロセスの環境変数だけが読まれる。Firefoxが先にdaemonを起動していた場合、後から起動したClaude CodeセッションのMCP設定に`FOX_READ_ONLY=1`と書いてあっても効かない。警告は出るが、既存のdaemonはそのままの設定で動き続ける。

`safety.json`にはこの問題がない。どちらがdaemonを起動しても、既定では同じ固定パス（`~/.kitsune-mcp/safety.json`）から読まれるからだ。`read_only`などを確実に効かせたいなら、環境変数ではなく`safety.json`側に設定すること。

## Status

このプロジェクトは**活発かつ段階的に開発中** — まだ一般利用の準備は整っていない。とはいえ「読んでビルドできるソースコード」の段階は過ぎていて、拡張機能を自分で読み込めば（`about:debugging`の一時的なアドオン）実際のFirefoxをエンドツーエンドで動かせる。足りないのは、それを手作業なしで誰でもインストールできるようにするパッケージングの部分だけ。

**完了済み:**
- 設計ドキュメント + 多角的レビュー（`docs/design.md`）
- モノレポの雛形構築（P1）
- 安全ガード、8層（P2）
- MCPサーバーのコア + 全41ツールのスキーマ/ハンドラ（P3）
- ヘッドレスPlaywrightバックエンド（P4）
- ネイティブメッセージングホスト（P5）
- 拡張機能のTypeScript移植（P6）
- Firefoxネイティブapi: コンテナタブ、`browser.find`、`tabs.captureTab`（P7）
- 拡張機能経路のエンドツーエンド結合、および中継＋共有サーバー構成への移行（Claude Codeを複数セッション同時に使ってもポートを取り合わない）（P7.5）
- Windows 11 + Firefoxでの実機E2E（2026-09-27） — 手順は[`docs/e2e-test-plan.md`](docs/e2e-test-plan.md)
- インストーラー（Windows用`scripts/install.ps1` / `scripts/uninstall.ps1`、macOS/Linux用`scripts/install.sh` / `scripts/uninstall.sh`） — 実機Windows 11と、Linux（WSL2のUbuntu 24.04、deb版Firefox 156）で結線を確認済み（2026-09-28）。macOS固有の経路は実機のmacOSではまだ動かしていない。Linuxの確認に使ったスモークテストは`scripts/e2e/`にある
- 配布準備: 正式なExtension ID確定（`kitsune-mcp@elys0912.github.io`）、AMOの`data_collection_permissions`設定、`web-ext lint`がエラー・警告0件（P8）

**未完了:**
- AMOでの署名と、GitHub Releasesでの署名済みパッケージの配布

登録される41本の`fox_*`ツールのうち10本は、拡張機能経路ではまだ未実装（`fox_snapshot`、`fox_run_workflow`、`fox_audit_page`、`fox_inject_observer`、`fox_remove_observer`、`fox_handle_dialog`、`fox_wait_for_navigation`、`fox_wait_for_url`、`fox_eval_chain`、`fox_wait_and_act`） — 呼び出すと黙って失敗するのではなく「未実装」という明確なエラーが返る。一部はヘッドレスモードでは既に動く。

進捗は`docs/design.md`と`docs/引き継ぎ.md`で追跡している。

## Credits

[nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser)からのフォーク。元々はPythonで書かれていた。このプロジェクトはそれをTypeScriptに移植し、Firefoxに絞り込み、安全モデルを拡張している（コンテナ分離、confirmトークンの代わりのMCP elicitation、タイミングセーフな認証）。大変な部分を最初にやってくれた原作者に感謝する。

## License

MIT — [LICENSE](./LICENSE)を参照。
