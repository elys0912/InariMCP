import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserAction, BrowserCommand, BrowserResponse } from '@inari-mcp/shared';
import { attachSafetyMetadata, createToolHandler } from '../src/tools/handlers.js';
import { DEFAULT_CONFIG, type SafetyConfig } from '../src/safety/config.js';
import { SafetyGuard } from '../src/safety/guard.js';
import { getConnectionManager } from '../src/connection/manager.js';
import { answerFromElicitation } from '../src/tools/approval-flow.js';

/** The guard handlers.ts works with (there is no setter for the singleton). */
const testGuard = vi.hoisted(() => ({ current: null as SafetyGuard | null }));
vi.mock('../src/safety/guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/safety/guard.js')>();
  return { ...actual, getSafetyGuard: () => testGuard.current ?? actual.getSafetyGuard() };
});

const READ_SITES = ['bank.example.test'];

function config(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    ...DEFAULT_CONFIG,
    confirmReadSites: [...READ_SITES],
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

  it('sends confirm_read_sites as confirmReadUrlRules', () => {
    const cmd = command('screenshot');
    attachSafetyMetadata(cmd, config(), 'fox_screenshot', {});
    expect(cmd.confirmReadUrlRules).toEqual([{
      kind: 'host', source: READ_SITES[0], scheme: null, hosts: 'tree',
      host: 'bank.example.test', port: null, path: null, pathMatch: 'loose',
    }]);
    expect(cmd).not.toHaveProperty('protectedUrlRules');
    expect(cmd).not.toHaveProperty('protectedUrlPatterns');
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
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, ...lists });
    testGuard.current = g;
    stubBrowser({ success: false, safetyDecision: decision, error: 'refused by the Extension', data: { url } });

    const result = await createToolHandler('fox_get_text')({ tabId: 2, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toMatchObject({ code: 'SAFETY_BLOCKED', layer: 3, decision, url });
    // Noted, so the guard's own pre-check refuses the next call without asking the Extension.
    expect(g.urlFor(2)).toBe(url);
    expect(g.check('fox_click', { tabId: 2 })?.safetyDecision).toBe(decision);
  });

  it('out_of_scope is layer 0 and carries no URL', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false });
    testGuard.current = g;
    stubBrowser({
      success: false, safetyDecision: 'out_of_scope', error: 'tab is outside the container',
      data: { url: 'https://elsewhere.test/' },
    });

    const result = await createToolHandler('fox_get_text')({ tabId: 3, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toMatchObject({ code: 'SAFETY_BLOCKED', layer: 0, decision: 'out_of_scope' });
    expect(details(result)['url']).toBeUndefined();
    expect(g.urlFor(3)).toBeNull();
  });

  // G-11: config_error (the Extension could not use the attached rules) is
  // audited as such, in no layer.
  it('config_error is SAFETY_BLOCKED without a layer and audited as config_error', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false });
    testGuard.current = g;
    const audit = vi.spyOn(g, 'recordAudit');
    stubBrowser({ success: false, safetyDecision: 'config_error', error: 'Refused: versions may not match' });

    const result = await createToolHandler('fox_get_text')({ tabId: 3, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toEqual({ code: 'SAFETY_BLOCKED', decision: 'config_error' });
    expect(audit.mock.calls.map((c) => c[2])).toEqual(['allowed', 'config_error']);
  });

  // G-11: a decision this server does not know is no silent `denied`.
  it('an unknown safetyDecision is refused as denied and reported on stderr', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false });
    testGuard.current = g;
    const audit = vi.spyOn(g, 'recordAudit');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubBrowser({ success: false, safetyDecision: 'new_layer_9', error: 'refused' });

    const result = await createToolHandler('fox_get_text')({ tabId: 3, selector: '#a' });
    expect(result.isError).toBe(true);
    expect(details(result)).toEqual({ code: 'SAFETY_BLOCKED', decision: 'denied' });
    expect(audit.mock.calls.map((c) => c[2])).toEqual(['allowed', 'denied']);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('"new_layer_9"');
  });

  // G-21 (a): the Extension refused without reporting the tab's URL, and the
  // guard knows none either: nothing names a site to approve.
  it('confirmation_required without a known URL cannot be approved', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, confirmReadSites: ['bank.test'] });
    testGuard.current = g;
    stubBrowser({ success: false, safetyDecision: 'confirmation_required', error: 'approval required', data: {} });

    const result = await createToolHandler('fox_get_text')({ selector: '#a' });
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first?.type === 'text' ? first.text : '').toContain('This call cannot be approved yet');
    expect(details(result)).toMatchObject({
      decision: 'confirmation_required',
      layer: 4,
      elicitation: { url: null },
    });
    expect(details(result)['approval']).toBeUndefined();
  });

  // Fo-07: the Extension refuses an acting command approved for another site
  // than the one its tab is on (the guard's URL was stale): a new request
  // names the site the browser reports.
  it('an acting command refused by the Extension opens a request for the reported site', async () => {
    const g = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false });
    testGuard.current = g;
    g.noteUrl({ url: 'https://a.example.test/' }, { tabId: 2 }, 'fox_get_text');
    stubBrowser({
      success: false, safetyDecision: 'confirmation_required', error: 'approval required',
      data: { url: 'https://b.example.test/x' },
    });

    const first = await createToolHandler('fox_click')({ tabId: 2, selector: '#a' });
    const requestId = (details(first)['approval'] as { requestId: string }).requestId;
    const { approvalToken } = answerFromElicitation(requestId, true);
    const result = await createToolHandler('fox_click')({ tabId: 2, selector: '#a' }, { approvalToken });
    expect(details(result)).toMatchObject({
      decision: 'confirmation_required',
      layer: 7,
      elicitation: { url: 'https://b.example.test/x', matchedPattern: null, toolName: 'fox_click' },
      approval: { host: 'b.example.test', url: 'https://b.example.test/x', matchedPattern: null },
    });
    expect(g.urlFor(2)).toBe('https://b.example.test/x');
  });
});

