import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserAction, BrowserCommand, BrowserResponse } from '@inari-mcp/shared';
import { attachSafetyMetadata, createToolHandler } from '../src/tools/handlers.js';
import { DEFAULT_CONFIG, type SafetyConfig } from '../src/safety/config.js';
import { SafetyGuard } from '../src/safety/guard.js';
import { getConnectionManager } from '../src/connection/manager.js';

/** The guard handlers.ts works with (there is no setter for the singleton). */
const testGuard = vi.hoisted(() => ({ current: null as SafetyGuard | null }));
vi.mock('../src/safety/guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/safety/guard.js')>();
  return { ...actual, getSafetyGuard: () => testGuard.current ?? actual.getSafetyGuard() };
});

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
      host: 'protected.example.test', port: null, path: null, pathMatch: 'loose',
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
    // WP-G P-1: neither is the url of a fox_navigate that does not go to it.
    const refresh = command('refresh');
    attachSafetyMetadata(refresh, config(lists), 'fox_navigate', { action: 'refresh', url: 'https://x.test/' });
    expect(refresh.blockedUrlRules).toBeDefined();
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
});

describe('handler path: a refusal the Extension made itself (WP5b)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    testGuard.current = null;
  });

  /** Answer the next sendCommand() with `response`, without any browser. */
  function stubBrowser(response: Partial<BrowserResponse>): void {
    vi.spyOn(getConnectionManager(), 'sendCommand').mockImplementation(
      async (command) => ({ requestId: command.requestId, success: false, ...response }) as BrowserResponse,
    );
  }

  const details = (r: CallToolResult): Record<string, unknown> => {
    const block = r.content[1];
    return block && block.type === 'text' ? JSON.parse(block.text) as Record<string, unknown> : {};
  };

  const listCases: Array<[string, Partial<SafetyConfig>, string]> = [
    ['blocked_url', { blockedUrlPatterns: ['blocked.test'] }, 'https://blocked.test/x'],
    ['not_allowlisted', { allowedUrlPatterns: ['example.test'] }, 'https://elsewhere.test/x'],
  ];

  it.each(listCases)('%s is SAFETY_BLOCKED layer 3, and the URL is noted for the tab', async (decision, lists, url) => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, protectedUrlPatterns: [], ...lists });
    testGuard.current = g;
    stubBrowser({ success: false, safetyDecision: decision, error: 'refused by the Extension', data: { url } });

    const result = await createToolHandler('fox_click')({ tabId: 2, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toMatchObject({ code: 'SAFETY_BLOCKED', layer: 3, decision, url });
    // Noted, so the guard's own pre-check refuses the next call without asking the Extension.
    expect(g.urlFor(2)).toBe(url);
    expect(g.check('fox_click', { tabId: 2 })?.safetyDecision).toBe(decision);
  });

  it('out_of_scope is layer 0 and carries no URL', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, protectedUrlPatterns: [] });
    testGuard.current = g;
    stubBrowser({
      success: false, safetyDecision: 'out_of_scope', error: 'tab is outside the container',
      data: { url: 'https://elsewhere.test/' },
    });

    const result = await createToolHandler('fox_click')({ tabId: 3, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toMatchObject({ code: 'SAFETY_BLOCKED', layer: 0, decision: 'out_of_scope' });
    expect(details(result)['url']).toBeUndefined();
    expect(g.urlFor(3)).toBeNull();
  });

  // G-11: config_error (the Extension could not use the attached rules) is
  // audited as such, in no layer.
  it('config_error is SAFETY_BLOCKED without a layer and audited as config_error', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, protectedUrlPatterns: [] });
    testGuard.current = g;
    const audit = vi.spyOn(g, 'recordAudit');
    stubBrowser({ success: false, safetyDecision: 'config_error', error: 'Refused: versions may not match' });

    const result = await createToolHandler('fox_click')({ tabId: 3, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toEqual({ code: 'SAFETY_BLOCKED', decision: 'config_error' });
    expect(audit.mock.calls.map((c) => c[2])).toEqual(['allowed', 'config_error']);
  });

  // G-11: a decision this server does not know is no silent `denied`.
  it('an unknown safetyDecision is refused as denied and reported on stderr', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, protectedUrlPatterns: [] });
    testGuard.current = g;
    const audit = vi.spyOn(g, 'recordAudit');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubBrowser({ success: false, safetyDecision: 'new_layer_9', error: 'refused' });

    const result = await createToolHandler('fox_click')({ tabId: 3, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toEqual({ code: 'SAFETY_BLOCKED', decision: 'denied' });
    expect(audit.mock.calls.map((c) => c[2])).toEqual(['allowed', 'denied']);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('"new_layer_9"');
  });

  // G-21 (a): the Extension refused without reporting the tab's URL, and the
  // guard knows none either: nothing names a host to approve.
  it('confirmation_required without a known URL cannot be approved', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, protectedUrlPatterns: ['bank.test'] });
    testGuard.current = g;
    stubBrowser({ success: false, safetyDecision: 'confirmation_required', error: 'protected', data: {} });

    const result = await createToolHandler('fox_click')({ selector: '#a' });
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first?.type === 'text' ? first.text : '').toContain('This call cannot be approved');
    expect(details(result)).toMatchObject({
      decision: 'confirmation_required',
      layer: 7,
      elicitation: { protectedUrl: '(target tab)' },
    });
    expect(details(result)['approval']).toBeUndefined();
  });
});

describe('attachSafetyMetadata: protectedUrlPatterns', () => {
  it.each([
    ['screenshot', 'fox_screenshot'],
    ['scroll_and_capture', 'fox_screenshot'],
    ['screenshot_all_tabs', 'fox_screenshot'],
  ] as const)('is attached to capture action %s (%s)', (action, tool) => {
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

  // WP-G P-1: the guard checks the tab, so the Extension must check it too.
  it.each(['back', 'forward', 'refresh', 'hard_refresh'] as const)(
    'is attached to fox_navigate %s even with a url argument (not a target)',
    (action) => {
      const cmd = command('navigate');
      attachSafetyMetadata(cmd, config(), 'fox_navigate', { action, url: 'https://example.test/' });
      expect(cmd.protectedUrlPatterns).toEqual(WIRE);
    },
  );

  it('treats an empty url argument as no url', () => {
    const cmd = command('navigate');
    attachSafetyMetadata(cmd, config(), 'fox_navigate', { url: '' });
    expect(cmd.protectedUrlPatterns).toEqual(WIRE);
  });

  it('is not attached to an observe tool outside the capture actions', () => {
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
