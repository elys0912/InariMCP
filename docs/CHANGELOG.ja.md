# 変更履歴

[English](./CHANGELOG.md) | **日本語**

Inari MCP for Firefox の利用者に見える変更。新しいものが上。

Inari MCP for Firefox は 2026-10-14 に [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0（コミット b2642a9）の写しとして始めた。addons.mozilla.org への掲載に向けて整えた版で、アドオンの ID、ネイティブメッセージングのホスト名（`inari_mcp`）、状態ディレクトリ（`~/.inari-mcp`）が KitsuneMCP と異なるため、両方を同じ Firefox に入れられる。分岐前の履歴は KitsuneMCP の変更履歴を参照。

## Unreleased (0.1.0)

### 追加

- 初回の許可の画面：インストールの直後に、Inari MCP for Firefox の接続を許可するかをタブで尋ねる（何をするか、何を送るか、何が必要か、プライバシーポリシー）。許可するまで Native Host に接続しない。それまでバッジに「未許可」が出て、ポップアップから画面を開き直せる。回答を覚えるために `storage` の権限を使う。
- ツールバーのポップアップに一時停止のスイッチ：オンの間は MCP クライアントからの命令をすべて `paused` で始まるエラーで拒否し、待っている承認の要求を取り下げ、バッジに「停止」が出る。
- MCP クライアントの命令を処理している間、バッジに `●` が出る。バッジの状態の優先順を 1 つに決めた：未許可、一時停止、承認待ちの数、処理中、セットアップの状態。

### 変更

- KitsuneMCP から Inari MCP for Firefox に改名。アドオン ID `inari-mcp@elys0912.github.io`、ホストのマニフェスト `inari_mcp`、状態ディレクトリ `~/.inari-mcp`、npm パッケージ `@inari-mcp/*`。
- リポジトリの改行を `.gitattributes` で LF に固定した。どの OS でビルドしても、審査に出す拡張とバイト単位で同じになる。
- `manifest.json`：`incognito` を `not_allowed` にした（プライベートブラウジングのタブは拡張から見えない）。`data_collection_permissions` で `websiteContent` と `browsingActivity` を申告した（ページの内容・スクリーンショット・URL を手元のネイティブホストへ送り、そこから MCP クライアントへ渡る）。
