# 開発

[English](./development.md) | **日本語**

パッケージのビルドと確認の方法。Inari MCPの使い方は[README](../README.ja.md)を参照。

## 必要なもの

- 実行はNode.js 20以上（`package.json`の`engines`、インストーラの下限）。審査の再現ビルドはNode.js 24.xとnpm 11.x（`.nvmrc`、[BUILD.md](BUILD.md)）で、作った拡張機能のパッケージを提出したものと一致させる。
- `playwright`（`packages/mcp-server`の任意の依存。`--omit=optional`を付けなければ`npm ci`で入る）。`npm run build`に必要（ヘッドレスバックエンドがその型をimportする）。`npm run test:e2e`と`npm run e2e:extension`には、そのFirefox（`npx playwright install firefox`）も必要。

## 作業の流れ

リポジトリのルートで実行する。

```bash
npm ci
npm run build           # 全workspace（「ビルド」を参照）
npm run typecheck       # typecheckスクリプトを持つworkspace（現在は拡張機能だけ）のあとtypecheck:tests
npm run lint:install    # ESLintとTypeScript 6をtools/lint/node_modulesに入れる（初回と、そのlockfileが変わったとき）
npm run lint            # リポジトリ全体のESLint（「Lint」を参照）
npm test                # Vitest。e2e以外の全プロジェクト
npm run lint:ext        # packages/extensionのweb-ext lint
npm run pack:ext        # AMOに出す拡張機能のパッケージとファイルごとのハッシュ、続けてweb-ext lint（「リリース」を参照）
npm run pack:source     # AMOに出すソースのパッケージ（「リリース」を参照）
npm run e2e:extension   # 拡張機能が一時的なアドオンとしてFirefoxに読み込まれるか
```

`npm run test:e2e`（中継 → daemon → ヘッドレスFirefox）と`scripts/e2e/`のスクリプトは、READMEの「開発」に一覧がある。

`npm run smoke:reviewer`（`scripts/e2e/reviewer-smoke.mjs`）は、MCPクライアントとして127.0.0.1のテストページでツールを呼び、操作（タブを開く、クリック、タブを閉じる）は1回ずつ拡張機能のポップアップで承認されるまで待つ。`npm run smoke:reviewer -- --headless`は、拡張機能なしでヘッドレスFirefoxで動かす。そこでは誰も承認できないので、動くのはタブの一覧だけで、操作とその後の確認は`SKIP`になる。アドオンの審査者向けの手順は[amo/reviewer-smoke.md](./amo/reviewer-smoke.md)（英語）。

## ビルド

`npm run build`は全workspaceの`build`を実行する。

| パッケージ | ビルド | 出力 |
|---|---|---|
| `packages/shared` | `tsc -b` | `dist/`（`.d.ts`付き） |
| `packages/mcp-server` | `tsc -b` | `dist/`（`dist/index.js`が中継 / daemon / doctorの入口） |
| `packages/native-host` | `tsc -b` | `dist/` |
| `packages/extension` | `npm run typecheck`のあと`node ../../scripts/build-extension.mjs` | `dist/`（バンドル） |

### 拡張機能（esbuild）

`scripts/build-extension.mjs`は、拡張機能をesbuildで実行環境ごとに1つ、計4つの自己完結したIIFEのバンドルにし、静的ファイルをコピーする。

| 入口 | バンドル | 読み込む側 |
|---|---|---|
| `src/background.ts` | `dist/background.js` | `manifest.json`の`background.scripts` |
| `src/content.ts` | `dist/content.js` | `manifest.json`の`content_scripts` |
| `src/popup/popup.ts` | `dist/popup/popup.js` | `dist/popup/popup.html`（`browser_action.default_popup`） |
| `src/consent/consent.ts` | `dist/consent/consent.js` | `dist/consent/consent.html`（許可の画面。初回のインストール時にbackgroundが開く） |
| `src/popup/popup.html`、`src/popup/popup.css`、`src/consent/consent.html`、`src/consent/consent.css` | `dist/`にコピー | |

`manifest.json`が読み込むスクリプトは実行環境ごとに1本だけ。ビルドの詳細:

