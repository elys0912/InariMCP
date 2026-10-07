# R3 headless: CHANGELOG fragments

Entries for the Unreleased sections of docs/CHANGELOG.md and docs/CHANGELOG.ja.md (no commit hashes).

## English

### Security

- **Headless `fox_press_key` respects the password guard**: in headless mode a key press is real input, so a character could be typed into a password field one key at a time. On a password field (the element given by `selector`, else the focused one, also inside iframes and shadow roots) every key other than Enter, Tab, Escape, the arrow keys, Home / End, PageUp / PageDown and the modifier keys alone is refused with the same message as `fox_type`, unless `allow_password_typing` is on. The Extension's synthetic key events enter no text and are not affected
- **Headless password check in XHTML documents**: password fields (and the control of a `<label>`, and iframes followed for the focused element) are recognised in `application/xhtml+xml` pages too, where element names are lower case; they used to be missed there

### Breaking

- **Headless `fox_type` with `selector` appends, as on the Extension**: the text is added after the field's current content; pass `clear: true` to replace it (the `clear` warning is now given only without `selector`)
- **Headless `fox_read` `mode: "text"` reports `totalLength` and `title`**: the key `total_length` is gone, as on the Extension
- **Headless `fox_interact` `action: "scroll"` without `direction` moves nothing**: it used to scroll down; like the Extension it now returns `scrolled: true` and the position. A `selector` that matches nothing scrolls the window, and a `toElement` that matches nothing falls through to `direction` (both with a warning) instead of failing

### Fixed

- **Headless backend matches the Extension in more tools**: `fox_set_value` sets a `<select>` (value, then `input` and `change`); `fox_find` `by: "text"` counts the occurrences in the page text, honours `caseSensitive` and `entireWord`, takes quotes and backslashes as plain text and refuses an empty query; `fox_find` `by: "selector"` returns `count` (every match) and honours a `limit` up to 50; `fox_get_value` reads a `<label>` and other non-field elements as their text and a `<select>` as its selected value; `fox_select_option` by text also matches the trimmed option text; `fox_interact` `highlight` keeps the outline for `duration`; `fox_wait` `for: "element"` honours `visible: false`, and `for: "navigation"` honours `waitUntil`; `fox_press_key` also reports `pressed`
- **Headless waits end when the caller gives up**: `fox_wait` (element, network idle, navigation, URL) stops at the caller's deadline and ends at once on cancellation, so the next command no longer waits until the wait's own timeout
- **Headless `fox_wait_and_act` says why it failed**: when the condition is never met, the error names the last error the condition threw, and says when the caller's deadline ended the wait before `timeoutMs`
- **`FOX_*` settings are read without surrounding white space**: e.g. `FOX_EXECUTABLE` with a trailing space or newline is used as the path without it

## 日本語

### セキュリティ

- **ヘッドレスの`fox_press_key`もパスワードガードに従う**: ヘッドレスではキー入力が実際の入力になるため、パスワード欄に1文字ずつ入力できた。パスワード欄（`selector`で指定した要素、なければフォーカス中の要素。iframeとshadow rootの中も含む）では、Enter・Tab・Escape・矢印キー・Home / End・PageUp / PageDown・修飾キー単独以外のキーを、`allow_password_typing`が有効でない限り`fox_type`と同じ文言で拒否する。Extensionの合成キーイベントは文字を入力しないので影響しない
- **XHTML文書でのヘッドレスのパスワード判定**: 要素名が小文字になる`application/xhtml+xml`のページでも、パスワード欄（`<label>`の対象、フォーカス中の要素を探すときのiframeも）を判定する。これまでは見落としていた

### 互換性のない変更

- **ヘッドレスの`fox_type`は`selector`があるとき、Extensionと同じく追記する**: 欄の現在の内容の後ろに加える。置き換えるには`clear: true`を渡す（`clear`の警告は`selector`がないときだけ出す）
- **ヘッドレスの`fox_read`（`mode: "text"`）は`totalLength`と`title`を返す**: キー`total_length`はなくなった（Extensionと同じ）
- **ヘッドレスの`fox_interact`（`action: "scroll"`）は`direction`がなければ動かさない**: これまでは下へスクロールしていた。Extensionと同じく`scrolled: true`と位置を返す。一致しない`selector`はウィンドウを、一致しない`toElement`は`direction`の処理へ進み（どちらも警告付き）、失敗しなくなった

### 修正

- **ヘッドレスのバックエンドを、さらに多くのツールでExtensionに揃えた**: `fox_set_value`は`<select>`の値を設定する（valueの後に`input`と`change`）。`fox_find`（`by: "text"`）はページのテキスト中の出現回数を数え、`caseSensitive`と`entireWord`を反映し、引用符やバックスラッシュをそのままの文字として扱い、空のqueryを拒否する。`fox_find`（`by: "selector"`）は`count`（一致した総数）を返し、50までの`limit`を守る。`fox_get_value`は`<label>`など入力欄以外の要素をそのテキストとして、`<select>`を選択中のvalueとして返す。`fox_select_option`のtext指定は前後の空白を除いた一致も認める。`fox_interact`の`highlight`は`duration`の間だけ枠を表示する。`fox_wait`の`for: "element"`は`visible: false`を、`for: "navigation"`は`waitUntil`を反映する。`fox_press_key`は`pressed`も返す
- **ヘッドレスの待機は呼び出し元が諦めたら終わる**: `fox_wait`（element・network idle・navigation・URL）は呼び出し元の期限で打ち切り、キャンセルされたらすぐに終える。次のコマンドが待機自身のtimeoutまで待たされなくなった
- **ヘッドレスの`fox_wait_and_act`が失敗の理由を示す**: 条件が満たされなかったとき、条件が最後に投げたエラーを添え、`timeoutMs`より前に呼び出し元の期限で打ち切った場合はそう書く
- **`FOX_*`の設定値は前後の空白を除いて読む**: たとえば末尾に空白や改行がある`FOX_EXECUTABLE`は、それを除いたパスとして使う
