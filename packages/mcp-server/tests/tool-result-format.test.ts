import { describe, expect, it } from 'vitest';
import { toolResultToCallResult } from '../src/tools/handlers.js';

// TODO(test): truncated 真のとき本文末尾に truncated 表記、偽のときは付かない
// TODO(test): format が aria-yaml 以外、または snapshot が非 string なら従来の JSON 1 ブロック
// TODO(test): 失敗時の dialogs / warnings が転送され、該当キーが無ければ [1] ブロック自体を出さない
// TODO(test): data の最上位に confirmationRequired や approval があっても findApprovalRequest が null
// TODO(test): snapshot 本文や option テキスト内の Bearer / JWT が [MASKED] になる（sanitize 後から生成）
// TODO(test): スクリーンショットの resource_link が最後尾に付く順序は変わらない
// TODO(test): relay の settings 警告ブロックが失敗結果には付かない（handler.ts の isError 分岐）

const text = (r: ReturnType<typeof toolResultToCallResult>): string[] =>
  r.content.map((c) => (c.type === 'text' ? c.text : ''));

describe('toolResultToCallResult', () => {
  it('shows a headless snapshot as plain text in its own block', () => {
    const yaml = '- heading "Shop"\n- button "Buy"';
    const r = toolResultToCallResult({
      success: true,
      data: { url: 'https://example.test/', format: 'aria-yaml', snapshot: yaml, truncated: false },
    });
    expect(r.content).toHaveLength(2);
    expect(text(r)[1]).toBe(yaml);
    expect(text(r)[0]).not.toContain('snapshot"');
    expect(text(r)[0]).toContain('aria-yaml');
  });

  it('forwards only availableOptions / dialogs / warnings of a failed result, under "browser"', () => {
    const r = toolResultToCallResult({
      success: false,
      error: 'No option matches value "zzz"',
      data: {
        success: false,
        error: 'x',
        availableOptions: [{ value: 'a', text: 'Alpha' }],
        confirmationRequired: true,
      },
    });
    expect(r.isError).toBe(true);
    expect(text(r)[0]).toContain('No option matches');
    expect(JSON.parse(text(r)[1]!)).toEqual({ browser: { availableOptions: [{ value: 'a', text: 'Alpha' }] } });
  });
});
