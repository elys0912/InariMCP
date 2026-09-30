import { describe, expect, it } from 'vitest';
import {
  daemonSettingsFromInfo,
  diffDaemonSettings,
  effectiveDaemonSettings,
} from '../src/utils/endpoint.js';

// TODO(test): effectiveSettings 有り（新 daemon）なら生 settings を無視して比較する
// TODO(test): effectiveSettings の一部キー欠落・非 string は legacy 正規化にフォールバック
// TODO(test): FOX 優先（FOX=0, 旧名=1 → off）/ FOX 空 → 旧名採用（current 規則）
// TODO(test): READ_ONLY 1/true/yes/TRUE、ALLOW_SCRIPTS 0/false/no/off の同一視
// TODO(test): APPROVAL_ELICITATION: 未設定と空白は既定値、'on' は on
// TODO(test): TIMEOUT: '45000' と未設定（既定）は同じ、不正値は既定扱い
// TODO(test): 未署名の /daemon/info は従来どおり null / []（daemon-client の checkSettings）
// TODO(test): config.ts loadConfig が新しい受理値で readOnly / allowScriptExecution を切り替える

describe('effective daemon settings', () => {
  it('FOX_HEADLESS true / 1 and the old name compare equal', () => {
    const variants = [
      { FOX_HEADLESS: 'true' },
      { CLAUDE_BROWSER_HEADLESS: '1' },
      { FOX_HEADLESS: '', CLAUDE_BROWSER_HEADLESS: 'yes' },
    ];
    for (const env of variants) {
      expect(effectiveDaemonSettings(env).FOX_HEADLESS).toBe('on');
    }
    expect(diffDaemonSettings(effectiveDaemonSettings(variants[1]!), effectiveDaemonSettings(variants[2]!))).toEqual([]);
  });

  it('an old daemon started with the old names only still matches (raw settings hold "" for unset keys)', () => {
    const theirs = daemonSettingsFromInfo({
      settings: { FOX_READ_ONLY: '', CLAUDE_BROWSER_READ_ONLY: '1', FOX_SAFETY_CONFIG: '', CLAUDE_BROWSER_SAFETY_CONFIG: 'strict.json' },
    })!;
    expect(theirs.FOX_READ_ONLY).toBe('on');
    expect(diffDaemonSettings(effectiveDaemonSettings({ CLAUDE_BROWSER_READ_ONLY: '1', CLAUDE_BROWSER_SAFETY_CONFIG: 'strict.json' }), theirs)).toEqual([]);
    // a different config file is still noticed
    expect(diffDaemonSettings(effectiveDaemonSettings({ CLAUDE_BROWSER_READ_ONLY: '1' }), theirs))
      .toEqual(["FOX_SAFETY_CONFIG: this session '(default)', daemon 'strict.json'"]);
  });

  it('an old daemon (raw settings only) is compared by how it read them', () => {
    // it read FOX_READ_ONLY=true as "not 1" = off; this session means it as on
    const theirs = daemonSettingsFromInfo({ settings: { FOX_READ_ONLY: 'true' } });
    const diffs = diffDaemonSettings(effectiveDaemonSettings({ FOX_READ_ONLY: 'true' }), theirs!);
    expect(diffs).toEqual(["FOX_READ_ONLY: this session 'on', daemon 'off'"]);
  });
});
