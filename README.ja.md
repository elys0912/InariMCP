# KitsuneMCP

[English](./README.md) | **日本語**

**普段使いのFirefoxをClaude Codeから操作する。** Firefox専用のMCPアドオン — 使い捨てブラウザではなく、あなたの実プロファイル・実ログインをそのまま使う。

> ステータス: **開発初期 — インストーラは完成済み（Windows・macOS・Linux。macOSは実機で未検証）で、拡張機能経路はエンドツーエンドで動く。** AMO / GitHub Releases経由での署名済みパッケージ配布は準備中。下記の[Status](#status)を参照。

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

- **21個の`fox_*`ツール** — ナビゲーション、クリック/入力/スクロール、スクリーンショット（可視範囲/全ページ/全タブ）、タブ管理、コンソール/ネットワークログ収集、スクリプト実行、待機をカバー。関連する操作は1つのツールにまとめ、モード引数で切り替える（`fox_wait`の`for: "url"`、`fox_tab`の`action: "close"`など）。以前の41個のツール名も使える。[ツール名の移行](#ツール名の移行)を参照。Playwright MCPと併用しても衝突しないよう`browser_`ではなく`fox_`をプレフィックスにしている。まだすべての経路で動くわけではない。[ツールの対応状況](#ツールの対応状況)を参照。
- **ツールプロファイル（`FOX_CAPS`）** — 全てのツールを登録すると実際にコンテキストトークンを消費する。プロファイル（`core`、`logs`、`script`など）を選んで必要な分だけ読み込める。[`FOX_CAPS`のプロファイル](#fox_capsのプロファイル)を参照。
- **8層の安全ガード（レイヤー0〜7）** — コンテナスコープ（0）、レート制限（1）、URLスキームの確認とブロック/許可リスト（2〜3）、観察系ツールの通過（4）、読み取り専用モード（5）、スクリプト実行トグル（6）、銀行・決済処理業者・`.gov`などの保護対象ドメインでの人による承認（7）。判定はすべてJSONLの監査ログに残る。ガード自体は常に動作していて、オプトインが必要なのはコンテナスコープ（レイヤー0）だけ。
- **ページの外での承認** — 保護対象サイトでの操作は、Claude Code自身の確認ダイアログ（MCP elicitation）か、FirefoxのKitsuneMCPツールバーのポップアップで人が承認する。ページの中からは承認できない。[保護対象サイトでの人による承認](#保護対象サイトでの人による承認)を参照。
- **コンテナ分離（オプトイン）** — Firefoxの`contextualIdentities`を使い、エージェントを専用コンテナに制限できる。これにより、他のタブで開いている銀行・メールのセッションをエージェントから見えなくできる。これはFirefox専用の機能で、Chromiumには同等のものが存在しない。
- **ヘッドレスモード（上級者向け）** — 拡張機能経由を使いたくない場合のための、Playwrightベースの、Firefox専用ヘッドレスバックエンド。使えないツール・引数が多い（[ツールの対応状況](#ツールの対応状況)を参照）。
- **Firefoxネイティブなapi** — トークンを節約できるページ内テキスト検索用の`browser.find`、全ページ・全タブのスクリーンショット用の`tabs.captureTab`（背景タブの可視範囲を撮るときは、そのタブを一瞬前面に出してから元に戻す）。

## クイックスタート

### 前提条件

- Node.js >= 18.0.0（KitsuneMCPの実行に必要。開発時の要件は[開発](#開発)を参照）
- Firefox 142以降（拡張機能の`strict_min_version`）。Developer EditionとNightlyも通常版と同じNative Messagingの登録を読む
- （ヘッドレスモードのみ）PlaywrightとそのFirefox。`playwright`は`packages/mcp-server`の任意の依存（optionalDependencies）で、任意の依存を除かない限り（`--omit=optional`）`npm ci`で入る。Firefoxは別にダウンロードする: `npx playwright install firefox`

PowerShellは不要。インストーラとアンインストーラはNode.jsのスクリプト。

### インストール

```bash
git clone https://github.com/elys0912/KitsuneMCP.git
cd KitsuneMCP
npm ci
npm run build
npm run setup
```

インストーラはWindows・macOS・Linuxで同じように動く。macOSは実機では未検証（[Status](#status)参照）。LinuxのFirefoxはディストリビューションのパッケージ（deb/rpm）、MozillaのAPTリポジトリ、mozilla.orgのtarballのいずれかが確実。Snap版とFlatpak版はデスクトップポータルが必要になる（[環境ごとの注意](#環境ごとの注意)を参照）。

`npm run setup`（`node scripts/install.mjs`）が行うこと:

1. Node.js（18以上）とビルド結果（`packages/*/dist`）を確認し、Firefoxを探す（見つからなくても警告だけ）
2. Native Messaging hostのラッパー（`run-host.cmd` / `run-host.sh`）を`~/.kitsune-mcp/native-host/`に書く
3. hostのマニフェスト`kitsune_mcp.json`をFirefoxが読む場所に書く（Windows: ラッパーと同じ場所に置き、全エディション共通の`HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp`から参照する。macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/`。Linux: `~/.mozilla/native-messaging-hosts/`と、XDG・Snap・Flatpak版がありそうならそれぞれの置き場）
4. `claude mcp add`のコマンドを表示する。`--register-claude`を付けると実行する（[Claude Codeへの追加](#claude-codeへの追加)を参照）

何度実行してもよい。変わっていないファイルと登録はそのままにする。指定しない限りビルドはしない（`--build`で先に`npm install`と`npm run build`を実行する）。オプションはnpm経由なら`--`の後に書く（`npm run setup -- --register-claude`）か、スクリプトを直接呼ぶ（`node scripts/install.mjs --register-claude`）。

| オプション | 効果 |
|---|---|
| `-n`、`--dry-run` | 何が変わるかを表示するだけで、何も変えない |
| `-y`、`--yes` | すべての質問にyesで答える（質問しない） |
| `--register-claude` | Claude CodeにMCPサーバーを登録する（既定はコマンドの表示だけ） |
| `--claude-scope user\|local\|project` | `claude mcp add`のスコープ（既定は`user` = 全プロジェクト共通） |
| `--node PATH` | 登録するnodeの実行ファイル（既定はインストーラを実行しているnode） |
| `--build` | 先に`npm install`と`npm run build`を実行する |
| `--manual` | 手作業でのインストール手順（Markdown）を表示して終わる |
| `-h`、`--help` | 使い方と、このマシン向けの手作業の手順を表示する |

質問するのは標準入力が端末のときだけで、そうでなければ既定の答えを使う。`--skip-build`と`--no-register-claude`も受け付ける。以前の`npm run install:windows` / `install:unix`は`node scripts/install.mjs --build`の別名として残っている。

**Node.jsを入れ替えた・アップグレードした場合は、インストーラを実行し直すこと** — 生成されるラッパーには、インストーラを実行したnodeバイナリの絶対パスが埋め込まれている（そのバイナリが無くなった場合は、Firefoxの`PATH`上の`node`で起動する）。そのnodeがバージョンマネージャーのもの（バージョンを切り替えるとパスが変わる）ならインストーラが警告する。`--node`で変わらないパスを指定できる。

### Firefoxへの拡張機能の読み込み

署名済みでワンクリックインストールできる`.xpi`はまだ配布していない（AMO署名 + GitHub Releasesでの配布は準備中）。今のところは一時的なアドオンとして読み込む。

1. Firefoxで`about:debugging#/runtime/this-firefox`を開く
2. 「一時的なアドオンを読み込む」→ `packages/extension/manifest.json`を選択（`packages/extension/dist/`のバンドルを読み込むので、先に`npm run build`を実行しておく）
3. Firefoxを再起動すると消えるので、その都度読み込み直す必要がある

ツールバーにKitsuneMCPのボタンが出る。ポップアップに接続状態が表示される（[再起動と接続確認](#再起動と接続確認)を参照）。

### Claude Codeへの追加

`npm run setup -- --register-claude`でKitsuneMCPをClaude Codeに登録する（`claude mcp add`、既定スコープ`user` = 全プロジェクト共通、nodeは絶対パス）。このインストールを指す登録が既にあればそのままにし、別の場所を指していれば確認してから置き換える。`--register-claude`を付けなかった場合や`claude`が`PATH`に無い場合は、インストーラが表示するコマンドを自分で実行する。

```bash
claude mcp add --scope user kitsune-mcp -- node <INSTALL_PATH>/packages/mcp-server/dist/index.js
```

サーバーへの環境変数は名前の前に書く。例: `claude mcp add --scope user --env FOX_CAPS=core,logs kitsune-mcp -- node …`（頼る前に[先にdaemonを起動した側の設定が勝つ](#先にdaemonを起動した側の設定が勝つ)を読むこと）。

または、MCP設定に手動で追加する（`config/mcp_config.json`も同じテンプレート）。

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

`<INSTALL_PATH>`はクローンした場所の絶対パスに置き換える。

### 再起動と接続確認

1. **Claude Codeを再起動する**（実行中のセッションは新しいMCPサーバーを読み込まない）。
2. 拡張機能が読み込まれていることを確認する（Firefoxを再起動するたびに読み込み直す）。
3. KitsuneMCPのツールバーボタンを見る。

| バッジ / ポップアップ | 意味 | 対処 |
|---|---|---|
| バッジなし、「Connected」/「Connected (N)」 | FirefoxとN個のClaude Codeセッションが接続している | 不要 |
| 赤い`!`、「No session」 | Firefox側は準備済みだが、KitsuneMCPを使うClaude Codeのセッションがない | 登録して（ポップアップにコマンドが出る）Claude Codeを再起動する。実行中のセッションは約30秒で表示される |
| 赤い`!`、「Setup needed」（native hostが見つからない） | FirefoxがNative Messaging hostを見つけられない | ビルドしてインストーラを実行し（ポップアップにコマンドが出る）、Recheckを押す（Snap版 / Flatpak版Firefoxは[環境ごとの注意](#環境ごとの注意)を参照） |
| 赤い`!`、「Setup needed」（native hostが失敗 / MCPサーバーが応答しない） | hostは登録済みだが起動しない、またはdaemonが応答しない | インストーラ（`npm run setup`）を再実行する（ポップアップのコマンドはビルドもする。よくある原因はNode.jsのアップグレード・移動）。下記のログを見る |
| 赤い`!`、「Update needed」 | クローンが拡張機能より古い | `git pull`してビルドし、インストーラを再実行して、Firefoxを再起動する |
| 黄色の数字 | あなたの承認を待っている要求がある | ポップアップを開いて承認か拒否をする |

4. 診断を実行する: `node packages/mcp-server/dist/index.js --doctor`（[コマンドライン](#コマンドライン)を参照）。ビルド、Firefoxへの登録、Claude Codeへの登録、daemon、ログを確認し、問題ごとに対処を表示する。
5. Claude Codeに`fox_safety_status`を呼ばせる。有効な安全ポリシー（読み取り専用モード、スクリプトの可否、URLパターン、レート制限、監査ログの場所）が表示され、動いているdaemonがこのセッションと違う設定で起動されていれば警告も出る。ブラウザが接続しているかどうかは表示されない。
6. 低いレベルで確認するときはdaemonに問い合わせる。

```bash
curl --noproxy '*' -sS http://127.0.0.1:8765/health    # Windows PowerShell: curl.exe --noproxy "*" -sS …
```

（`--noproxy`は設定済みのHTTPプロキシをローカルへの要求から外す。）`"status":"ok"`ならdaemonは動いている。拡張機能が接続すると（読み込みから数秒後）`browsers_connected`が`1`になる。何も応答しない（「Connection refused」）ならdaemonはまだ動いていない。daemonは最初のClaude Codeセッションか、拡張機能を読み込んだFirefoxが起動し、10分使われなければ終了する。そのうえでログを見る。

### ログ

すべて`~/.kitsune-mcp/logs/`にある。

| ファイル | 書き込み元 |
|---|---|
| `native-host.log` | Native Host（`FOX_NATIVE_HOST_LOG`で変更でき、`0`/`off`で無効化） |
| `daemon.log` | 共有daemonのstderr |
| `audit.jsonl` | 安全ガードの監査ログ（`safety.json`の`audit_log`） |

`native-host.log`と`daemon.log`の各行は`<ISO 8601の時刻> [<pid>] `で始まる。各ファイルは5 MBを超えると`<名前>.old`に退避される（1世代だけ残る）。`native-host.log`と`audit.jsonl`は名前を変える。動いているdaemonが開いたままの`daemon.log`は、`daemon.log.old`に複製してから中身を空にする（copy-truncate。その間に書かれた行は失われる）。

### コマンドライン

```
node packages/mcp-server/dist/index.js [オプション]
```

| オプション | 効果 |
|---|---|
| （なし） | stdioのMCP中継。Claude Codeが起動するもの。共有daemonが動いていなければ起動する |
| `--daemon` | 共有daemon。通常は中継かNative Hostが自動で起動する |
| `--doctor`（または`doctor`） | インストールと動いているdaemonを確認する |
| `-h`、`--help` | 使い方を表示する |
| `-v`、`--version` | 版を表示する |

`--help`と`--version`は、ほかの処理より前に表示して終わる。daemonは起動せず、APIトークンもログファイルも作らない。知らない引数（または2つのモードの同時指定）は終了コード2で終わる。

`--doctor`は項目ごとに`OK`・`WARN`・`FAIL`・`SKIP`を1行ずつ表示し、問題には対処を添える。FAILが1つでもあれば終了コード1（なければ0）。`native-messaging`の登録がないのはWARN（拡張機能の経路（Firefox）では必要、ヘッドレスだけなら不要）。14項目: `node`、`versions`（全パッケージと拡張機能のマニフェストの版が一致するか）、`build`（`dist`がソースより新しいか）、`native-messaging`（Firefoxへの登録と、マニフェストのname・type・許可する拡張機能・path）、`nm-wrapper`（ラッパーがこのチェックアウトを指し、そのnodeがあるか）、`claude`（Claude Codeへの登録。`~/.claude.json`と`.mcp.json`から読む）、`powershell`（Windows: Native Hostが使えるか）、`daemon`（`/health`のprotocol・proof・版）、`token`、`settings`（ここでの`FOX_*`と動いているdaemonの差）、`browsers`（接続しているNative Host）、`safety-config`（`safety.json`が読めて正しいか）、`screenshots`（`FOX_SCREENSHOTS_DIR`）、`logs`（サイズ、Native Hostの起動試行の上限）。読み取りだけで、トークンを作らず、daemonを起動せず、ログを書かず、`claude mcp get`も実行しない（実行するとサーバーが起動して接続を試すため）。

`scripts/e2e/nm-probe.mjs [manifest.json]`は、Firefoxと同じ方法でNative Messaging hostを起動し（既定はインストールしたマニフェスト）、`ping`と`status`を送って、daemonに届くかを確かめる（終了コード0 = 成功、1 = 失敗、2 = 引数の誤り）。daemonが動いていなければ起動する。

### ヘッドレスモード

拡張機能をインストールしたくない場合は、`FOX_HEADLESS=1`を設定してdaemonを起動すると、実際のブラウザと通信する代わりにPlaywrightで管理されたFirefoxインスタンスを直接操作する。

```bash
FOX_HEADLESS=1 node packages/mcp-server/dist/index.js
```

（または`claude mcp add --env FOX_HEADLESS=1 …`）。有効になるのは`1`・`true`・`yes`（大文字小文字は問わない）だけで、それ以外の値では無効のまま。「無効」として知られた値（`0`・`false`・`no`・`off`）以外、たとえば`on`なら、daemonがログに警告を出す。`FOX_HEADLESS_STARTUP_TIMEOUT`はFirefox起動のタイムアウト（ミリ秒、既定`45000`）。`playwright`が入っていないと、daemonは起動時に`daemon.log`へ`FOX_HEADLESS needs the optional dependency playwright, which is not installed (…)`と出して終了する。メッセージのとおり`playwright`（`--omit=optional`を付けずに`npm ci`、または`packages/mcp-server`で`npm install playwright`）とそのFirefox（`npx playwright install firefox`）を入れる。これらの設定が効くのは、このセッションがdaemonを起動した場合だけ（[下記](#先にdaemonを起動した側の設定が勝つ)を参照）。

これにより実際のセッション/cookie/ログイン状態は失われる点に注意 — 使い捨てプロファイルになる、Playwright MCPと同じトレードオフ。使えないツール・引数が多く（無視した引数は結果の`warnings`に並ぶ）、ブラウザのポップアップで尋ねる相手もいないので、保護対象サイトでの操作はMCP elicitationでしか承認できない。ヘッドレスモードにはFirefoxのコンテナがないので、`safety.json`で`container_scope.enabled`にしているとブラウザへのコマンドはすべて拒否される。ヘッドレスのdaemonにはコンテナスコープを切った専用の`safety.json`を`FOX_SAFETY_CONFIG`で渡す。実際にログイン済みのFirefoxを使いたい場合は拡張機能経由を使うこと。

### 更新

```bash
git pull
npm ci
npm run build
npm run setup
```

その後、`about:debugging`で拡張機能を再読み込みし（またはFirefoxを再起動して読み込み直し）、Claude Codeを再起動する。古い版のdaemonは止めるまで動き続ける。新しい中継やNative Hostが、動いているdaemonについて「speaks protocol …」「is from another version」と報告したら、そのdaemonのプロセスを止める（Native Hostが起動したものならFirefoxも再起動する）。次のツール呼び出しで対応する版のdaemonが起動する。

#### 更新時の注意

- **`re:`のURLパターンはURL全体に一致するようになった**。すべてのリストで`^(?:<正規表現>)$`として扱う（[`safety.json`](#safetyjson)を参照）。前方一致のつもりで書いた既存の`re:`パターン、たとえば`re:^https://example\.com/`は、それより長いURLに一致しなくなる。`allowed_url_patterns`ではそのURLが拒否されるようになり、`blocked_url_patterns` / `protected_url_patterns`ではブロック・保護の対象から外れる（許可される側に変わる）。このための警告は出ない。前方一致のままにするには末尾に`.*`を付ける（`re:^https://example\.com/.*`）。たとえば開発中の版が`protected_url_patterns`に書いた既定値`re:^https?://(?:[^/?#@]+\.)?mychart\.`は、現在は`re:https?://(?:[^/?#@]+\.)?mychart\..*`になっている。`re:`の付かないパターンは影響を受けない。daemonを再起動したら`fox_safety_status`で結果を確認すること。

### アンインストール

```bash
npm run teardown
```

`npm run teardown`（`node scripts/uninstall.mjs`）は、外したものが元に戻らない順に外す。

1. FirefoxのNative Messagingの登録（レジストリキー / マニフェストファイル）。これで拡張機能がNative Hostを起動し直せなくなる
2. `~/.kitsune-mcp/native-host/`（ラッパー）
3. Claude Codeの登録。確認して同意したときか`--unregister-claude`を付けたとき（見つけられるのはリポジトリのディレクトリから見える登録だけ。別のディレクトリで`local`スコープで登録したものは一覧に出すので、そこで削除する）
4. このリポジトリの動いているNative Hostのプロセス、続いてdaemon（ポートの相手がKitsuneMCPのdaemonであることを確かめてから。SIGTERM、猶予の後にSIGKILL）
5. `--purge`を付けたときは`~/.kitsune-mcp/`の残り（APIトークン、`safety.json`、ログ、スクリーンショット）。付けなければ残りは一覧を表示するだけで削除しない

KitsuneMCPを使っているClaude Codeのセッションが残っていると、次のブラウザツールの呼び出しでdaemonを起動し直す。アンインストーラがそれを表示するので、再起動する。リポジトリとFirefoxの拡張機能は変更しない（拡張機能はFirefoxで外す）。

オプション（npm経由では`--`の後）: `-n`/`--dry-run`、`-y`/`--yes`（Claude Codeの登録も削除する）、`--unregister-claude`、`--keep-claude`、`--no-stop`（何も止めない）、`--grace 秒`（既定5）、`--purge`、`--manual`、`-h`/`--help`。`--stop-daemon`、`--no-stop-daemon`、`--no-unregister-claude`も受け付ける。`npm run uninstall:windows` / `uninstall:unix`は別名として残っている。

### 手作業での設定

インストーラを実行できない環境では手作業で設定する。`node scripts/install.mjs --manual`と`node scripts/uninstall.mjs --manual`が全プラットフォームの手順を表示し、`--help`はこのマシン向けにパスを埋めた手順を表示する。Windowsでインストーラを使わない場合:

1. ビルド: リポジトリで`npm ci`と`npm run build`を実行する。
2. フォルダ`%USERPROFILE%\.kitsune-mcp\native-host`を作る。
3. `%USERPROFILE%\.kitsune-mcp\native-host\run-host.cmd`を作る（フルパスを使う。パス中の`%`は`%%`と書く）。

   ```bat
   @echo off
   cd /d "C:\path\to\KitsuneMCP\packages\native-host"
   "C:\Program Files\nodejs\node.exe" "C:\path\to\KitsuneMCP\packages\native-host\dist\index.js" %*
   ```

4. `packages\native-host\kitsune_mcp.json`を`%USERPROFILE%\.kitsune-mcp\native-host\kitsune_mcp.json`にコピーし、`"path"`を`run-host.cmd`のフルパスにする（JSONでは`\`を`\\`と書く）。
5. Firefoxに登録する（全エディションがこのキーを読む）。

   ```bat
   reg add "HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp" /ve /t REG_SZ /d "%USERPROFILE%\.kitsune-mcp\native-host\kitsune_mcp.json" /f
   ```

6. 任意、Claude Code: `claude mcp add --scope user kitsune-mcp -- "C:\Program Files\nodejs\node.exe" "C:\path\to\KitsuneMCP\packages\mcp-server\dist\index.js"`

Windowsで手作業でアンインストールするには（順番が大事。hostが登録されたままFirefoxが拡張機能を動かしていると、Native Hostがdaemonを起動し直す）: `reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp" /f`、`rmdir /s /q "%USERPROFILE%\.kitsune-mcp\native-host"`、`claude mcp remove --scope user kitsune-mcp`を実行し、Firefoxで拡張機能を外すかFirefoxを終了する。`netstat -ano | findstr :8765`でdaemonを探して`taskkill /PID <pid> /F`で止める。必要なら`rmdir /s /q "%USERPROFILE%\.kitsune-mcp"`。

WindowsのNative Hostは、daemonをFirefoxのジョブオブジェクトの外で起動する（そうしないと、Firefoxを閉じたときにdaemonと、それを使うClaude Codeのセッションが止まる）。まずPowerShellを試し、次にWMI（`cscript`）、一回限りのタスク スケジューラのタスク（`schtasks`）を試す。すべて失敗したときだけ、daemonをジョブの中で起動し、`native-host.log`に警告を出す。

### 環境ごとの注意

- **Snap版Firefox**（Ubuntuの既定の`firefox`）は、xdg-desktop-portalのWebExtensionsポータルを通してNative Messaging hostを起動する。環境によっては動かない。インストーラはマニフェストを`~/.mozilla/native-messaging-hosts/`とsnapの中に書く。動かなければMozillaのAPTリポジトリからdeb版を入れる。
- **Flatpak版Firefox**はサンドボックスの中からホストのnodeを実行できない。インストーラはマニフェストを`~/.var/app/org.mozilla.firefox/`にも書くが、Firefoxがhostに届くのはポータル経由のときだけ。`about:config`で`widget.use-xdg-desktop-portal.native-messaging`を`1`にする（WebExtensionsに対応したxdg-desktop-portalが必要）。そうしないと、ポップアップに「Setup needed」と出てもインストーラの再実行では直らない。Flatpak以外のFirefoxが確実。
- **WSL**: Claude CodeとFirefoxは同じ側で動かす。WSLの中のClaude CodeとWindowsのFirefoxを組み合わせると、それぞれが自分の`~/.kitsune-mcp/`（とAPIトークン）でdaemonを起動するので、WSLのセッションはWindowsのFirefoxに届かない。Claude CodeをWindowsで動かすか、FirefoxをWSLの中（WSLg）で動かしてインストーラもそこで実行する。WSLの中で実行するとインストーラが警告する。
- **Firefoxのプロファイルを複数**同時に開くと、すべてが1つのdaemonに接続し、コマンドは先に接続した方に送られる。どちらが使われているかはどこにも表示されない。

## アーキテクチャ

4つのTypeScriptパッケージからなるモノレポ。

| パッケージ | 役割 |
|---|---|
| `packages/shared` | 他の3パッケージで使われる共有のzodスキーマ、アクション名、定数。サブパス`@kitsune-mcp/shared/node`には、Node.jsのプロセス用の共通処理（パス、接続先、APIトークン、`/health`、ログ、daemonの起動、版、HMAC認証）がある。拡張機能はブラウザで使える部分だけをzod抜きでバンドルする（[開発](#開発)を参照）。 |
| `packages/mcp-server` | 1つの実行ファイルで2つの役割を持つ。既定では薄いstdio中継で、Claude Codeがセッションごとに1つ起動し、`fox_*`ツールの一覧を返して、呼び出しを共有サーバーに転送する。`--daemon`を付けるとその共有サーバーになる。HTTP/WebSocketのポートを持つ唯一のプロセスで、安全ガードを実行し、Native HostへのWebSocket（優先）かヘッドレスPlaywrightバックエンド（上級者向け）にコマンドをディスパッチする。 |
| `packages/native-host` | 共有サーバーとFirefox拡張機能の間のネイティブメッセージングブリッジ。共有サーバーが動いていなければ起動し、プロセスがいなくなったときだけ起動し直す（応答が遅いだけのサーバーは止めない）。 |
| `packages/extension` | 実際にクリック・入力・DOM読み取りを行い、承認の要求をツールバーのポップアップに出すFirefox WebExtension（Manifest V2）。esbuildで3つのバンドル（`dist/background.js`、`dist/content.js`、`dist/popup/popup.js`）にビルドする。 |

コマンドフロー: Claude Code → stdio中継 → HTTP → 共有サーバー → 安全ガード → WebSocket → Native Host → Native Messaging → 拡張機能バックグラウンドスクリプト → コンテンツスクリプト → ページDOM、結果は同じ経路を逆にたどって返ってくる。

`claude mcp add`のコマンドは変わらない。中継が最初の利用時に共有サーバーを起動し（Firefoxが先ならNative Hostが起動する）、共有サーバーは10分使われなければ自分で終了する（`FOX_DAEMON_IDLE_TIMEOUT`）。セッションごとに中継が1つずつ立ち、全員が1つの共有サーバーを使うので、Claude Codeを複数セッション同時に使ってもポートがぶつからない。安全ガードの状態（レート制限、監査ログ、タブごとの最後に見たURL）もセッション間で共有される。

中継とNative Hostはdaemonを、daemonは中継とNative Hostを、`~/.kitsune-mcp/api_token`のAPIトークンを使ったHMACのチャレンジ応答で確かめ合う（トークン自体は送らない）。ポートを横取りしたプログラムはdaemonになりすませない。`GET /health`は認証不要で、nonceを付けると`proof`を加え、中継とNative Hostが確認する`protocol`の版を返す。HTTP APIは`X-API-Key: <token>`ヘッダーも受け付けるが、手作業のデバッグ用（その応答には署名が付かない）。`FOX_HOST`がループバック以外のアドレスだと、daemonは警告をログに出す（ポートが他のマシンから届くようになる）。

## 設定

### 環境変数

下表はコードが読む名前。注記のあるものは、フォーク元から引き継いだ古い`CLAUDE_BROWSER_*`の名前も、`FOX_*`版が未設定の場合のフォールバックとして使える。

| 変数 | 既定値 | 読むプロセス | 説明 |
|---|---|---|---|
| `FOX_HOST` | `127.0.0.1` | daemon、中継、Native Host | HTTP/WSサーバーのアドレス。ループバック以外なら警告を出す。旧名: `CLAUDE_BROWSER_HOST` |
| `FOX_HTTP_PORT` | `8765` | daemon、中継、Native Host、アンインストーラ | HTTPのポート（daemonの多重起動防止も兼ねる）。旧名: `CLAUDE_BROWSER_HTTP_PORT` |
| `FOX_WS_PORT` | `8766` | daemon、Native Host | Native Hostが接続するWebSocketのポート。旧名: `CLAUDE_BROWSER_WS_PORT` |
| `FOX_CAPS` | 未設定（全ツール） | 中継 | ツールプロファイル、カンマ区切り（[下記](#fox_capsのプロファイル)）。`legacy`を指定すると、代わりに以前のツール名を一覧にする（[ツール名の移行](#ツール名の移行)を参照）。**安全の境界ではない** — このセッションが登録するツールスキーマを絞ってコンテキストトークンを節約するだけの設定。daemonはどの呼び出し元からのどのツールも受け付ける。読み取り専用、スクリプト禁止、URL制限、コンテナスコープといった実際の制限は`safety.json` / 安全ガードが担う |
| `FOX_HEADLESS` | 未設定 | daemon | `1` / `true` / `yes`でヘッドレスPlaywrightバックエンドを使う。それ以外は無効（`on`など認識できない値は警告をログに出す）。旧名: `CLAUDE_BROWSER_HEADLESS` |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45000` | daemon | ヘッドレスFirefoxの起動タイムアウト（**ミリ秒**。秒ではない）。旧名: `CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT` |
| `FOX_EXECUTABLE` | PlaywrightのFirefox | daemon（ヘッドレスのみ） | Playwrightが起動するFirefoxバイナリのパス。旧名: `CLAUDE_BROWSER_EXECUTABLE` |
| `FOX_SCREENSHOTS_DIR` | `~/.kitsune-mcp/screenshots` | Native Host（拡張機能経路）、daemon（ヘッドレス経路、`GET /screenshots`） | スクリーンショットの保存先。旧名: `CLAUDE_BROWSER_SCREENSHOTS_DIR` |
| `FOX_SCREENSHOT_RETENTION_DAYS` | `30` | Native Host | Native Hostが起動するたびに、自動で付けた名前で保存したスクリーンショットのうち、この日数より古いものを削除する（`0`ですべて残す）。`filename`を指定して保存したものと、ヘッドレスのスクリーンショットは削除しない |
| `FOX_READ_ONLY` | 未設定 | daemon | `1` / `true` / `yes`で読み取り専用モードを強制する。旧名: `CLAUDE_BROWSER_READ_ONLY` |
| `FOX_ALLOW_SCRIPTS` | 未設定 | daemon | `0` / `false` / `no` / `off`でスクリプト系ツール（`fox_evaluate`、`fox_observer`。以前の名前は`fox_execute_script`、`fox_eval_chain`、`fox_wait_and_act`、`fox_inject_observer`、`fox_remove_observer`）を無効化する。旧名: `CLAUDE_BROWSER_ALLOW_SCRIPTS` |
| `FOX_SAFETY_CONFIG` | `~/.kitsune-mcp/safety.json` | daemon | 安全ポリシーファイルの代替パス。旧名: `CLAUDE_BROWSER_SAFETY_CONFIG` |
| `FOX_APPROVAL_ELICITATION` | 有効 | 中継、daemon | `0` / `false` / `off` / `no`でMCP elicitationによる承認を無効にする。保護対象サイトでの操作は常にFirefoxのポップアップで承認することになる |
| `FOX_DAEMON_IDLE_TIMEOUT` | `600` | daemon | 中継・Native Host・実行中の呼び出しがどれもない状態が何秒続いたらdaemonが終了するか（`0`で終了しない） |
| `FOX_NATIVE_HOST_LOG` | `~/.kitsune-mcp/logs/native-host.log` | Native Host | ログファイルのパス。`0` / `off` / `false` / `no` / `none`でファイルへのログを無効化する |

`FOX_PORT`、`FOX_DEBUG`、`FOX_CONTAINER`は`packages/shared`に定義があるが、どこからも読まれない。

### `FOX_CAPS`のプロファイル

| プロファイル | ツール |
|---|---|
| `core` | `fox_navigate`、`fox_click`、`fox_type`、`fox_press_key`、`fox_set_value`、`fox_screenshot`、`fox_snapshot`、`fox_read`、`fox_find`、`fox_tabs`、`fox_tab`、`fox_interact`、`fox_wait`、`fox_handle_dialog` |
| `logs` | `fox_logging`、`fox_get_logs` |
| `script` | `fox_evaluate`、`fox_observer` |
| `workflow` | `fox_evaluate`（その`wait_and_act`モード。以前の`fox_run_workflow`と`fox_audit_page`は実装されないまま廃止した） |
| `human` | `fox_request_approval`、`fox_detect_captcha` |
| `container` | `fox_tabs`、`fox_tab`（コンテナは`what: "containers"`の`fox_tabs`と、`action: "create"`と`container`を指定した`fox_tab`） |
| `wait` | `fox_wait` |
| `all` | 全ツール（`FOX_CAPS`未設定と同じ） |

`fox_safety_status`は常に登録され、すべてのツールが少なくとも1つのプロファイルに入っている。知らないプロファイル名はstderrに警告を出して無視する。`legacy`（単独、または他のプロファイルと一緒に: `legacy,core`）は、代わりに以前のツール名とその以前のプロファイルを登録する。[ツール名の移行](#ツール名の移行)を参照。

### ツール名の移行

以前の41個のツールを21個にまとめた。関連する操作を、モード引数を持つ1つのツールにした。ブラウザ側は変わっておらず、新しいツールの呼び出しは、以前のツールが実行していたものとまったく同じことを実行する。

- 新しいセッションは新しい名前を一覧にする。`FOX_CAPS=legacy`のセッションは代わりに以前の名前を一覧にする（説明は`[Deprecated: …]`で始まる）。
- daemonは両方を受け付ける。以前の名前は、`FOX_CAPS`の設定に関係なく、HTTP（`POST /mcp/call`）でも引き続き使える。
- daemonの起動中に以前の名前を最初に呼ぶと、結果（と`daemon.log`）に置き換え先を示す注記が付く。監査ログはその呼び出しを新しいツール名で記録し、以前の名前を`legacyTool`に入れる。
- 保護対象サイトの操作に対する人の承認は、呼び出しの名前と引数に結び付く。同じ名前と引数で再試行すること。

| 以前のツール | 新しい呼び出し | 引数の変更 |
|---|---|---|
| `fox_get_page_info` | `fox_read` `mode: "info"` | |
| `fox_get_text` | `fox_read` `mode: "text"` | |
| `fox_get_elements` | `fox_find` `by: "selector"` | |
| `fox_find_text` | `fox_find` `by: "text"` | `query` → `text` |
| `fox_get_tabs` | `fox_tabs` `what: "tabs"` | |
| `fox_list_containers` | `fox_tabs` `what: "containers"` | |
| `fox_create_tab` | `fox_tab` `action: "create"` | |
| `fox_open_in_container` | `fox_tab` `action: "create"`（`container`付き） | `containerName` → `container.name`、`cookieStoreId` → `container.cookieStoreId`。`url`は必須 |
| `fox_close_tab` | `fox_tab` `action: "close"` | |
| `fox_switch_tab` | `fox_tab` `action: "switch"` | |
| `fox_set_value` | `fox_set_value`（`kind: "input"`、既定） | |
| `fox_select_option` | `fox_set_value` `kind: "select"` | `value` / `text` / `index` → `option: { value }` / `{ text }` / `{ index }`（どれか1つだけ） |
| `fox_hover`、`fox_scroll`、`fox_highlight` | `fox_interact` `action: "hover"` / `"scroll"` / `"highlight"` | |
| `fox_wait_for_element`、`fox_wait_for_network_idle`、`fox_wait_for_navigation`、`fox_wait_for_url` | `fox_wait` `for: "element"` / `"network_idle"` / `"navigation"` / `"url"` | `for: "url"`には`url`か`urlPattern`が要る |
| `fox_start_logging`、`fox_stop_logging`、`fox_clear_logs` | `fox_logging` `action: "start"` / `"stop"` / `"clear"` | |
| `fox_get_console_logs`、`fox_get_network_logs` | `fox_get_logs` `kind: "console"` / `"network"` | |
| `fox_execute_script`、`fox_eval_chain`、`fox_wait_and_act` | `fox_evaluate` `mode: "script"` / `"chain"` / `"wait_and_act"` | `wait_and_act`: `timeoutMs` → `timeout` |
| `fox_inject_observer`、`fox_remove_observer` | `fox_observer` `action: "inject"` / `"remove"` | |
| `fox_run_workflow`、`fox_audit_page` | なし | どのバックエンドでも未実装だった。名前での呼び出しは今もでき、同じエラーになる |

変更なし: `fox_screenshot`、`fox_snapshot`、`fox_navigate`、`fox_click`、`fox_type`、`fox_press_key`、`fox_handle_dialog`、`fox_request_approval`、`fox_detect_captcha`、`fox_safety_status`。

### `safety.json`

初回実行時に`~/.kitsune-mcp/safety.json`（または`FOX_SAFETY_CONFIG`）に自動生成される。

| キー | 既定値 | 意味 |
|---|---|---|
| `enabled` | `true` | 安全ガードを有効にする |
| `read_only` | `false` | ページやブラウザの状態を変えるツール（入力、遷移、タブ、スクリプト）を拒否する。観察・待機・ログ・UIだけを変えるツール（`fox_interact`、`action: "switch"`の`fox_tab`）は使える |
| `allow_script_execution` | `true` | スクリプト系ツールを許可する |
| `confirm_protected_actions` | `true` | 保護対象サイトでの操作（スクリーンショット・ログ収集を含む）の前に人に尋ねる |
| `allow_password_typing` | `false` | パスワード欄（`type="password"`、`autocomplete`が`current-password` / `new-password`）への`fox_type` / `fox_set_value`を許可する |
| `max_actions_per_minute` | `120` | レート制限。全セッション共通（`0`で制限なし） |
| `audit_log` | `true` | `~/.kitsune-mcp/logs/audit.jsonl`に書く |
| `blocked_url_patterns` | `[]` | 拒否するURL |
| `allowed_url_patterns` | `[]` | 空でなければ、これに一致するURLだけを許可する |
| `protected_url_patterns` | 銀行、決済処理業者、`.gov`など | 人による承認が必要なサイト |
| `container_scope` | `{ "enabled": false, "container_name": "KitsuneMCP Agent" }` | レイヤー0: エージェントを1つのFirefoxコンテナに制限する |

URLパターンは文字列のままではなく、解析したURLと照合する。`example.com.attacker.net`や、ホスト名を含むクエリ文字列には一致しない。

| パターン | 一致するもの |
|---|---|
| `example.com` | そのホストとすべてのサブドメイン |
| `*.example.com` | サブドメインだけ |
| `example.com/admin` | ……のうち、パスが`/admin`で始まるもの（`example.com/*` = 任意のパス） |
| `https://example.com` | ……のうち、そのスキームのもの |
| `example.com:8443` | ……のうち、そのポートのもの（ポートのないURLはスキームの既定のポート。`example.com:443`は`https://example.com/`に一致する） |
| `[::1]` | IPv6アドレス（角かっこで囲む） |
| `re:<正規表現>` | 正規化したURL（`scheme://host[:port]/path?query#hash`、ユーザー名・パスワードなし）に対する、大文字小文字を区別しない正規表現。URL全体に一致する必要がある（常に`^(?:<正規表現>)$`として扱う）。`re:example\.com`は`https://example.com.attacker.net/`に一致しない。前方一致にするには末尾に`.*`を付ける（`re:https://example\.com/.*`） |

ホストとスキームは大文字小文字を区別しない。`allowed_url_patterns`ではパスは書いたとおりに一致する（区切りの位置で: `/admin`は`/administrator`を含まない）。ブロックと保護対象のリストでは、`%xx`のエスケープを戻し、連続するスラッシュをまとめ、大文字小文字をそろえたうえで、後ろに何が続いても一致する。以前の版の正規表現もできるだけそのまま使える。単純なもの（`paypal\.com`、`\.gov(/|$)`、`^https://a\.example/`）は同じ意味のホストパターンとして読む。それ以外は、ブロックと保護対象のリストでは以前の意味（URLのどこかに一致）のまま警告付きで使い、許可リストではエラーにする。

`safety.json`を使えない場合（読めない、JSONとして不正、型の誤り、使えないURLパターン）、daemonはエラーをstderr（`daemon.log`）に出し、ファイルを直してdaemonを再起動するまで、`fox_safety_status`（エラーを表示する）以外のすべてのツールを拒否する。遷移先も確認する: 許可するのは`http://`・`https://`・`about:blank`だけで、ホストの前にユーザー名やパスワードが付いたURLは拒否し、最終的なURL（リダイレクトやクリックの後）がブロック対象になった結果は返さない。

### 保護対象サイトでの人による承認

ツールが`protected_url_patterns`に一致するURLで操作しようとすると（`confirm_protected_actions`が有効な場合）、その呼び出しは実行されない。daemonが1回限りの承認要求を作り、Claude Codeのセッションがあなたに尋ねる。

1. クライアントが対応していて、`FOX_APPROVAL_ELICITATION`が無効にされていなければ、Claude Code自身の確認ダイアログ（MCP elicitation）で
2. そうでなければFirefoxで。KitsuneMCPのツールバーボタンに黄色の件数が出て（OSの通知も出る）、ポップアップで承認か拒否をする

承認が効くのは、そのツールをその引数のまま、そのホストで1回呼ぶことだけ。要求の期限（120秒。Firefoxのポップアップが待つのは最大60秒）までに答える必要があり、承認は中継だけが見る1回限りのトークンで運ばれる（モデルには見えない）。ページの中のもの — ボタン、`fox_click`、`fox_evaluate` — では承認できない。elicitationでの承認が有効な間は、1つのリスクを受け入れている: 回答はローカルのHTTPでdaemonに届くので、`~/.kitsune-mcp/api_token`を読めるローカルのプロセスは自分の要求を自分で承認できる。Firefoxのポップアップでの承認だけにするには`FOX_APPROVAL_ELICITATION=0`を設定する（ヘッドレスモードでは承認できなくなる）。

`fox_request_approval`はこれとは別の、同じポップアップであなたに尋ねる単純な質問で、その答えで保護対象サイトの操作が許可されることはない。

### 先にdaemonを起動した側の設定が勝つ

daemon はセッションごとに新しく起動されるわけではない。Claude Codeの中継とFirefox（Native Host経由）のどちらか先に起動した方がdaemonを立ち上げ、残りは全員その1つのdaemonと通信する。これは環境変数に影響する — `FOX_READ_ONLY`、`FOX_HEADLESS`、`FOX_ALLOW_SCRIPTS`、`FOX_APPROVAL_ELICITATION`などは、実際にdaemonを起動したプロセスの環境変数だけが読まれる。Native Hostが起動したdaemonはFirefoxの環境変数を引き継ぎ、Claude Codeのセッションのものは使わない。Firefoxが先にdaemonを起動していた場合、後から起動したClaude CodeセッションのMCP設定に`FOX_READ_ONLY=1`と書いてあっても効かない。警告は出る（セッション開始時と`fox_safety_status`の結果）が、既存のdaemonはそのままの設定で動き続ける。

`safety.json`にはこの問題がない。どちらがdaemonを起動しても、既定では同じ固定パス（`~/.kitsune-mcp/safety.json`）から読まれるからだ。`read_only`などを確実に効かせたいなら、環境変数ではなく`safety.json`側に設定すること。

## Status

このプロジェクトは**活発かつ段階的に開発中** — まだ一般利用の準備は整っていない。とはいえ「読んでビルドできるソースコード」の段階は過ぎていて、拡張機能を自分で読み込めば（`about:debugging`の一時的なアドオン）実際のFirefoxをエンドツーエンドで動かせる。足りないのは、それを手作業なしで誰でもインストールできるようにするパッケージングの部分だけ。

**完了済み:**
- 設計 + 多角的レビュー
- モノレポの雛形構築（P1）
- 安全ガード、8層（P2）
- MCPサーバーのコア + 全41ツールのスキーマ/ハンドラ（P3）
- ヘッドレスPlaywrightバックエンド（P4）
- ネイティブメッセージングホスト（P5）
- 拡張機能のTypeScript移植（P6）
- Firefoxネイティブapi: コンテナタブ、`browser.find`、`tabs.captureTab`（P7）
- 拡張機能経路のエンドツーエンド結合、および中継＋共有サーバー構成への移行（Claude Codeを複数セッション同時に使ってもポートを取り合わない）（P7.5）
- Windows 11 + Firefoxでの実機E2E（2026-09-27）
- インストーラー — 最初はPowerShell / bashのスクリプトで、実機Windows 11と、Linux（WSL2のUbuntu 24.04、deb版Firefox 156）で結線を確認済み（2026-09-28）。その後、PowerShellの要らない全プラットフォーム共通のNode.jsのインストーラとアンインストーラ（`scripts/install.mjs` / `scripts/uninstall.mjs`、`npm run setup` / `npm run teardown`）に置き換えた。macOS固有の経路は実機のmacOSではまだ動かしていない。Linuxの確認に使ったスモークテストは`scripts/e2e/`にある
- 診断（`--doctor`）、`--help` / `--version`、全パッケージと拡張機能の版の統一（0.1.4）
- 配布準備: 正式なExtension ID確定（`kitsune-mcp@elys0912.github.io`）、AMOの`data_collection_permissions`設定、`web-ext lint`がエラー・警告0件（P8）
- 承認をページの外へ移動（ツールバーのポップアップ / MCP elicitation、1回限りの承認トークン）、daemon・中継・Native Hostの間のHMACによる相互認証

**未完了:**
- AMOでの署名と、GitHub Releasesでの署名済みパッケージの配布


### ツールの対応状況

| ツール | 拡張機能経路 | ヘッドレス |
|---|---|---|
| `fox_snapshot` | 未実装 | アクセシビリティツリーをYAMLのテキストで返す |
| `fox_evaluate`の`mode: "chain"` / `"wait_and_act"`、`fox_handle_dialog` | 未実装 | 動く |
| `fox_observer` | 動く | 動く（1ページに1つ。`action: "remove"`は変更の件数だけを返す） |
| `fox_logging`、`fox_get_logs` | 動く | 非対応 |
| `fox_navigate`の`action: "hard_refresh"`、`fox_screenshot`の`scope: "all_tabs"` / `"scroll_capture"` | 動く | 非対応 |
| `fox_tabs`の`what: "containers"`、`fox_tab`の`action: "create"`に`container`を付けたもの | 動く | 非対応（コンテナがない） |
| `fox_request_approval` | 動く | 常に拒否（尋ねる相手がいない） |
| その他すべて | 動く | 動くが、無視される引数が多い（結果の`warnings`に並ぶ。[既知の制約](docs/known-issues.ja.md)を参照） |

未実装のツールを呼ぶと、黙って失敗するのではなくエラー（`Not implemented in extension: …` / `Unsupported headless action: …`）が返る。

現行版の制約は[`docs/known-issues.ja.md`](docs/known-issues.ja.md)にまとめている（[English](docs/known-issues.md)）。

## 開発

```bash
npm ci
npm run build             # 全パッケージ。拡張機能はscripts/build-extension.mjsでバンドルする
npm run typecheck         # 拡張機能の型検査（tsc --noEmit）
npm test                  # Vitest（e2eを除く）
npm run lint:ext          # packages/extensionのweb-ext lint
npm run e2e:extension     # 拡張機能がFirefoxに読み込まれるか（PlaywrightのFirefoxが必要）
```

ビルド、パッケージ、確認の詳細: [`docs/development.ja.md`](docs/development.ja.md)（[English](docs/development.md)）。

`npm audit`が報告する11件は、すべて`web-ext`（devDependency）の依存ツリーにあり、容認している。監査は`npm audit --omit=dev`（0件）で行う。配布物（mcp-server、native-host、拡張機能の`.xpi`）にweb-extは含まれない。

`npm test`はVitestのテスト（パッケージごとの単体テスト、`tests/contract/`の契約テスト、`tests/scripts/`のインストーラのテスト）を実行する。テストファイルごとに一時的なホームディレクトリを使うので、テストがあなたの`~/.kitsune-mcp/`に触れることはない。開発にはNode.js 22.12以上（または24）が必要（Vitestの要件）。KitsuneMCPの実行自体はNode.js 18で足りる。

`npm test`に含めていないエンドツーエンドの確認:

| コマンド | 確認すること |
|---|---|
| `npm run test:e2e` | MCP経由で中継 → daemon → ヘッドレスFirefox（`tests/e2e/`。`npx playwright install firefox`が必要）。一時的なホームディレクトリと空きポートを使うので、動いているdaemonには触れない |
| `npm run e2e:extension` | 拡張機能が一時的なアドオンとしてFirefoxに読み込まれる（`scripts/e2e/extension-load.mjs`、PlaywrightのFirefoxで`web-ext`を使う） |
| `node scripts/e2e/tools-smoke.mjs` | 実際のFirefoxでdaemon → Native Host → 拡張機能（インストーラ実行済み、拡張機能読み込み済み。インターネット接続が必要） |
| `node scripts/e2e/nm-probe.mjs` | インストールしたNative Messaging hostが起動してdaemonに届く |

## Credits

[nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser)からのフォーク。元々はPythonで書かれていた。このプロジェクトはそれをTypeScriptに移植し、Firefoxに絞り込み、安全モデルを拡張している（コンテナ分離、1回限りのトークンを使うページの外での承認、プロセス間のHMACによる相互認証）。大変な部分を最初にやってくれた原作者に感謝する。

## License

MIT — [LICENSE](./LICENSE)を参照。
