# R3 extension — changelog fragment

Entries for the Unreleased sections of docs/CHANGELOG.md and docs/CHANGELOG.ja.md (no commit hashes; added when merged).

## English

### Fixed

- **`fox_scroll` result in the Extension**: `amount: 0` scrolls 0 pixels instead of the 300 px default, and `position` is always the measured `{ x, y }` after the scroll — also for `top` (it was always `{ 0, 0 }`), `bottom` (it was the string `"bottom"`) and `toElement` (it had none). A `selector` or `toElement` that matches nothing and a call without `direction` behave as before
- **Waiting for a text change**: `wait_for_change` with `changeType: "text"` now sees changes of a text node; it always ran into its timeout
- **Native Host connection status**: when sending to the Native Host fails, the Extension reports the reason (popup / `status`) and restarts the reconnect backoff after a stable connection, as it does when the host disconnects. A malformed message from the Native Host is dropped instead of being taken as an answer or a command

### Developer

- **Extension code tidied without a change in behaviour**: caught errors are read through one `errorMessage()` helper, non-null assertions and unneeded type assertions are gone (`as` 92 → 48, `!` 12 → 0), the dispatcher and the runtime message listener are split into named steps, the six background functions that only forwarded a command to the content script are rows of the action table, and the action map / approval helpers are no longer published on `globalThis` for the tests. Who may list or decide approvals and drive the dispatcher is now tested on the listeners themselves

## 日本語

### 修正

- **拡張機能の`fox_scroll`の結果**: `amount: 0`は既定の300 pxでなく0ピクセルスクロールする。`position`はスクロール後に実測した`{ x, y }`を常に返す。`top`（以前は常に`{ 0, 0 }`）、`bottom`（以前は文字列`"bottom"`）、`toElement`（以前は返さなかった）も同じ。`selector`や`toElement`に一致する要素がない場合と、`direction`を指定しない場合の動作は変えていない
- **テキストの変更を待つ**: `wait_for_change`の`changeType: "text"`がテキストノードの変更を検出するようになった。以前は必ずタイムアウトしていた
- **Native Hostとの接続状態**: Native Hostへの送信に失敗したとき、ホストが切断したときと同じく、その理由をポップアップ（`status`）に示し、安定していた接続の後なら再接続の間隔を最初からやり直す。Native Hostから不正な形のメッセージが届いたら、応答やコマンドとして扱わずに捨てる

### 開発者向け

- **拡張機能のコードを動作を変えずに整理した**: 捕捉した例外のメッセージは`errorMessage()`で読む。非nullアサーションと不要な型アサーションを外した（`as` 92 → 48、`!` 12 → 0）。ディスパッチャとruntimeメッセージのリスナーを名前の付いた段階に分けた。content scriptへ転送するだけだったbackgroundの6関数はaction tableの行にした。テストのためにaction mapと承認の関数を`globalThis`へ公開するのをやめた。承認の一覧・決定とディスパッチャの呼び出しを誰に許すかは、リスナーそのものを動かして検査する
