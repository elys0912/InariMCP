import { describe, expect, it } from 'vitest';
import type { BrowserAction, BrowserCommand } from '@kitsune-mcp/shared';
import { attachSafetyMetadata } from '../src/tools/handlers.js';
import { DEFAULT_CONFIG, type SafetyConfig } from '../src/safety/config.js';

const PATTERNS = ['protected\\.example\\.test'];
// What the Extension receives: the anchored regex equivalent of the pattern.
const WIRE = [
  '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*@)?(?:[^/?#@]+\\.)?protected\\.example\\.test\\.?(?::\\d+)?(?:[/?#]|$)',
];

function config(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    ...DEFAULT_CONFIG,
    protectedUrlPatterns: [...PATTERNS],
    containerScope: { enabled: false, containerName: 'Agent' },
    ...overrides,
  };
}

function command(action: BrowserAction): BrowserCommand {
  return { action, data: {}, requestId: '' };
}

describe('attachSafetyMetadata: containerScope (Layer 0)', () => {
  it('is attached to every command when guard and container scope are enabled', () => {
    const cfg = config({ containerScope: { enabled: true, containerName: 'Agent' } });
    for (const [action, tool] of [
      ['get_tabs', 'fox_get_tabs'],
      ['click', 'fox_click'],
      ['navigate', 'fox_navigate'],
    ] as const) {
      const cmd = command(action);
      attachSafetyMetadata(cmd, cfg, tool, { url: 'https://example.test/' });
      expect(cmd.containerScope).toEqual({ containerName: 'Agent' });
    }
  });

  it('is not attached when container scope is disabled', () => {
    const cmd = command('click');
    attachSafetyMetadata(cmd, config(), 'fox_click', {});
    expect(cmd.containerScope).toBeUndefined();
  });

  it('is not attached when the whole guard is disabled', () => {
    const cmd = command('click');
    attachSafetyMetadata(
      cmd,
      config({ enabled: false, containerScope: { enabled: true, containerName: 'Agent' } }),
      'fox_click',
      {},
    );
    expect(cmd.containerScope).toBeUndefined();
  });
});

describe('attachSafetyMetadata: URL rules (WP5b)', () => {
  const lists = { blockedUrlPatterns: ['blocked.example.test'], allowedUrlPatterns: ['example.test'] };

  it('sends protectedUrlRules next to the legacy protectedUrlPatterns', () => {
    const cmd = command('screenshot');
    attachSafetyMetadata(cmd, config(), 'fox_screenshot', {});
    expect(cmd.protectedUrlPatterns).toEqual(WIRE);
    expect(cmd.protectedUrlRules).toEqual([{
      kind: 'host', source: PATTERNS[0], scheme: null, hosts: 'tree',
      host: 'protected.example.test', path: null, pathMatch: 'loose',
    }]);
  });

  it('sends blocked / allowed rules to tools the guard checks against the tab URL', () => {
    const cmd = command('click');
    attachSafetyMetadata(cmd, config(lists), 'fox_click', { selector: '#a' });
    expect(cmd.blockedUrlRules?.map((r) => r.source)).toEqual(['blocked.example.test']);
    expect(cmd.allowedUrlRules).toEqual([expect.objectContaining({ host: 'example.test', pathMatch: 'strict' })]);
    // fox_wait_for_url's url is not a target: the tab is checked.
    const wait = command('wait_for_url');
    attachSafetyMetadata(wait, config(lists), 'fox_wait_for_url', { url: 'https://x.test/' });
    expect(wait.blockedUrlRules).toBeDefined();
  });

  it.each([
    ['a url target', 'navigate', 'fox_navigate', { url: 'https://x.test/' }, {}],
    ['a tab-independent tool', 'close_tab', 'fox_close_tab', { tabId: 1 }, {}],
    ['the guard disabled', 'click', 'fox_click', {}, { enabled: false }],
  ] as const)('does not send them with %s', (_label, action, tool, args, overrides) => {
    const cmd = command(action);
    attachSafetyMetadata(cmd, config({ ...lists, ...overrides }), tool, { ...args });
    expect(cmd.blockedUrlRules).toBeUndefined();
    expect(cmd.allowedUrlRules).toBeUndefined();
  });
  // TODO(test): handler path: an Extension refusal blocked_url / not_allowlisted
  //   is SAFETY_BLOCKED layer 3 and its data.url is noted for the tab.
});

