# 開発

[English](./development.md) | **日本語**

パッケージのビルドと確認の方法。KitsuneMCPの使い方は[README](../README.ja.md)を参照。

## 必要なもの

- 開発にはNode.js 22.12以上（または24）。Vitestの要件。KitsuneMCPの実行だけならNode.js 18で足りる。
- `playwright`（`packages/mcp-server`の任意の依存。`--omit=optional`を付けなければ`npm ci`で入る）。`npm run build`に必要（ヘッドレスバックエンドがその型をimportする）。`npm run test:e2e`と`npm run e2e:extension`には、そのFirefox（`npx playwright install firefox`）も必要。

## 作業の流れ

リポジトリのルートで実行する。

```bash
npm ci
npm run build           # 全workspace（「ビルド」を参照）
npm run typecheck       # typecheckスクリプトを持つworkspace（現在は拡張機能だけ）
npm test                # Vitest。e2e以外の全プロジェクト
npm run lint:ext        # packages/extensionのweb-ext lint
npm run e2e:extension   # 拡張機能が一時的なアドオンとしてFirefoxに読み込まれるか
```

`npm run test:e2e`（中継 → daemon → ヘッドレスFirefox）と`scripts/e2e/`のスクリプトは、READMEの「開発」に一覧がある。

## ビルド

`npm run build`は全workspaceの`build`を実行する。

| パッケージ | ビルド | 出力 |
|---|---|---|
| `packages/shared` | `tsc -b` | `dist/`（`.d.ts`付き） |
| `packages/mcp-server` | `tsc -b` | `dist/`（`dist/index.js`が中継 / daemon / doctorの入口） |
| `packages/native-host` | `tsc -b` | `dist/` |
| `packages/extension` | `npm run typecheck`のあと`node ../../scripts/build-extension.mjs` | `dist/`（バンドル） |

### 拡張機能（esbuild）

`scripts/build-extension.mjs`は、拡張機能をesbuildで実行環境ごとに1つ、計3つの自己完結したIIFEのバンドルにし、静的ファイルをコピーする。

| 入口 | バンドル | 読み込む側 |
|---|---|---|
| `src/background.ts` | `dist/background.js` | `manifest.json`の`background.scripts` |
| `src/content.ts` | `dist/content.js` | `manifest.json`の`content_scripts`（ログ収集中のタブへの早期注入も） |
| `src/popup/popup.ts` | `dist/popup/popup.js` | `dist/popup/popup.html`（`browser_action.default_popup`） |
| `src/popup/popup.html`、`src/popup/popup.css`、`src/content.css` | `dist/`にコピー | |

`manifest.json`が読み込むスクリプトは実行環境ごとに1本だけ。ビルドの詳細:

- 最初に`dist/`を消すので、古いファイルがパッケージに入ることはない。
- ターゲットは`firefox<strict_min_versionのメジャー番号>`。出力は縮小しない（AMOの審査で読めるように）。
- `npm run build:dev -w @kitsune-mcp/extension`はリンク付きのソースマップ（`dist/**/*.js.map`）も書く（`web-ext-config.mjs`でパッケージから除く）。
- esbuildは型検査をしない。型検査は`npm run typecheck`（`tsc --noEmit`。拡張機能の`build`も最初に実行する）が行う。ソースはES module（`moduleResolution: bundler`、`isolatedModules`、`verbatimModuleSyntax`、`noUnusedLocals`、`noUnusedParameters`、`@types/node`なし）。
- バンドルにzodか`packages/shared/src/node`が入る、バンドルが`"use strict";`で始まらない、`manifest.json`が読み込むファイルがない、のどれかでビルドは失敗する。
- スクリプトを`packages/extension`の外に置いているのは、web-extが`web-ext-config.mjs`で除外していないファイルをすべてパッケージに入れるため。

`npm run lint:ext`はリポジトリのルートで`web-ext lint`を実行する。ルートの`web-ext-config.mjs`が`sourceDir: 'packages/extension'`と除外するファイル（`src`、`package.json`、`tsconfig.json`、ソースマップなど）を決めている。

## `@kitsune-mcp/shared`

