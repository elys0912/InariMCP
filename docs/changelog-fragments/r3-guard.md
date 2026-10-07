# R3 guard / handlers / schemas / tools: CHANGELOG fragment

Entries for the Unreleased sections of docs/CHANGELOG.md (en) and
docs/CHANGELOG.ja.md (ja), same format, no commit hashes.

## en

### Security

- **A broken `safety.json` is reported before any other refusal**: with a configuration error, a call to a password field or with an invalid `urlPattern` used to be refused for that reason first and logged as `denied`; it is now refused as `config_error` like every other call, and logged as such
- **A refusal the Extension reports with an unknown reason is no silent denial**: the daemon logs a line naming the reason (`daemon.log`) and refuses the call as `denied`. A `config_error` from the Extension (safety metadata it could not use) is logged as `config_error` instead of `denied`

### Breaking

- **Failed browser results start with `Browser error: `, and the audit log records them as `browser_error`**: a program that reads tool results or the audit log and looked for the old text or the `denied` line must be updated. See Security (`Browser error: `) and Fixed (one audit line per call)

### Added

- **`GET /mcp/tools` lists the safety classes as a list**: each tool has `classifications` (for example `["act", "interact"]`) next to the `|`-joined `classification`, which is unchanged

### Fixed

- **`fox_navigate` with `newTab` and a `tabId` no longer records the new page for the named tab**: the safety check kept the new tab's URL as the URL of the tab given by `tabId`, so later calls on that tab were checked against the wrong page
- **The details of a safety refusal always name its layer**: `details.layer` is set for every refusal of the safety check (it used to be set only for refusals the Extension made); a configuration error has none
- **A refused approval token says that a new approval is needed**: the message adds that the human is asked again when the call is retried
- **A call by an earlier tool name is audited with the defaults of the new tool**: the arguments in the audit line are those the new tool would have parsed, as for a call by the new name

### Developer

- Tool and operation names are typed (`OperationName`, `PublicToolName`, `ProfileName`); `TAB_INDEPENDENT_TOOLS` is derived from `ToolDefinition.tabIndependent`; `ToolDefinition.inputSchema` is a `z.AnyZodObject`; the Extension's `safetyDecision` values are `BROWSER_SAFETY_DECISIONS` in `@kitsune-mcp/shared`
- `handlers.ts` splits the tool call pipeline into `refuseArguments()`, `buildCommand()`, `browserRefusalToResult()` and `finishResult()`; the `loadConfig` tests moved to `config.test.ts`; new tests for the deprecation note, the screenshot MIME type, the approval that cannot be given, the popup cancel / error answers and `resolveOperation()` errors

## ja

### セキュリティ

- **`safety.json`の設定エラーを他の拒否より先に返す**: 設定エラーの状態でも、パスワード欄や不正な`urlPattern`の呼び出しはその理由で先に拒否され、`denied`と記録されていた。今後は他の呼び出しと同じく`config_error`として拒否し、そのとおり記録する
- **拡張機能が未知の理由で拒否したとき、黙って`denied`にしない**: daemonはその理由を示す行を`daemon.log`に出し、`denied`として拒否する。拡張機能からの`config_error`（使えない安全メタデータ）は`denied`ではなく`config_error`と記録する

### 互換性のない変更

- **ブラウザ側で失敗した結果は`Browser error: `で始まり、監査ログには`browser_error`と記録する**: ツールの結果や監査ログを読むプログラムが以前の本文や`denied`の行を前提にしていたら、更新が必要。セキュリティ（`Browser error: `）と修正（1回の呼び出しに1行）を参照

### 追加

- **`GET /mcp/tools`が安全分類をリストでも返す**: 各ツールに`classifications`（例: `["act", "interact"]`）を足した。`|`でつないだ`classification`はそのまま

### 修正

- **`newTab`と`tabId`を指定した`fox_navigate`で、新しいページを指定したタブのURLとして記録しなくなった**: 安全チェックは新しいタブのURLを`tabId`のタブのURLとして覚えていたため、そのタブへの後続の呼び出しを別のページで判定していた
- **安全チェックの拒否の詳細に必ずレイヤーを入れる**: `details.layer`を安全チェックのすべての拒否に入れる（これまでは拡張機能による拒否だけだった）。設定エラーにはレイヤーがない
- **受け付けなかった承認トークンについて、新しい承認が要ると伝える**: 再試行すると改めて人に確認する、という一文を足した
- **以前のツール名による呼び出しを、新しいツールの既定値込みで監査ログに記録する**: 監査ログの引数は、新しいツール名で呼んだときと同じく新しいツールが解釈した形になる

### 開発者向け

- ツール名と操作名を型にした（`OperationName`、`PublicToolName`、`ProfileName`）。`TAB_INDEPENDENT_TOOLS`は`ToolDefinition.tabIndependent`から導出し、`ToolDefinition.inputSchema`は`z.AnyZodObject`にした。拡張機能の`safetyDecision`の値は`@kitsune-mcp/shared`の`BROWSER_SAFETY_DECISIONS`
- `handlers.ts`のツール呼び出しを`refuseArguments()`、`buildCommand()`、`browserRefusalToResult()`、`finishResult()`に分けた。`loadConfig`のテストを`config.test.ts`に移した。非推奨の注記、スクリーンショットのMIMEタイプ、承認できない確認、ポップアップの取り消し・失敗、`resolveOperation()`のエラーのテストを足した
