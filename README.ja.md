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

- **41個の`fox_*`ツール** — ナビゲーション、クリック/入力/スクロール、スクリーンショット（可視範囲/全ページ/全タブ）、タブ管理、コンソール/ネットワークログ収集、スクリプト実行、待機をカバー。Playwright MCPと併用しても衝突しないよう`browser_`ではなく`fox_`をプレフィックスにしている。まだすべての経路で動くわけではない。[ツールの対応状況](#ツールの対応状況)を参照。
- **ツールプロファイル（`FOX_CAPS`）** — 41個全てのツールを登録すると実際にコンテキストトークンを消費する。プロファイル（`core`、`logs`、`script`など）を選んで必要な分だけ読み込める。[`FOX_CAPS`のプロファイル](#fox_capsのプロファイル)を参照。
- **8層の安全ガード（レイヤー0〜7）** — コンテナスコープ（0）、レート制限（1）、URLスキームの確認とブロック/許可リスト（2〜3）、観察系ツールの通過（4）、読み取り専用モード（5）、スクリプト実行トグル（6）、銀行・決済処理業者・`.gov`などの保護対象ドメインでの人による承認（7）。判定はすべてJSONLの監査ログに残る。ガード自体は常に動作していて、オプトインが必要なのはコンテナスコープ（レイヤー0）だけ。
- **ページの外での承認** — 保護対象サイトでの操作は、Claude Code自身の確認ダイアログ（MCP elicitation）か、FirefoxのKitsuneMCPツールバーのポップアップで人が承認する。ページの中からは承認できない。[保護対象サイトでの人による承認](#保護対象サイトでの人による承認)を参照。
- **コンテナ分離（オプトイン）** — Firefoxの`contextualIdentities`を使い、エージェントを専用コンテナに制限できる。これにより、他のタブで開いている銀行・メールのセッションをエージェントから見えなくできる。これはFirefox専用の機能で、Chromiumには同等のものが存在しない。
- **ヘッドレスモード（上級者向け）** — 拡張機能経由を使いたくない場合のための、Playwrightベースの、Firefox専用ヘッドレスバックエンド。使えないツール・引数が多い（[ツールの対応状況](#ツールの対応状況)を参照）。
- **Firefoxネイティブなapi** — トークンを節約できるページ内テキスト検索用の`browser.find`、全ページ・全タブのスクリーンショット用の`tabs.captureTab`（背景タブの可視範囲を撮るときは、そのタブを一瞬前面に出してから元に戻す）。

## クイックスタート

### 前提条件

- Node.js >= 18.0.0（KitsuneMCPの実行に必要。開発時の要件は[開発](#開発)を参照）
- Firefox 142以降（拡張機能の`strict_min_version`）。Developer EditionとNightlyも通常版と同じNative Messagingの登録を読む
- Windowsではインストーラの実行にPowerShellが必要（使えない場合は[WindowsでPowerShellが使えない場合](#windowsでpowershellが使えない場合)）
- （ヘッドレスモードのみ）PlaywrightのFirefox: `npx playwright install firefox`

### インストール

```bash
git clone https://github.com/elys0912/KitsuneMCP.git
cd KitsuneMCP
npm run install:windows   # macOS / Linux: npm run install:unix
```

`install:unix`はLinuxでは確認済み、実機のmacOSではまだ検証していない（[Status](#status)参照）。LinuxのFirefoxはディストリビューションのパッケージ（deb/rpm）、MozillaのAPTリポジトリ、mozilla.orgのtarballのいずれかを使うこと。Flatpak版はNative Messaging hostを起動できず、Snap版（Ubuntuの既定の`firefox`）も動かない場合がある。[環境ごとの注意](#環境ごとの注意)を参照。

インストーラが行うこと:

1. Node.js（18以上）とnpmを確認し、Firefoxを探す（見つからなくても警告だけ。WindowsではDeveloper EditionとNightlyは検出されないが、問題はない）
2. `npm install`と`npm run build`を実行する
3. Native Messaging hostのラッパー（`run-host.cmd` / `run-host.sh`）を`~/.kitsune-mcp/native-host/`に生成し、hostのマニフェスト`kitsune_mcp.json`をFirefoxに登録する（Windows: マニフェストはラッパーと同じ場所に置き、`HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp`から参照する。Linux: `~/.mozilla/native-messaging-hosts/`に書く。macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/`に書く）
4. Claude CodeへのMCPサーバー登録を尋ねる（`claude mcp add`、[Claude Codeへの追加](#claude-codeへの追加)を参照）

オプション（npm経由では`--`の後に書く。例: `npm run install:unix -- --skip-build`）:

| `install.sh` | `install.ps1` | 効果 |
|---|---|---|
| `--skip-build` | `-SkipBuild` | `npm install` / `npm run build`を省く（`dist/`が必要） |
| `--register-claude` | `-RegisterClaude` | 尋ねずにClaude Codeへ登録する |
| `--no-register-claude` | `-NoRegisterClaude` | 登録せず、コマンドを表示する |
| `--claude-scope user\|local\|project` | `-ClaudeScope user\|local\|project` | `claude mcp add`のスコープ（既定は`user` = 全プロジェクト共通） |
| `--help` | （`Get-Help scripts\install.ps1 -Detailed`） | 使い方を表示する |

直接実行する場合: `bash scripts/install.sh [オプション]`または`powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [オプション]`。

`packages/native-host/`内の`run-host.cmd` / `run-host.sh`は使われない。インストーラが`~/.kitsune-mcp/native-host/`に専用のラッパーを生成する。

**Node.jsを入れ替えた・アップグレードした場合は、インストーラを実行し直すこと** — 生成されるラッパーには、ビルド時のnodeバイナリの絶対パスが埋め込まれている（そのバイナリが無くなった場合は、Firefoxの`PATH`上の`node`で起動する）。

### Firefoxへの拡張機能の読み込み

署名済みでワンクリックインストールできる`.xpi`はまだ配布していない（AMO署名 + GitHub Releasesでの配布は準備中）。今のところは一時的なアドオンとして読み込む。

1. Firefoxで`about:debugging#/runtime/this-firefox`を開く
2. 「一時的なアドオンを読み込む」→ `packages/extension/manifest.json`を選択
3. Firefoxを再起動すると消えるので、その都度読み込み直す必要がある

ツールバーにKitsuneMCPのボタンが出る。ポップアップに接続状態が表示される（[再起動と接続確認](#再起動と接続確認)を参照）。

### Claude Codeへの追加

インストーラがClaude Codeへの登録（`claude mcp add`、既定スコープ`user` = 全プロジェクト共通）を代わりに行ってくれる。`kitsune-mcp`が既に登録されていればそのままにする。この手順をスキップした場合や、インストール時に`claude`が`PATH`に無かった場合は手動で登録する。

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
| 赤い`!`、「Setup needed」（native hostが見つからない） | FirefoxがNative Messaging hostを見つけられない | インストーラを実行してRecheckを押す（Flatpak版Firefoxは[環境ごとの注意](#環境ごとの注意)を参照） |
| 赤い`!`、「Setup needed」（native hostが失敗 / MCPサーバーが応答しない） | hostは登録済みだが起動しない、またはdaemonが応答しない | インストーラを再実行する（よくある原因はNode.jsのアップグレード・移動）。下記のログを見る |
| 赤い`!`、「Update needed」 | クローンが拡張機能より古い | `git pull`してインストーラを再実行し、Firefoxを再起動する |
| 黄色の数字 | あなたの承認を待っている要求がある | ポップアップを開いて承認か拒否をする |

4. Claude Codeに`fox_safety_status`を呼ばせる。有効な安全ポリシー（読み取り専用モード、スクリプトの可否、URLパターン、レート制限、監査ログの場所）が表示され、動いているdaemonがこのセッションと違う設定で起動されていれば警告も出る。ブラウザが接続しているかどうかは表示されない。
5. 低いレベルで確認するときはdaemonに問い合わせる。

```bash
curl -sS http://127.0.0.1:8765/health    # Windows PowerShell: curl.exe -sS … または Invoke-RestMethod …
```

`"status":"ok"`ならdaemonは動いている。拡張機能が接続すると（読み込みから数秒後）`browsers_connected`が`1`になる。何も応答しない（「Connection refused」）ならdaemonはまだ動いていない。daemonは最初のClaude Codeセッションか、拡張機能を読み込んだFirefoxが起動し、10分使われなければ終了する。そのうえでログを見る。

### ログ

すべて`~/.kitsune-mcp/logs/`にある。

| ファイル | 書き込み元 |
|---|---|
| `native-host.log` | Native Host（`FOX_NATIVE_HOST_LOG`で変更でき、`0`/`off`で無効化） |
| `daemon.log` | 共有daemonのstderr |
| `audit.jsonl` | 安全ガードの監査ログ（`safety.json`の`audit_log`） |

各ファイルは5 MBを超えると`<名前>.old`に退避される（1世代だけ残る）。

### ヘッドレスモード

拡張機能をインストールしたくない場合は、`FOX_HEADLESS`を設定してdaemonを起動すると、実際のブラウザと通信する代わりにPlaywrightで管理されたFirefoxインスタンスを直接操作する。

```bash
FOX_HEADLESS=1 node packages/mcp-server/dist/index.js
```

（または`claude mcp add --env FOX_HEADLESS=1 …`）。現行版では空でない値ならすべて有効になり、`0`でも有効になる。この設定が効くのは、このセッションがdaemonを起動した場合だけ（[下記](#先にdaemonを起動した側の設定が勝つ)を参照）。

これにより実際のセッション/cookie/ログイン状態は失われる点に注意 — 使い捨てプロファイルになる、Playwright MCPと同じトレードオフ。使えないツール・引数が多く、ブラウザのポップアップで尋ねる相手もいないので、保護対象サイトでの操作はMCP elicitationでしか承認できない。実際にログイン済みのFirefoxを使いたい場合は拡張機能経由を使うこと。

### 更新

```bash
git pull
npm run install:windows   # または: npm run install:unix
```

その後、`about:debugging`で拡張機能を再読み込みし（またはFirefoxを再起動して読み込み直し）、Claude Codeを再起動する。古い版のdaemonは止めるまで動き続ける。新しい中継やNative Hostが、動いているdaemonについて「speaks protocol …」「is from another version」と報告したら、そのdaemonのプロセスを止める（Native Hostが起動したものならFirefoxも再起動する）。次のツール呼び出しで対応する版のdaemonが起動する。

### アンインストール

1. Firefoxで拡張機能を外す（`about:debugging` → 削除）か、Firefoxを閉じる。そのままだと、動き続けているNative Hostが約20秒でdaemonを起動し直し、APIトークンとログを作り直す。
2. アンインストーラを実行する。

```bash
npm run uninstall:windows   # または: npm run uninstall:unix
```

実行中のdaemonを止め（ポートの相手がKitsuneMCPのdaemonであることを確かめ、確認を取ってから）、Firefoxへの登録と`~/.kitsune-mcp/native-host/`を削除し、Claude Codeの登録を削除するか尋ねる（`claude mcp remove`。見つけられるのはリポジトリのディレクトリから見える登録だけで、別のディレクトリで`local`スコープで登録したものはそこで削除する）。`~/.kitsune-mcp/`の残り（APIトークン、`safety.json`、ログ、スクリーンショット）は一覧を表示するだけで削除しない。

オプション（npm経由では`--`の後）: `--purge`/`-Purge`で`~/.kitsune-mcp/`の残りも削除する。`--stop-daemon`/`-StopDaemon`と`--no-stop-daemon`/`-NoStopDaemon`、`--unregister-claude`/`-UnregisterClaude`と`--no-unregister-claude`/`-NoUnregisterClaude`で質問への答えを先に指定できる。リポジトリ自体は変更しない。

### WindowsでPowerShellが使えない場合

`npm run install:windows` / `uninstall:windows`にはPowerShellが必要。ブロックされている環境では手作業で設定する（`cmd.exe`で実行する。`<REPO>`はクローンの絶対パス、`<NODE>`は`where node`の出力に置き換える）。

1. `<REPO>`で`npm install`と`npm run build`を実行する。
2. `%USERPROFILE%\.kitsune-mcp\native-host\run-host.cmd`を作る。

   ```bat
   @echo off
   cd /d "<REPO>\packages\native-host"
   "<NODE>" "<REPO>\packages\native-host\dist\index.js" %*
   ```

3. `%USERPROFILE%\.kitsune-mcp\native-host\kitsune_mcp.json`を作る（バックスラッシュは2つ重ねる。`packages/native-host/kitsune-mcp.json`も同じテンプレート）。

   ```json
   {
     "name": "kitsune_mcp",
     "description": "KitsuneMCP Native Messaging Host",
     "path": "C:\\Users\\<you>\\.kitsune-mcp\\native-host\\run-host.cmd",
     "type": "stdio",
     "allowed_extensions": ["kitsune-mcp@elys0912.github.io"]
   }
   ```

4. 登録する: `reg add "HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp" /ve /t REG_SZ /d "%USERPROFILE%\.kitsune-mcp\native-host\kitsune_mcp.json" /f`
5. `claude mcp add --scope user kitsune-mcp -- node "<REPO>\packages\mcp-server\dist\index.js"`

手作業でアンインストールするには: 拡張機能を外す（またはFirefoxを閉じる）。`netstat -ano | findstr :8765`でdaemonを探して`taskkill /PID <pid>`で止める。`reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\kitsune_mcp" /f`を実行し、`%USERPROFILE%\.kitsune-mcp\native-host`（または`%USERPROFILE%\.kitsune-mcp`全体）を削除して、`claude mcp remove kitsune-mcp`を実行する。

Native Host自体も、WindowsではdaemonをFirefoxのジョブオブジェクトの外で起動するためにPowerShellを使う（そうしないと、Firefoxを閉じたときにdaemonと、それを使うClaude Codeのセッションが止まる）。PowerShellが使えなければWMI（`cscript`）、次に一回限りのタスク スケジューラのタスク（`schtasks`）を試す。すべて失敗したときだけ、daemonをジョブの中で起動し、`native-host.log`に警告を出す。

### 環境ごとの注意

- **Flatpak版Firefox**はサンドボックスの外のNative Messaging hostを起動できない。ポップアップは「Setup needed」と表示してインストーラの実行を案内するが、再実行しても直らない。Flatpak以外のFirefoxを使う。
- **Snap版Firefox**（Ubuntuの既定の`firefox`）も起動できない場合がある。インストーラが警告する。MozillaのAPTリポジトリからdeb版を入れる。
- **WSL**: Claude CodeとFirefoxは同じ側で動かす。WSLの中のClaude CodeとWindowsのFirefoxを組み合わせると、それぞれが自分の`~/.kitsune-mcp/`（とAPIトークン）でdaemonを起動するので、WSLのセッションはWindowsのFirefoxに届かない。Claude CodeをWindowsで動かすか、FirefoxをWSLの中（WSLg）で`install:unix`を使って動かす。
- **Firefoxのプロファイルを複数**同時に開くと、すべてが1つのdaemonに接続し、コマンドは先に接続した方に送られる。どちらが使われているかはどこにも表示されない。

## アーキテクチャ

4つのTypeScriptパッケージからなるモノレポ。

| パッケージ | 役割 |
|---|---|
| `packages/shared` | 他の3パッケージで使われる共有のzodスキーマ、アクション名、定数。 |
| `packages/mcp-server` | 1つの実行ファイルで2つの役割を持つ。既定では薄いstdio中継で、Claude Codeがセッションごとに1つ起動し、`fox_*`ツールの一覧を返して、呼び出しを共有サーバーに転送する。`--daemon`を付けるとその共有サーバーになる。HTTP/WebSocketのポートを持つ唯一のプロセスで、安全ガードを実行し、Native HostへのWebSocket（優先）かヘッドレスPlaywrightバックエンド（上級者向け）にコマンドをディスパッチする。 |
| `packages/native-host` | 共有サーバーとFirefox拡張機能の間のネイティブメッセージングブリッジ。共有サーバーが動いていなければ起動し、プロセスがいなくなったときだけ起動し直す（応答が遅いだけのサーバーは止めない）。 |
| `packages/extension` | 実際にクリック・入力・DOM読み取りを行い、承認の要求をツールバーのポップアップに出すFirefox WebExtension（Manifest V2）。 |

コマンドフロー: Claude Code → stdio中継 → HTTP → 共有サーバー → 安全ガード → WebSocket → Native Host → Native Messaging → 拡張機能バックグラウンドスクリプト → コンテンツスクリプト → ページDOM、結果は同じ経路を逆にたどって返ってくる。

`claude mcp add`のコマンドは変わらない。中継が最初の利用時に共有サーバーを起動し（Firefoxが先ならNative Hostが起動する）、共有サーバーは10分使われなければ自分で終了する（`FOX_DAEMON_IDLE_TIMEOUT`）。セッションごとに中継が1つずつ立ち、全員が1つの共有サーバーを使うので、Claude Codeを複数セッション同時に使ってもポートがぶつからない。安全ガードの状態（レート制限、監査ログ、現在のURL）もセッション間で共有される。

中継とNative Hostはdaemonを、daemonは中継とNative Hostを、`~/.kitsune-mcp/api_token`のAPIトークンを使ったHMACのチャレンジ応答で確かめ合う（トークン自体は送らない）。ポートを横取りしたプログラムはdaemonになりすませない。`GET /health`は認証不要で、nonceを付けると`proof`を加え、中継とNative Hostが確認する`protocol`の版を返す。HTTP APIは`X-API-Key: <token>`ヘッダーも受け付けるが、手作業のデバッグ用（その応答には署名が付かない）。`FOX_HOST`がループバック以外のアドレスだと、daemonは警告をログに出す（ポートが他のマシンから届くようになる）。

## 設定

### 環境変数

下表はコードが読む名前。注記のあるものは、フォーク元から引き継いだ古い`CLAUDE_BROWSER_*`の名前も、`FOX_*`版が未設定の場合のフォールバックとして使える。

| 変数 | 既定値 | 読むプロセス | 説明 |
|---|---|---|---|
| `FOX_HOST` | `127.0.0.1` | daemon、中継、Native Host | HTTP/WSサーバーのアドレス。ループバック以外なら警告を出す。旧名: `CLAUDE_BROWSER_HOST` |
| `FOX_HTTP_PORT` | `8765` | daemon、中継、Native Host、アンインストーラ | HTTPのポート（daemonの多重起動防止も兼ねる）。旧名: `CLAUDE_BROWSER_HTTP_PORT` |
| `FOX_WS_PORT` | `8766` | daemon、Native Host | Native Hostが接続するWebSocketのポート。旧名: `CLAUDE_BROWSER_WS_PORT` |
| `FOX_CAPS` | 未設定（全ツール） | 中継 | ツールプロファイル、カンマ区切り（[下記](#fox_capsのプロファイル)）。**安全の境界ではない** — このセッションが登録するツールスキーマを絞ってコンテキストトークンを節約するだけの設定。daemonはどの呼び出し元からのどのツールも受け付ける。読み取り専用、スクリプト禁止、URL制限、コンテナスコープといった実際の制限は`safety.json` / 安全ガードが担う |
| `FOX_HEADLESS` | 未設定 | daemon | ヘッドレスPlaywrightバックエンドを使う。現行版では空でない値ならすべて有効（`0`でも有効） |
| `FOX_HEADLESS_STARTUP_TIMEOUT` | `45000` | daemon | ヘッドレスブラウザの起動タイムアウト（**ミリ秒**。秒ではない）のつもりの値。現行版ではログに出るだけで、起動には使われない |
| `FOX_EXECUTABLE` | PlaywrightのFirefox | daemon（ヘッドレスのみ） | Playwrightが起動するFirefoxバイナリのパス。旧名: `CLAUDE_BROWSER_EXECUTABLE` |
| `FOX_SCREENSHOTS_DIR` | `~/.kitsune-mcp/screenshots` | Native Host（拡張機能経路）、daemon（ヘッドレス経路、`GET /screenshots`） | スクリーンショットの保存先。旧名: `CLAUDE_BROWSER_SCREENSHOTS_DIR` |
| `FOX_SCREENSHOT_RETENTION_DAYS` | `30` | Native Host | Native Hostが起動するたびに、自動で付けた名前で保存したスクリーンショットのうち、この日数より古いものを削除する（`0`ですべて残す）。`filename`を指定して保存したものと、ヘッドレスのスクリーンショットは削除しない |
| `FOX_READ_ONLY` | 未設定 | daemon | ちょうど`1`のとき読み取り専用モードを強制する。旧名: `CLAUDE_BROWSER_READ_ONLY` |
| `FOX_ALLOW_SCRIPTS` | 未設定 | daemon | ちょうど`0`のときスクリプト系ツール（`fox_execute_script`、`fox_eval_chain`、`fox_wait_and_act`、`fox_inject_observer`）を無効化する。旧名: `CLAUDE_BROWSER_ALLOW_SCRIPTS` |
| `FOX_SAFETY_CONFIG` | `~/.kitsune-mcp/safety.json` | daemon | 安全ポリシーファイルの代替パス。旧名: `CLAUDE_BROWSER_SAFETY_CONFIG` |
| `FOX_APPROVAL_ELICITATION` | 有効 | 中継、daemon | `0` / `false` / `off` / `no`でMCP elicitationによる承認を無効にする。保護対象サイトでの操作は常にFirefoxのポップアップで承認することになる |
| `FOX_DAEMON_IDLE_TIMEOUT` | `600` | daemon | 中継・Native Host・実行中の呼び出しがどれもない状態が何秒続いたらdaemonが終了するか（`0`で終了しない） |
| `FOX_NATIVE_HOST_LOG` | `~/.kitsune-mcp/logs/native-host.log` | Native Host | ログファイルのパス。`0` / `off` / `false` / `no` / `none`でファイルへのログを無効化する |

`FOX_PORT`、`FOX_DEBUG`、`FOX_CONTAINER`は`packages/shared`に定義があるが、どこからも読まれない。`CLAUDE_BROWSER_HEADLESS`と`CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT`も読まれない。

### `FOX_CAPS`のプロファイル

| プロファイル | ツール |
|---|---|
| `core` | `fox_navigate`、`fox_click`、`fox_type`、`fox_press_key`、`fox_screenshot`、`fox_snapshot`、`fox_get_elements`、`fox_get_text`、`fox_find_text`、`fox_get_tabs`、`fox_create_tab`、`fox_close_tab`、`fox_switch_tab`、`fox_wait_for_element` |
| `logs` | `fox_start_logging`、`fox_stop_logging`、`fox_get_console_logs`、`fox_get_network_logs`、`fox_clear_logs` |
| `script` | `fox_execute_script`、`fox_eval_chain`、`fox_inject_observer`、`fox_remove_observer` |
| `workflow` | `fox_run_workflow`、`fox_audit_page`、`fox_wait_and_act` |
| `human` | `fox_request_approval`、`fox_detect_captcha` |
| `container` | `fox_list_containers`、`fox_open_in_container` |
| `wait` | `fox_wait_for_element`、`fox_wait_for_network_idle`、`fox_wait_for_navigation`、`fox_wait_for_url` |
| `all` | 全ツール（`FOX_CAPS`未設定と同じ） |

`fox_safety_status`は常に登録される。次の7本はどのプロファイルにも属さず、`all`か`FOX_CAPS`未設定のときだけ登録される: `fox_get_page_info`、`fox_set_value`、`fox_select_option`、`fox_hover`、`fox_scroll`、`fox_highlight`、`fox_handle_dialog`。知らないプロファイル名はstderrに警告を出して無視する。

### `safety.json`

初回実行時に`~/.kitsune-mcp/safety.json`（または`FOX_SAFETY_CONFIG`）に自動生成される。

| キー | 既定値 | 意味 |
|---|---|---|
| `enabled` | `true` | 安全ガードを有効にする |
| `read_only` | `false` | 観察系以外のツールをすべて拒否する |
| `allow_script_execution` | `true` | スクリプト系ツールを許可する |
| `confirm_protected_actions` | `true` | 保護対象サイトでの操作（スクリーンショット・ログ収集を含む）の前に人に尋ねる |
| `allow_password_typing` | `false` | パスワード欄への入力を許可する（[既知の制約](docs/known-issues.ja.md)を参照） |
| `max_actions_per_minute` | `120` | レート制限。全セッション共通（`0`で制限なし） |
| `audit_log` | `true` | `~/.kitsune-mcp/logs/audit.jsonl`に書く |
| `blocked_url_patterns` | `[]` | 拒否するURL |
| `allowed_url_patterns` | `[]` | 空でなければ、これに一致するURLだけを許可する |
| `protected_url_patterns` | 銀行、決済処理業者、`.gov`など | 人による承認が必要なサイト |
| `container_scope` | `{ "enabled": false, "container_name": "KitsuneMCP Agent" }` | レイヤー0: エージェントを1つのFirefoxコンテナに制限する |

URLパターンは大文字小文字を区別しない正規表現で、現行版ではURL全体のどこかに一致すれば当たりになる（ホスト名だけとは比べない）。先頭から書くなどして自分でアンカーを付けること。ファイルを読めなかった場合、daemonはエラーをstderrに出して既定値で動く。

### 保護対象サイトでの人による承認

ツールが`protected_url_patterns`に一致するURLで操作しようとすると（`confirm_protected_actions`が有効な場合）、その呼び出しは実行されない。daemonが1回限りの承認要求を作り、Claude Codeのセッションがあなたに尋ねる。

1. クライアントが対応していて、`FOX_APPROVAL_ELICITATION`が無効にされていなければ、Claude Code自身の確認ダイアログ（MCP elicitation）で
2. そうでなければFirefoxで。KitsuneMCPのツールバーボタンに黄色の件数が出て（OSの通知も出る）、ポップアップで承認か拒否をする

承認が効くのは、そのツールをその引数のまま、そのホストで1回呼ぶことだけ。要求の期限（120秒。Firefoxのポップアップが待つのは最大60秒）までに答える必要があり、承認は中継だけが見る1回限りのトークンで運ばれる（モデルには見えない）。ページの中のもの — ボタン、`fox_click`、`fox_execute_script` — では承認できない。elicitationでの承認が有効な間は、1つのリスクを受け入れている: 回答はローカルのHTTPでdaemonに届くので、`~/.kitsune-mcp/api_token`を読めるローカルのプロセスは自分の要求を自分で承認できる。Firefoxのポップアップでの承認だけにするには`FOX_APPROVAL_ELICITATION=0`を設定する（ヘッドレスモードでは承認できなくなる）。

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
- インストーラー（Windows用`scripts/install.ps1` / `scripts/uninstall.ps1`、macOS/Linux用`scripts/install.sh` / `scripts/uninstall.sh`） — 実機Windows 11と、Linux（WSL2のUbuntu 24.04、deb版Firefox 156）で結線を確認済み（2026-09-28）。macOS固有の経路は実機のmacOSではまだ動かしていない。Linuxの確認に使ったスモークテストは`scripts/e2e/`にある
- 配布準備: 正式なExtension ID確定（`kitsune-mcp@elys0912.github.io`）、AMOの`data_collection_permissions`設定、`web-ext lint`がエラー・警告0件（P8）
- 承認をページの外へ移動（ツールバーのポップアップ / MCP elicitation、1回限りの承認トークン）、daemon・中継・Native Hostの間のHMACによる相互認証

**未完了:**
- AMOでの署名と、GitHub Releasesでの署名済みパッケージの配布

バージョン番号はまだそろっていない。拡張機能は0.1.4、npmパッケージ（とdaemonの`/health`）は0.1.0。

### ツールの対応状況

| ツール | 拡張機能経路 | ヘッドレス |
|---|---|---|
| `fox_run_workflow`、`fox_audit_page` | 未実装 | 未実装 |
| `fox_snapshot` | 未実装 | アクセシビリティツリーではなくPNGのスクリーンショット（base64）を返す |
| `fox_eval_chain`、`fox_wait_and_act`、`fox_inject_observer`、`fox_remove_observer`、`fox_handle_dialog` | 未実装 | 動く |
| `fox_start_logging`、`fox_stop_logging`、`fox_get_console_logs`、`fox_get_network_logs`、`fox_clear_logs` | 動く | 非対応 |
| `fox_navigate`の`action: "hard_refresh"`、`fox_screenshot`の`scope: "all_tabs"` / `"scroll_capture"` | 動く | 非対応 |
| `fox_list_containers`、`fox_open_in_container` | 動く | 非対応（コンテナがない） |
| `fox_request_approval` | 動く | 常に拒否（尋ねる相手がいない） |
| その他すべて | 動く | 動くが、無視される引数が多い（[既知の制約](docs/known-issues.ja.md)を参照） |

未実装のツールを呼ぶと、黙って失敗するのではなくエラー（`Not implemented in extension: …` / `Unsupported headless action: …`）が返る。

現行版の制約は[`docs/known-issues.ja.md`](docs/known-issues.ja.md)にまとめている（[English](docs/known-issues.md)）。

## 開発

```bash
npm ci
npm run build
npm test
```

`npm test`はVitestのテスト（パッケージごとの単体テストと`tests/contract/`の契約テスト）を実行する。VitestにはNode.js 22.12以上（または24）が必要。KitsuneMCPの実行自体はNode.js 18で足りる。

## Credits

[nanogenomic/ClaudeCodeBrowser](https://github.com/nanogenomic/ClaudeCodeBrowser)からのフォーク。元々はPythonで書かれていた。このプロジェクトはそれをTypeScriptに移植し、Firefoxに絞り込み、安全モデルを拡張している（コンテナ分離、1回限りのトークンを使うページの外での承認、プロセス間のHMACによる相互認証）。大変な部分を最初にやってくれた原作者に感謝する。

## License

MIT — [LICENSE](./LICENSE)を参照。