| import | 内容 | 使う側 |
|---|---|---|
| `@kitsune-mcp/shared` | zodスキーマ（プロトコル、アクション、Native Hostのメッセージ）、アクション名、定数（`ENV`など）、小さなユーティリティ。Node.jsのAPIは使わない（`packages/shared/tests/browser-safe.test.ts`で確認） | daemon、中継、Native Host。拡張機能はzodを引き込まないexportだけ |
| `@kitsune-mcp/shared/action-names` | ブラウザコマンドのアクション名。zodなし | 拡張機能 |
| `@kitsune-mcp/shared/node` | Node.jsのプロセス用の共通処理（下表） | daemon、中継、Native Host、doctor |

拡張機能は`@kitsune-mcp/shared`を`dist/`ではなくソース（`packages/shared/src`）からバンドルする。解決できるのは`@kitsune-mcp/shared`と`@kitsune-mcp/shared/action-names`だけで、それ以外のサブパス（`/node`を含む）はビルドエラーになる。拡張機能の`tsconfig.json`も同じ2つの名前をソースに対応させている。Vitestも3つのimportをすべてソースに解決するので、テストにビルドは要らない。

`@kitsune-mcp/shared/node`のモジュール（`packages/shared/src/node/`）:

| モジュール | 内容 |
|---|---|
| `paths` | `~/.kitsune-mcp/`の下のファイル（データとログのディレクトリ、APIトークン、`daemon.log`、`native-host.log`、監査ログ、既定の`safety.json`とスクリーンショットのディレクトリ）。呼び出し時に解決する |
| `endpoint` | `FOX_HOST` / `FOX_HTTP_PORT` / `FOX_WS_PORT`（と旧名）、ループバックの判定 |
| `token` | APIトークンの読み込みと作成（作成はdaemonだけ） |
| `health` | `GET /health`の応答の判定（daemonの多重起動確認、中継、Native Host、doctor） |
| `log` | 5 MBでの`<file>.old`へのローテーション（名前の変更、またはcopy-truncate）、行頭の`<ISO時刻> [<pid>] `、`[KitsuneMCP:<role>]`のstderrロガー |
| `spawn` | daemonを切り離したプロセスとして起動する。stderrは`daemon.log`に追記（先にcopy-truncateでローテーション） |
| `version` | `package.json`の`version` |
| `auth` | daemonとクライアントの間のHMACチャレンジ応答、プロトコルの版 |

`daemon.log`のローテーションは常にcopy-truncate。動いているdaemonが開いたままなので、名前を変えるとdaemonは`.old`に書き続けてしまう。確認するのは、中継かNative Hostがdaemonを起動する前と、Native Hostが動いている間の1時間ごと。`native-host.log`と`audit.jsonl`は名前を変える。

## テスト

`vitest.config.mts`のプロジェクトは`shared`、`mcp-server`、`native-host`（`packages/<pkg>/tests/`）、`contract`（`tests/contract/`）、`scripts`（`tests/scripts/`）、`e2e`（`tests/e2e/`。`npm run test:e2e`のときだけ）。拡張機能はプロジェクトにしていない。`background.ts`と`content.ts`はトップレベルでブラウザのリスナーを登録するので、契約テストはそのソースを読むか、副作用のないモジュール（`action-map.ts`、`approval.ts`、`url-rule.ts`）をimportする。テストファイルはどれも一時的なホームディレクトリで動く。

ゴールデンファイル（`tests/golden/`）は、うっかり変えてはならない動作を記録している。ツール呼び出しごとのBrowserCommandと安全ガードの判定（`tests/contract/tool-golden.test.ts`）と、セッションの`tools/list`（`tests/contract/tools-list.test.ts`）である。意図して変更したときは`UPDATE_GOLDEN=1 npx vitest run <test file>`で作り直し、差分を確認する。`node scripts/tools-list-size.mjs`は両方のツール一覧のサイズを表示する。

## 実機確認手順（ツール統合）