describe('attachSafetyMetadata: protectedUrlPatterns', () => {
  it.each([
    ['screenshot', 'fox_screenshot'],
    ['scroll_and_capture', 'fox_scroll_and_capture'],
    ['screenshot_all_tabs', 'fox_screenshot'],
    ['start_logging', 'fox_start_logging'],
    ['get_console_logs', 'fox_get_console_logs'],
    ['get_network_logs', 'fox_get_network_logs'],
  ] as const)('is attached to capture / logging action %s (%s)', (action, tool) => {
    const cmd = command(action);
    attachSafetyMetadata(cmd, config(), tool, {});
    expect(cmd.protectedUrlPatterns).toEqual(WIRE);
  });

  it('sends patterns the Extension matches by host, as it compiles them (flag i)', () => {
    const cmd = command('screenshot');
    attachSafetyMetadata(cmd, config(), 'fox_screenshot', {});
    const re = new RegExp(cmd.protectedUrlPatterns![0]!, 'i');
    expect(re.test('https://protected.example.test/')).toBe(true);
    expect(re.test('https://WWW.Protected.Example.Test:8443/a?b')).toBe(true);
    expect(re.test('https://protected.example.test.attacker.test/')).toBe(false);
    expect(re.test('https://attacker.test/?next=protected.example.test')).toBe(false);
    expect(re.test('https://protected.example.test@attacker.test/')).toBe(false);
    expect(re.test('https://notprotected.example.test/')).toBe(false);
  });

  it('is a copy, not the config array itself', () => {
    const cfg = config();
    const cmd = command('screenshot');
    attachSafetyMetadata(cmd, cfg, 'fox_screenshot', {});
    expect(cmd.protectedUrlPatterns).not.toBe(cfg.protectedUrlPatterns);
  });

  it('is attached to an acting tool without a url argument', () => {
    const cmd = command('click');
    attachSafetyMetadata(cmd, config(), 'fox_click', { selector: '#go' });
    expect(cmd.protectedUrlPatterns).toEqual(WIRE);
  });

  it('is not attached to an acting tool with a url argument (the guard checks that url)', () => {
    const cmd = command('navigate');
    attachSafetyMetadata(cmd, config(), 'fox_navigate', { url: 'https://example.test/' });
    expect(cmd.protectedUrlPatterns).toBeUndefined();
  });

  it('treats an empty url argument as no url', () => {
    const cmd = command('navigate');
    attachSafetyMetadata(cmd, config(), 'fox_navigate', { url: '' });
    expect(cmd.protectedUrlPatterns).toEqual(WIRE);
  });

  it('is not attached to an observe tool outside the capture / logging actions', () => {
    const cmd = command('get_page_info');
    attachSafetyMetadata(cmd, config(), 'fox_get_page_info', {});
    expect(cmd.protectedUrlPatterns).toBeUndefined();
  });

  it.each([
    ['guard disabled', { enabled: false }],
    ['confirmProtectedActions false', { confirmProtectedActions: false }],
    ['no patterns', { protectedUrlPatterns: [] }],
  ] satisfies [string, Partial<SafetyConfig>][])('is not attached when %s', (_label, overrides) => {
    const cmd = command('screenshot');
    attachSafetyMetadata(cmd, config(overrides), 'fox_screenshot', {});
    expect(cmd.protectedUrlPatterns).toBeUndefined();
  });
});