- 最初に`dist/`を消すので、古いファイルがパッケージに入ることはない。
- ターゲットは`firefox<strict_min_versionのメジャー番号>`。出力は縮小しない（AMOの審査で読めるように）。
- `npm run build:dev -w @inari-mcp/extension`はリンク付きのソースマップ（`dist/**/*.js.map`）も書く（`web-ext-config.mjs`でパッケージから除く）。
- esbuildは型検査をしない。型検査は拡張機能の`typecheck`スクリプト（`tsc -p tsconfig.json --noEmit`。拡張機能の`build`とルートの`npm run typecheck`が実行する）が行う。ソースはES module（`moduleResolution: bundler`、`isolatedModules`、`verbatimModuleSyntax`、`noUnusedLocals`、`noUnusedParameters`、`@types/node`なし）。
- バンドルにzodか`packages/shared/src/node`が入る、バンドルが`"use strict";`で始まらない、`manifest.json`が読み込むファイルがない、のどれかでビルドは失敗する。
- スクリプトを`packages/extension`の外に置いているのは、web-extが`web-ext-config.mjs`で除外していないファイルをすべてパッケージに入れるため。

`npm run lint:ext`はリポジトリのルートで`web-ext lint`を実行する。ルートの`web-ext-config.mjs`が`sourceDir: 'packages/extension'`と除外するファイル（`src`、`package.json`、`tsconfig.json`、ソースマップなど）を決めている。

## Lint

```bash
npm run lint:install && npm run lint
```

lintだけTypeScript 6で動き、ビルドと`npm run typecheck`はルートのTypeScript 7を使う。typescript-eslintのピア依存がまだTypeScript 7を許さないため、ESLint、typescript-eslint、TypeScript 6は`tools/lint`に分離し、専用の`package.json`とlockfileを持つ。`npm run lint:install`（`npm ci --prefix tools/lint`）がそこに入れる。設定は`tools/lint/eslint.config.js`。推奨のルールを全体に、型情報付きのルールをtsconfigの対象のファイルに当て、complexity、max-depth、max-params、max-nested-callbacks、max-lines-per-functionは警告にする。テストでは、型の緩いモックやフィクスチャで引っかかる型情報付きのルールを切る（理由は設定に書いてある）。

エラーがあると`npm run lint`は失敗する。警告では失敗しない。CIと`npm run pack:ext`はESLintを実行しないので、提出の前に`npm run lint:install`と`npm run lint`を実行する（「リリース」の手順3）。

## リリース

新しい版（例: 0.1.1）を出す手順。AMOへの提出は listed。審査者向けのビルド手順は[`BUILD.md`](./BUILD.md)（英語）で、ソースのパッケージの最上位に入る。

1. **版。** 6つのファイルの`version`を同じ値にする: `package.json`、`packages/shared/package.json`、`packages/mcp-server/package.json`、`packages/native-host/package.json`、`packages/extension/package.json`、`packages/extension/manifest.json`。`npm run build`とテストは確認しないが、`--doctor`は確認する（`versions`の項目）。手で書き換える。`npm version`は`package.json`を1つだけ変え（workspaceには`--workspaces`も要る）、`manifest.json`は変えず、変更履歴が固まる前にコミットとタグを作ってしまうため。そのあと`npm install --package-lock-only`で`package-lock.json`の版もそろえ、コミットする。AMOに提出した版は再提出できず、manifestの版は前の版より大きくする。
2. **変更履歴。** `docs/CHANGELOG.md`と`docs/CHANGELOG.ja.md`で「Unreleased」を版とその日の日付（`date`）に直し、利用者に見える変更がすべて載っているか確認する。
3. **確認。** `npm ci`、`npm run build`、`npm run typecheck`、`npm run lint:install`、`npm run lint`、`npm test`。CIはUbuntu 24.04 ARM64でlint以外の同じことを行う（`.github/workflows/ci.yml`）。lintはここでだけ実行する。
4. **コミットとタグ。** 作業ツリーがきれいな状態（`git status`が何も出さない）でコミットし、`git tag v<版>`。`npm run pack:source`は、きれいでない作業ツリーでは失敗する。
5. **パッケージ。** `npm run pack:ext`と`npm run pack:source`。どちらも`web-ext-artifacts/`（gitの対象外）に書く。
   - `inari_mcp_for_firefox-<版>.zip`と`.sha256.txt`: 拡張機能と、その中の各ファイルのSHA-256。`pack:ext`は、`web-ext lint`がエラーか警告を1件でも出すと失敗する。2回作ると同じハッシュになる（`tests/scripts/pack-extension.test.ts`）。zip自体はファイルの時刻が入って異なるので、`.sha256.txt`で比べる。
   - `inari-mcp-source-<版>.zip`: `HEAD`の管理下のファイルと`BUILD.md`。