以前の41個のツールが21個になった（README: [ツール名の移行](../README.ja.md#ツール名の移行)）。テストが確認するのはサーバー側とヘッドレス経路（`npm run test:e2e`）で、この手順は実際のFirefoxでの拡張機能経路と、手作業でのヘッドレス経路を確認する。各手順をOK / NG / 未実施で記録し、NGのときは呼び出し、結果、対応する`daemon.log`の行を添える。

準備:

1. `npm ci && npm run build`を実行し、拡張機能を読み込み（README: [Firefoxへの拡張機能の読み込み](../README.ja.md#firefoxへの拡張機能の読み込み)）、`--doctor`で接続を確認する（README: [コマンドライン](../README.ja.md#コマンドライン)）。
2. ヘッドレスでの確認では、`FOX_HEADLESS=1`でdaemonを起動する（README: [ヘッドレスモード](../README.ja.md#ヘッドレスモード)）。拡張機能は同時に接続しない。
3. `safety.json`の`protected_url_patterns`にテスト用のホストを加える。たとえば、hostsファイルで名前を付けたローカルのHTTPサーバー。実在の銀行や決済のサイトは使わない。

ツール一覧:

| # | セッション | 期待する結果 |
|---|---|---|
| 1-1 | `FOX_CAPS`未設定 | 21個のツール。以前の名前はない |
| 1-2 | `FOX_CAPS=legacy` | 以前の41個のツール。置き換えられたものは説明が`[Deprecated: …]`で始まる |
| 1-3 | `FOX_CAPS=core,logs` | `core`のツール、`fox_logging`、`fox_get_logs`、`fox_safety_status` |

新しい名前（特に記載がなければ両方の経路）:

| # | 呼び出し | 期待する結果 |
|---|---|---|
| 2-1 | `fox_navigate` `{url}` | 遷移し、URLを返す |
| 2-2 | `fox_tab` `{action: "create", url}`、続けて`{action: "switch", tabId}`、続けて`{action: "close", tabId}` | タブを作り、切り替え、閉じる |
| 2-3 | `fox_tab` `{action: "create", url, container: {name: "Work"}}` | 拡張機能: コンテナのタブが開く。ヘッドレス: エラー（コンテナは非対応） |
| 2-4 | `fox_wait` `{for: "url", urlPattern}` | URLがすでに一致していればすぐに返り、そうでなければナビゲーションの後に返る |
| 2-5 | `fox_logging` `{action: "start"}`、ページでのfetch、`fox_get_logs` `{kind: "network"}` | 拡張機能: リクエストが一覧に出る。ヘッドレス: エラー（非対応） |
| 2-6 | `fox_evaluate` `{mode: "script", script: "document.title"}` | ページのタイトル |
| 2-7 | `fox_evaluate` `{mode: "chain", steps: [...]}` | 拡張機能: `Not implemented in extension`。ヘッドレス: 各ステップの結果 |
| 2-8 | `fox_read` `{mode: "text"}`、`fox_find` `{by: "text", text}` | ページのテキスト。一致した件数 |
| 2-9 | `fox_set_value` `{kind: "select", selector, option: {text}}` | optionが選択される |
| 2-10 | `fox_interact` `{action: "highlight", selector}` | 要素に枠が付く |

以前の名前（`FOX_CAPS=legacy`）:

| # | 呼び出し | 期待する結果 |
|---|---|---|
| 3-1 | `fox_get_text` `{}`を2回 | 2-8と同じ結果。末尾に`Note: fox_get_text is deprecated; use fox_read with mode='text'.`が付くのは1回目だけ |
| 3-2 | `fox_create_tab` `{url}` | 2-2のcreateの手順と同じ |
| 3-3 | 3-2の`audit.jsonl`の行 | `"tool": "fox_tab"`、`"legacyTool": "fox_create_tab"` |

保護対象サイト:

| # | 呼び出し | 期待する結果 |
|---|---|---|
| 4-1 | `fox_tab` `{action: "create", url: <protected URL>}` | 確認を求められる（MCP elicitationかツールバーのポップアップ）。承認すると呼び出しが1回動く |
| 4-2 | 4-1を拒否する | 何も動かない。結果に拒否されたと出る |
| 4-3 | 保護対象のページで`fox_interact` `{action: "scroll"}`（拡張機能） | 確認なしで動く（UIだけ） |
| 4-4 | daemonが把握している保護対象のページで`fox_set_value` `{selector, value}`（拡張機能） | 確認を求められる（安全ガード）。承認すると動く |
| 4-5 | 保護対象のページを手で開いてから4-4（daemonはそのURLを知らない） | 拡張機能がconfirmation_requiredで拒否し、確認を求められ、承認すると動く（承認したホストが拡張機能に届く） |
| 4-6 | 4-1を以前の名前`fox_create_tab`で行う（`FOX_CAPS=legacy`） | 同じ流れ。確認の質問に`fox_create_tab`が出る |

実機で確認できなかった手順は、報告の中で別にしておく。
