import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_DEFAULTS } from '@kitsune-mcp/shared';
import {
  headlessStartupTimeoutMs,
  isHeadlessEnabled,
  isTruthyEnv,
  resolveFoxEnv,
  unrecognizedHeadlessValue,
} from '../src/utils/headless-env.js';
import { checkHeadlessContainerScope, headlessContainerScopeWarning } from '../src/safety/container.js';
import { SafetyGuard } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, type SafetyConfig } from '../src/safety/config.js';

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

describe('resolveFoxEnv', () => {
  it('returns the value without surrounding white space, the FOX_ name first (H-16)', () => {
    expect(resolveFoxEnv({ FOX_EXECUTABLE: '  /opt/ff/firefox \n' }, 'FOX_EXECUTABLE', 'CLAUDE_BROWSER_EXECUTABLE'))
      .toBe('/opt/ff/firefox');
    expect(resolveFoxEnv({ FOX_EXECUTABLE: ' ', CLAUDE_BROWSER_EXECUTABLE: ' /legacy ' }, 'FOX_EXECUTABLE', 'CLAUDE_BROWSER_EXECUTABLE'))
      .toBe('/legacy');
    expect(resolveFoxEnv({}, 'FOX_EXECUTABLE', 'CLAUDE_BROWSER_EXECUTABLE')).toBeUndefined();
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

  /** A guard whose policy has container scope on, without touching any file. */
  const scopedGuard = (overrides: Partial<SafetyConfig> = {}): SafetyGuard =>
    new SafetyGuard({
      ...DEFAULT_CONFIG,
      auditLog: false,
      maxActionsPerMinute: 0,
      containerScope: { enabled: true, containerName: 'agent' },
      ...overrides,
    });

  it('refuses observe tools as well: without containers nothing is in scope (fail-closed)', () => {
    vi.stubEnv('FOX_HEADLESS', '1');
    const g = scopedGuard();
    // observe / interact tools (Layer 4 normally lets them through) ...
    for (const tool of ['fox_get_text', 'fox_get_tabs', 'fox_get_page_info', 'fox_screenshot']) {
      expect(g.check(tool, {})?.safetyDecision).toBe('out_of_scope');
    }
    // ... and acting tools alike
    for (const tool of ['fox_navigate', 'fox_click']) {
      expect(g.check(tool, { url: 'https://example.test/' })?.safetyDecision).toBe('out_of_scope');
    }
    // the same calls pass once the backend has containers again
    vi.stubEnv('FOX_HEADLESS', '0');
    expect(g.check('fox_get_text', {})).toBeNull();
    expect(g.check('fox_click', {})).toBeNull();
  });

  it('fox_safety_status still works, so the refusal can be diagnosed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-scope-'));
    try {
      const file = path.join(dir, 'safety.json');
      fs.writeFileSync(file, JSON.stringify({ container_scope: { enabled: true, container_name: 'agent' } }));
      vi.stubEnv('HOME', dir);
      vi.stubEnv('USERPROFILE', dir);
      vi.stubEnv('FOX_SAFETY_CONFIG', file);
      vi.stubEnv('FOX_HEADLESS', '1');
      const { createToolHandler } = await import('../src/tools/handlers.js');

      const status = await createToolHandler('fox_safety_status')({});
      expect(status.isError).toBeFalsy();
      const body = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
      expect(body.success).toBe(true);

      // same process, same policy: an ordinary tool is refused
      const denied = await createToolHandler('fox_get_text')({});
      expect(denied.isError).toBe(true);
      const text = (denied.content as Array<{ text: string }>).map((c) => c.text).join('\n');
      expect(text).toContain('headless backend');
      expect(text).toContain('fox_safety_status still works');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the legacy CLAUDE_BROWSER_HEADLESS is judged the same way', () => {
    vi.stubEnv('CLAUDE_BROWSER_HEADLESS', 'yes');
    expect(checkHeadlessContainerScope(config)?.safetyDecision).toBe('out_of_scope');
    expect(headlessContainerScopeWarning(config)).toContain('headless');
    expect(scopedGuard().check('fox_get_text', {})?.safetyDecision).toBe('out_of_scope');

    vi.stubEnv('CLAUDE_BROWSER_HEADLESS', 'false');
    expect(checkHeadlessContainerScope(config)).toBeNull();

    // the FOX_ name wins, an empty FOX_ value falls through to the old one
    vi.stubEnv('FOX_HEADLESS', '0');
    vi.stubEnv('CLAUDE_BROWSER_HEADLESS', '1');
    expect(checkHeadlessContainerScope(config)).toBeNull();
    vi.stubEnv('FOX_HEADLESS', '');
    expect(checkHeadlessContainerScope(config)?.safetyDecision).toBe('out_of_scope');
  });

  it('records the refusal in the audit log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-scope-audit-'));
    try {
      vi.stubEnv('HOME', dir);
      vi.stubEnv('USERPROFILE', dir);
      vi.stubEnv('FOX_HEADLESS', '1');
      expect(scopedGuard({ auditLog: true }).check('fox_get_text', { selector: '#a' }, 'stdio'))
        .not.toBeNull();

      const logFile = path.join(dir, '.kitsune-mcp', 'logs', 'audit.jsonl');
      const entries = fs.readFileSync(logFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        tool: 'fox_get_text',
        decision: 'out_of_scope',
        transport: 'stdio',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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