6. **提出。** 先にリリースのコミットを`main`に取り込み、`main`とタグをpushする。拡張機能の許可の画面は`main`の`docs/PRIVACY.md`を、掲載ページとNotes for Reviewersはタグの`docs/PRIVACY.md`（`blob/v<版>/docs/PRIVACY.md`）を指すので、誰かが開く前に両方がGitHubに載っている必要がある。そのあとGitHubのreleaseを作って`.sha256.txt`を添付する。AMOのDeveloper Hubで、拡張機能のzipをlistedの版としてアップロードし、バンドルや縮小したコードを使うかと聞かれたらソースのzipをアップロードし、Notes for Reviewersに`docs/amo/reviewer-notes.md`の本文を`<version>`を置き換えて貼る。掲載ページのプライバシーポリシーのURLも新しいタグに直す（`docs/amo/listing.md`）。

CIはパッケージをアップロードしない（Actionsのストレージの節約）。手順5でローカルに作る。

## `@inari-mcp/shared`

| import | 内容 | 使う側 |
|---|---|---|
| `@inari-mcp/shared` | zodスキーマ（プロトコル、アクション、Native Hostのメッセージ）、アクション名、定数（`ENV`など）、小さなユーティリティ。Node.jsのAPIは使わない（`packages/shared/tests/browser-safe.test.ts`で確認） | daemon、中継、Native Host。拡張機能はzodを引き込まないexportだけ |
| `@inari-mcp/shared/action-names` | ブラウザコマンドのアクション名。zodなし | 拡張機能 |
| `@inari-mcp/shared/field-mask` | 値を伏せる（`[MASKED]`にする）フォーム欄の規則と、読み取るツールが拒否するCSSセレクタ（`[value…]`、`[selected]`、`:checked`、`:default`）。importなし | 拡張機能（ヘッドレスは`@inari-mcp/shared`から使う） |
| `@inari-mcp/shared/approval-site` | 人の承認が結び付くサイト（`approvalSiteOf`）。importなし | 拡張機能（daemonは`@inari-mcp/shared`から使う） |
| `@inari-mcp/shared/url-pattern-limit` | 引数`urlPattern`の長さと形の制限。importなし | 拡張機能（daemonは`@inari-mcp/shared`から使う） |
| `@inari-mcp/shared/node` | Node.jsのプロセス用の共通処理（下表） | daemon、中継、Native Host、doctor |

拡張機能は`@inari-mcp/shared`を`dist/`ではなくソース（`packages/shared/src`）からバンドルする。解決できるのは`@inari-mcp/shared`、`@inari-mcp/shared/action-names`、`@inari-mcp/shared/field-mask`、`@inari-mcp/shared/approval-site`、`@inari-mcp/shared/url-pattern-limit`だけで、それ以外のサブパス（`/node`を含む）はビルドエラーになる。拡張機能の`tsconfig.json`も同じ5つの名前をソースに対応させている。Vitestも6つのimportをすべてソースに解決するので、テストにビルドは要らない。

`@inari-mcp/shared/node`のモジュール（`packages/shared/src/node/`）:

