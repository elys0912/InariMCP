# 変更履歴

[English](./CHANGELOG.md) | **日本語**

Inari MCP for Firefox の利用者に見える変更。新しいものが上。

Inari MCP for Firefox は 2026-10-14 に [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0（コミット b2642a9）の写しとして始めた。addons.mozilla.org への掲載に向けて整えた版で、アドオンの ID、ネイティブメッセージングのホスト名（`inari_mcp`）、状態ディレクトリ（`~/.inari-mcp`）が KitsuneMCP と異なるため、両方を同じ Firefox に入れられる。分岐前の履歴は KitsuneMCP の変更履歴を参照。

## Unreleased (0.1.0)

### 変更

- KitsuneMCP から Inari MCP for Firefox に改名。アドオン ID `inari-mcp@elys0912.github.io`、ホストのマニフェスト `inari_mcp`、状態ディレクトリ `~/.inari-mcp`、npm パッケージ `@inari-mcp/*`。
- リポジトリの改行を `.gitattributes` で LF に固定した。どの OS でビルドしても、審査に出す拡張とバイト単位で同じになる。
- `manifest.json`：`incognito` を `not_allowed` にした（プライベートブラウジングのタブは拡張から見えない）。`data_collection_permissions` で `websiteContent` と `browsingActivity` を申告した（ページの内容・スクリーンショット・URL を手元のネイティブホストへ送り、そこから MCP クライアントへ渡る）。
- README：インストールを addons.mozilla.org から始める形にした（1. AMO から拡張機能、2. ネイティブホスト、3. MCP クライアントへの登録）。冒頭に送るものと要るものを書いた。「WIP」「AMO 掲載は予定なし」「GitHub Releases の unlisted の .xpi を入れる」の記述を外した。権限（各権限の用途）・プライバシー・関連リンクの節を足した。
- 拡張機能の説明文とポップアップの末尾を「Inari MCP for Firefox」の名前にし、ページの内容は手元の PC のネイティブホストにだけ送ることを書いた。

### 追加

- プライバシーポリシー：[docs/PRIVACY.ja.md](./PRIVACY.ja.md)（[English](./PRIVACY.md)）。読み取って送るもの、送り先、手元に残るものと期間、消し方、同意と制御、プライベートブラウジング。
- addons.mozilla.org の掲載用の素材（[docs/amo/listing.md](./amo/listing.md)）と、審査者向けのメモ（[docs/amo/reviewer-notes.md](./amo/reviewer-notes.md)）。