describe('attachSafetyMetadata: confirmReadUrlRules', () => {
  it.each([
    ['screenshot', 'fox_screenshot'],
    ['scroll_and_capture', 'fox_screenshot'],
    ['screenshot_all_tabs', 'fox_screenshot'],
    ['get_text', 'fox_get_text'],
    ['get_page_info', 'fox_get_page_info'],
    ['get_elements', 'fox_get_elements'],
    ['find_text', 'fox_find_text'],
    ['snapshot', 'fox_snapshot'],
    ['audit_page', 'fox_audit_page'],
  ] as const)('is attached to the read %s (%s)', (action, tool) => {
    const cmd = command(action);
    attachSafetyMetadata(cmd, config(), tool, {});
    expect(cmd.confirmReadUrlRules?.map((r) => r.source)).toEqual(READ_SITES);
  });

  it.each([
    ['click', 'fox_click', { selector: '#go' }],
    ['navigate', 'fox_navigate', { url: 'https://bank.example.test/' }],
    ['go_back', 'fox_navigate', { action: 'back' }],
    ['create_tab', 'fox_create_tab', {}],
    ['get_tabs', 'fox_get_tabs', {}],
    ['scroll', 'fox_scroll', {}],
    ['wait_for_element', 'fox_wait_for_element', { selector: '#a' }],
  ] as const)('is not attached to %s (%s): acting tools always ask, the rest reads no page', (action, tool, args) => {
    const cmd = command(action);
    attachSafetyMetadata(cmd, config(), tool, { ...args });
    expect(cmd.confirmReadUrlRules).toBeUndefined();
    expect(cmd.approvedHost).toBeUndefined();
  });

  it.each([
    ['guard disabled', { enabled: false }],
    ['no confirm_read_sites', { confirmReadSites: [] }],
  ] satisfies [string, Partial<SafetyConfig>][])('is not attached when %s', (_label, overrides) => {
    const cmd = command('screenshot');
    attachSafetyMetadata(cmd, config(overrides), 'fox_screenshot', {});
    expect(cmd.confirmReadUrlRules).toBeUndefined();
  });
});