| モジュール | 内容 |
|---|---|
| `paths` | `~/.inari-mcp/`の下のファイル（データとログのディレクトリ、APIトークン、`daemon.log`、`native-host.log`、監査ログ、既定の`safety.json`とスクリーンショットのディレクトリ）。呼び出し時に解決する |
| `endpoint` | `FOX_HOST` / `FOX_HTTP_PORT` / `FOX_WS_PORT`、ループバックの判定（`resolveDaemonHost`: daemon、Native Host、中継はループバックでない`FOX_HOST`を拒否する） |
| `token` | APIトークンの読み込みと作成（作成はdaemonだけ） |
| `health` | `GET /health`の応答の判定（daemonの多重起動確認、中継、Native Host、doctor） |
| `log` | 5 MBでの`<file>.old`へのローテーション（名前の変更、またはcopy-truncate）、行頭の`<ISO時刻> [<pid>] `、`[InariMCP:<role>]`のstderrロガー |
| `spawn` | daemonを切り離したプロセスとして起動する。stderrは`daemon.log`に追記（先にcopy-truncateでローテーション） |
| `version` | `package.json`の`version` |
| `auth` | daemonとクライアントの間のHMACチャレンジ応答、プロトコルの版 |

`daemon.log`のローテーションは常にcopy-truncate。動いているdaemonが開いたままなので、名前を変えるとdaemonは`.old`に書き続けてしまう。確認するのは、中継かNative Hostがdaemonを起動する前と、Native Hostが動いている間の1時間ごと。`native-host.log`と`audit.jsonl`は名前を変える。

## テスト

`vitest.config.mts`のプロジェクトは`shared`、`mcp-server`、`native-host`（`packages/<pkg>/tests/`）、`contract`（`tests/contract/`）、`scripts`（`tests/scripts/`）、`e2e`（`tests/e2e/`。`npm run test:e2e`のときだけ）。実際のヘッドレスFirefoxを動かすテストファイルは別のプロジェクト`mcp-server-firefox`と`contract-firefox`（それぞれ再試行1回）に分けてあるので、`npx vitest run --project=mcp-server`だけでは実行されない。`--project=mcp-server-firefox`も付ける。Firefoxを起動できないとき、これらのテストはスキップになる。ただしCIでは（`CI`が空・`0`・`false`以外に設定されていると）スキップせずに失敗する。`INARI_REQUIRE_FIREFOX`（値の扱いは同じ）を設定すると、`CI`がなくても同じになる。`npm run test:firefox`はこの2つのプロジェクトだけを`INARI_REQUIRE_FIREFOX=1`で動かし、スキップしたテストが1件でもあれば失敗する。実際のブラウザーのテストが動いたことを確かめるには、Firefoxのある環境（CIも）でこれを実行する。拡張機能はプロジェクトにしていない。`background.ts`と`content.ts`はトップレベルでブラウザのリスナーを登録するので、契約テストはそのソースを読むか、副作用のないモジュール（`action-map.ts`、`approval.ts`、`url-rule.ts`）をimportする。テストファイルはどれも一時的なホームディレクトリで動く。

`npm run typecheck:tests`（`npm run typecheck`の後半）は、`tsconfig.test.json`でテストを型検査する。対象は`packages/*/tests`、`tests/contract`、`tests/e2e`、`tests/scripts`、`tests/setup`。`bundler`の解決方法と、`vitest.config.mts`と同じ`@inari-mcp/shared`のパスを使うので、ビルドは要らない。

ゴールデンファイル（`tests/golden/`）は、うっかり変えてはならない動作を記録している。ツール呼び出しごとのBrowserCommandと安全ガードの判定（`tests/contract/tool-golden.test.ts`）と、セッションの`tools/list`（`tests/contract/tools-list.test.ts`）である。意図して変更したときは`UPDATE_GOLDEN=1 npx vitest run <test file>`で作り直し、差分を確認する。`node scripts/tools-list-size.mjs`はツール一覧のサイズを表示する。

## 実機確認手順（ツール）

