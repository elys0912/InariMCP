import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import {
  headlessStartupTimeoutMs,
  isHeadlessEnabled,
  isTruthyEnv,
  unrecognizedHeadlessValue,
} from '../src/utils/headless-env.js';
import { checkHeadlessContainerScope, headlessContainerScopeWarning } from '../src/safety/container.js';
import type { SafetyConfig } from '../src/safety/config.js';

describe('isTruthyEnv', () => {
  it('accepts 1 / true / yes in any case, nothing else', () => {
    for (const v of ['1', 'true', 'TRUE', 'Yes', ' yes ']) expect(isTruthyEnv(v)).toBe(true);
    for (const v of ['0', 'false', 'no', 'off', '', 'headless', '2', undefined]) {
      expect(isTruthyEnv(v)).toBe(false);
    }
  });
});

describe('isHeadlessEnabled', () => {
  it('reads FOX_HEADLESS and the legacy CLAUDE_BROWSER_HEADLESS', () => {
    expect(isHeadlessEnabled({})).toBe(false);
    expect(isHeadlessEnabled({ FOX_HEADLESS: '1' })).toBe(true);
    expect(isHeadlessEnabled({ CLAUDE_BROWSER_HEADLESS: 'true' })).toBe(true);
  });

  it('FOX_HEADLESS=0 / false is off (it used to count as on)', () => {
    expect(isHeadlessEnabled({ FOX_HEADLESS: '0' })).toBe(false);
    expect(isHeadlessEnabled({ FOX_HEADLESS: 'false' })).toBe(false);
  });

  it('the FOX_ name wins over the legacy one, an empty FOX_ value falls through', () => {
    expect(isHeadlessEnabled({ FOX_HEADLESS: '0', CLAUDE_BROWSER_HEADLESS: '1' })).toBe(false);
    expect(isHeadlessEnabled({ FOX_HEADLESS: '', CLAUDE_BROWSER_HEADLESS: '1' })).toBe(true);
  });
});

describe('unrecognizedHeadlessValue', () => {
  it('reports values that look like "on" but do not enable headless', () => {
    expect(unrecognizedHeadlessValue({ FOX_HEADLESS: 'on' })).toBe('on');
    expect(unrecognizedHeadlessValue({ FOX_HEADLESS: 'y' })).toBe('y');
  });

  it('is silent for enabling, known-off and unset values', () => {
    for (const v of ['1', 'true', 'yes', '0', 'false', 'no', 'off', '']) {
      expect(unrecognizedHeadlessValue({ FOX_HEADLESS: v })).toBeUndefined();
    }
    expect(unrecognizedHeadlessValue({})).toBeUndefined();
  });
});

describe('headlessStartupTimeoutMs', () => {
  it('uses the setting, the legacy name, and falls back to the default', () => {
    expect(headlessStartupTimeoutMs({ FOX_HEADLESS_STARTUP_TIMEOUT: '1234' })).toBe(1234);
    expect(headlessStartupTimeoutMs({ CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT: '99' })).toBe(99);
    const def = ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT;
    expect(headlessStartupTimeoutMs({})).toBe(def);
    expect(headlessStartupTimeoutMs({ FOX_HEADLESS_STARTUP_TIMEOUT: 'abc' })).toBe(def);
    expect(headlessStartupTimeoutMs({ FOX_HEADLESS_STARTUP_TIMEOUT: '-5' })).toBe(def);
  });
});

describe('checkHeadlessContainerScope follows the same flag parsing', () => {
  const config = {
    enabled: true,
    containerScope: { enabled: true, containerName: 'agent' },
  } as unknown as SafetyConfig;

  afterEach(() => { vi.unstubAllEnvs(); });

  // TODO(test): headless で container_scope 有効なら observe 系ツールも拒否される（fail-closed）
  // TODO(test): fox_safety_status は拒否されない
  // TODO(test): 旧名 CLAUDE_BROWSER_HEADLESS でも同じ判定になる
  // TODO(test): 監査ログに out_of_scope が記録される

  it('keeps refusing, and says how to get out (own safety.json via FOX_SAFETY_CONFIG)', () => {
    vi.stubEnv('FOX_HEADLESS', '1');
    const denial = checkHeadlessContainerScope(config);
    expect(denial?.safetyDecision).toBe('out_of_scope');
    expect(denial?.error).toContain('FOX_SAFETY_CONFIG');
  });

  it('headlessContainerScopeWarning is null unless headless and enabled', () => {
    vi.stubEnv('FOX_HEADLESS', '1');
    expect(headlessContainerScopeWarning(config)).toContain('headless');
    expect(headlessContainerScopeWarning({ ...config, containerScope: { enabled: false, containerName: 'agent' } } as SafetyConfig)).toBeNull();
    expect(headlessContainerScopeWarning({ ...config, enabled: false } as SafetyConfig)).toBeNull();
    vi.stubEnv('FOX_HEADLESS', '0');
    expect(headlessContainerScopeWarning(config)).toBeNull();
  });

  it('denies only when headless is really on', () => {
    vi.stubEnv('FOX_HEADLESS', '1');
    expect(checkHeadlessContainerScope(config)?.safetyDecision).toBe('out_of_scope');
    vi.stubEnv('FOX_HEADLESS', '0');
    expect(checkHeadlessContainerScope(config)).toBeNull();
  });
});
