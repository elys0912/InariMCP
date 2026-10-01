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