Inari MCPのツールは17個で、関連する操作は1つのツールにまとめ、モード引数で切り替える（README: [特徴](../README.ja.md#特徴)）。テストが確認するのはサーバー側とヘッドレス経路（`npm run test:e2e`）で、この手順は実際のFirefoxでの拡張機能経路と、手作業でのヘッドレス経路を確認する。各手順をOK / NG / 未実施で記録し、NGのときは呼び出し、結果、対応する`daemon.log`の行を添える。

準備:

1. `npm ci && npm run build`を実行し、拡張機能を読み込み（一時的なアドオンとして。README: [AMOから拡張機能を入れる](../README.ja.md#amoから拡張機能を入れる)）、`--doctor`で接続を確認する（README: [コマンドライン](../README.ja.md#コマンドライン)）。
2. ヘッドレスでの確認では、`FOX_HEADLESS=1`でdaemonを起動する（README: [ヘッドレスモード](../README.ja.md#ヘッドレスモード)）。拡張機能は同時に接続しない。
3. `safety.json`の`confirm_read_sites`にテスト用のホストを加える。たとえば、hostsファイルで名前を付けたローカルのHTTPサーバー。実在の銀行や決済のサイトは使わない。
4. 操作系の呼び出し（遷移、`fox_tab`のcreate / close、`fox_set_value`、クリック、入力）はすべて承認を求める。下の手順で呼び出しが動くことを期待しているときは承認する。

ツール一覧:

| # | セッション | 期待する結果 |
|---|---|---|
| 1-1 | `FOX_CAPS`未設定 | 17個のツール |
| 1-2 | `FOX_CAPS=core,human` | `core`のツール、`fox_request_approval`、`fox_detect_captcha`、`fox_safety_status` |

ツールの呼び出し（特に記載がなければ両方の経路）:

| # | 呼び出し | 期待する結果 |
|---|---|---|
| 2-1 | `fox_navigate` `{url}` | 遷移し、URLを返す |
| 2-2 | `fox_tab` `{action: "create", url}`、続けて`{action: "switch", tabId}`、続けて`{action: "close", tabId}` | タブを作り、切り替え、閉じる |
| 2-3 | `fox_tab` `{action: "create", url, container: {name: "Work"}}` | 拡張機能: コンテナのタブが開く。ヘッドレス: エラー（コンテナは非対応） |
| 2-4 | `fox_wait` `{for: "url", urlPattern}` | URLがすでに一致していればすぐに返り、そうでなければナビゲーションの後に返る |
| 2-5 | `fox_read` `{mode: "text"}`、`fox_find` `{by: "text", text}` | ページのテキスト。一致した件数 |
| 2-6 | `fox_set_value` `{kind: "select", selector, option: {text}}` | optionが選択される |
| 2-7 | `fox_interact` `{action: "highlight", selector}` | 要素に枠が付く |
| 2-8 | ページでfetchが続いている間に`fox_wait` `{for: "network_idle"}` | 拡張機能: fetchが終わってから返る。その後、ページの`fetch`はページ自身のものに戻っている（ページのコンソールで`window.fetch.toString()`が`[native code]`を表示する） |

人による承認:

| # | 呼び出し | 期待する結果 |
|---|---|---|
| 3-1 | `fox_tab` `{action: "create", url}` | URLのサイトでの`fox_tab`を許可するか、引数と一緒に尋ねられる（MCP elicitationかツールバーのポップアップ）。承認すると呼び出しが1回動く |
| 3-2 | 3-1を拒否する | 何も動かない。結果に拒否されたと出る |
| 3-3 | `fox_interact` `{action: "scroll"}`、`fox_read` `{mode: "text"}`、`fox_tab` `{action: "switch", tabId}`（拡張機能） | 尋ねずに動く |
| 3-4 | daemonが把握しているページで`fox_set_value` `{selector, value}`を2回（拡張機能） | 毎回尋ねられる。承認するたびに1回動く |
| 3-5 | タブを手で別のサイトへ移してから3-4（daemonはそのURLを知らない） | 前のサイトについて尋ねられる。承認すると拡張機能がconfirmation_requiredで拒否し、実際のサイトについて尋ねられ、承認すると動く（承認したサイトが拡張機能に届く） |
| 3-6 | `confirm_read_sites`のテスト用ホストで`fox_read` `{mode: "text"}`、続けて別のページで同じ呼び出し | テスト用ホストでだけ尋ねられる |
| 3-7 | daemonを起動した直後に`fox_click` `{tabId: <あるタブ>, selector}` | 尋ねずに拒否される。結果に、まだ承認できないこと、先に`fox_tabs`を呼ぶことが出る |
| 3-8 | ローカルのテスト用ページ（`file://`）で`fox_click` `{selector}`（拡張機能） | サイト`file:`について尋ねられる。承認すると動く |

実機で確認できなかった手順は、報告の中で別にしておく。
