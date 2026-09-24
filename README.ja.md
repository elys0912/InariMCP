# KitsuneMCP

[English](./README.md) | **日本語**

**普段使いのFirefoxをClaude Codeから操作する。** Firefox専用のMCPアドオン — 使い捨てブラウザではなく、あなたの実プロファイル・実ログインをそのまま使う。

> ステータス: **開発初期、まだエンドツーエンドではインストールできない。** 下記の[Status](#status)を参照。

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

> 以下の手順は現時点（P1〜P5）で実装済みの内容を反映している。拡張機能のパッケージング/インストールとエンドツーエンドの配線はまだ完了していない — [Status](#status)を参照。

### 前提条件

- Node.js >= 18.0.0
- Firefox >= 78（`contextualIdentities` / `browser.find` / Manifest V2のため）
- （ヘッドレスモードのみ）Playwright: `npx playwright install firefox`

### インストール

```bash
git clone <this-repo>
cd KitsuneMCP
npm install
npm run build
```

これで4つのワークスペースパッケージ（`shared`、`mcp-server`、`native-host`、`extension`）が全てビルドされる。

### Claude Codeへの追加

```bash
claude mcp add kitsune-mcp -- node <INSTALL_PATH>/packages/mcp-server/dist/index.js
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
| `packages/mcp-server` | Claude Codeがstdio経由で通信するMCPサーバー。`fox_*`ツールを登録し、安全ガードを実行し、WebSocket（優先）、ヘッドレスPlaywrightバックエンド（上級者向け）、またはHTTPポーリング（フォールバック）経由でコマンドをディスパッチする。 |
| `packages/native-host` | MCPサーバーとFirefox拡張機能の間のネイティブメッセージングブリッジで、ヘルスモニタリングと自動再起動を備える。 |
| `packages/extension` | 実際にクリック・入力・DOM読み取りを行うFirefox WebExtension（Manifest V2）。 |

コマンドフロー: Claude Code → MCPサーバー → 安全ガード → （WebSocketまたはNative Messaging）→ 拡張機能バックグラウンドスクリプト → コンテンツスクリプト → ページDOM、結果は同じ経路を逆にたどって返ってくる。

完全な設計ドキュメント（アーキテクチャ図、プロトコル仕様、全ツール一覧、安全レイヤーの内訳）は`docs/design.md`を参照。

## 設定

### 環境変数

すべて`FOX_`をプレフィックスとする。フォーク元から引き継いだ古い`CLAUDE_BROWSER_*`という名前も、`FOX_*`版が未設定の場合の互換フォールバックとして引き続き使える。

| 変数 | デフォルト | 説明 |
|---|---|---|
| `FOX_HOST` | `127.0.0.1` | HTTP/WSサーバーのバインドアドレス |
| `FOX_HTTP_PORT` | `8765` | HTTPサーバーのポート |
| `FOX_WS_PORT` | `8766` | WebSocketサーバーのポート |
| `FOX_CAPS` | （全ツール） | ツールプロファイル: `core`、`logs`、`script`、`workflow`、`human`、`container`、`wait` — カンマ区切り |
| `FOX_HEADLESS` | `0` | `1`でヘッドレスPlaywrightバックエンドを有効化 |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45` | ヘッドレスブラウザの起動タイムアウト（秒） |
| `FOX_EXECUTABLE` | — | Firefoxバイナリの明示的なパス |
| `FOX_SCREENSHOTS_DIR` | OSの一時ディレクトリ | スクリーンショットの保存先 |
| `FOX_READ_ONLY` | — | `1`で読み取り専用モードを強制 |
| `FOX_ALLOW_SCRIPTS` | — | `0`でスクリプト実行ツールを無効化 |
| `FOX_SAFETY_CONFIG` | `~/.kitsune-mcp/safety.json` | 安全ポリシーファイルの代替パス |

### `safety.json`

初回実行時に`~/.kitsune-mcp/safety.json`に妥当なデフォルト値で自動生成される（安全ガード有効、スクリプト実行許可、保護対象ドメインの確認有効、パスワード入力無効、レート制限120アクション/分、銀行や`.gov`などの保護対象ドメインの初期リスト）。独自のブロック/許可URLパターンを追加したり、コンテナスコープを有効にしたりする場合は編集する。完全なスキーマは`docs/design.md` §9.1に記載。

## Status

このプロジェクトは**活発かつ段階的に開発中** — まだ一般利用の準備は整っていない。

**完了済み:**
- 設計ドキュメント + 多角的レビュー（`docs/design.md`）
- モノレポの雛形構築（P1）
- 安全ガード、8層（P2）
- MCPサーバーのコア + 全41ツールのスキーマ/ハンドラ（P3）
- ヘッドレスPlaywrightバックエンド（P4）
- ネイティブメッセージングホスト（P5）

**未完了:**
- 拡張機能のバグ修正とKitsuneMCPへのリブランディング（P6）
- Firefoxネイティブのコンテナ/`browser.find`/サイドバー統合（P7）
- インストーラー、AMOパッケージング、正式なExtension ID（P8）

P6〜P8が完了するまでは、インストールして使うものではなく、読んでビルドできるソースコードとして扱ってほしい。進捗は`docs/design.md`と`docs/引き継ぎ.md`で追跡している。

## Credits

[nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser)からのフォーク。元々はPythonで書かれていた。このプロジェクトはそれをTypeScriptに移植し、Firefoxに絞り込み、安全モデルを拡張している（コンテナ分離、confirmトークンの代わりのMCP elicitation、タイミングセーフな認証）。大変な部分を最初にやってくれた原作者に感謝する。

## License

MIT — [LICENSE](./LICENSE)を参照。
