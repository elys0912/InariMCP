import * as fs from 'node:fs';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BROWSER_ACTIONS, type BrowserCommand, type BrowserResponse } from '@kitsune-mcp/shared';
import { SafetyGuard, targetUrlOf, type DenialDecision } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, getAuditLogPath, type LoadedSafetyConfig } from '../src/safety/config.js';
import { createToolHandler } from '../src/tools/handlers.js';
import { TOOL_SCHEMAS } from '../src/tools/schemas.js';
import { getConnectionManager } from '../src/connection/manager.js';

/**
 * The guard handlers.ts works with: the process-wide one, unless a test puts
 * its own policy in `current` (there is no setter for the singleton).
 */
const testGuard = vi.hoisted(() => ({ current: null as SafetyGuard | null }));
vi.mock('../src/safety/guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/safety/guard.js')>();
  return { ...actual, getSafetyGuard: () => testGuard.current ?? actual.getSafetyGuard() };
});

function guard(overrides: Partial<LoadedSafetyConfig> = {}): SafetyGuard {
  return new SafetyGuard({
    ...DEFAULT_CONFIG,
    auditLog: false,
    maxActionsPerMinute: 0,
    protectedUrlPatterns: [],
    ...overrides,
  });
}

const decision = (g: SafetyGuard, tool: string, args: Record<string, unknown>) =>
  g.check(tool, args)?.safetyDecision ?? null;

describe('Layer 2-3 on the parsed target URL (2.B1)', () => {
  it('an allowlist entry does not admit look-alike hosts or URLs that merely mention it', () => {
    const g = guard({ allowedUrlPatterns: ['example\\.test'] });
    expect(decision(g, 'fox_navigate', { url: 'https://www.example.test/' })).toBeNull();
    expect(decision(g, 'fox_navigate', { url: 'https://example.test.attacker.test/' })).toBe('not_allowlisted');
    expect(decision(g, 'fox_navigate', { url: 'https://attacker.test/?r=example.test' })).toBe('not_allowlisted');
  });

  it('a blocked host is blocked whatever its case or trailing dot', () => {
    const g = guard({ blockedUrlPatterns: ['blocked.test'] });
    expect(decision(g, 'fox_navigate', { url: 'https://BLOCKED.test./x' })).toBe('blocked_url');
    expect(decision(g, 'fox_navigate', { url: 'https://sub.Blocked.Test/' })).toBe('blocked_url');
  });

  it('refuses URLs with userinfo', () => {
    expect(decision(guard(), 'fox_navigate', { url: 'https://a.test@attacker.test/' })).toBe('invalid_url');
    expect(decision(guard(), 'fox_navigate', { url: 'https://u:p@a.test/' })).toBe('invalid_url');
  });

  it('refuses relative or malformed URLs and non-http schemes', () => {
    expect(decision(guard(), 'fox_navigate', { url: 'a.test/x' })).toBe('invalid_url');
    expect(decision(guard(), 'fox_navigate', { url: 'file:///etc/hosts' })).toBe('blocked_scheme');
    expect(decision(guard(), 'fox_navigate', { url: 'javascript:alert(1)' })).toBe('blocked_scheme');
  });

  it('about:blank is not subject to the allowlist', () => {
    const g = guard({ allowedUrlPatterns: ['example.test'] });
    expect(decision(g, 'fox_create_tab', { url: 'about:blank' })).toBeNull();
  });

  it('protected patterns match by host', () => {
    const g = guard({ protectedUrlPatterns: ['bank.test'] });
    expect(decision(g, 'fox_navigate', { url: 'https://online.bank.test/' })).toBe('confirmation_required');
    expect(decision(g, 'fox_navigate', { url: 'https://bank.test.attacker.test/' })).toBeNull();
  });
});

describe('fail-closed configuration (2.B2)', () => {
  it('a config error refuses every tool, even with the guard disabled', () => {
    const g = guard({ enabled: false, configError: 'safety.json: Unexpected token' });
    for (const tool of ['fox_screenshot', 'fox_get_tabs', 'fox_click']) {
      expect(decision(g, tool, {})).toBe('config_error');
    }
    expect(g.check('fox_click', {})?.error).toContain('Unexpected token');
    expect(g.status().configError).toContain('Unexpected token');
  });

  it('an unusable pattern puts the guard in the config-error state', () => {
    const g = guard({ blockedUrlPatterns: ['re:(unclosed'] });
    expect(decision(g, 'fox_screenshot', {})).toBe('config_error');
    expect(g.status().configError).toContain('blocked_url_patterns');
  });

  it('a legacy regex only warns', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const g = guard({ protectedUrlPatterns: ['mychart\\.'] });
      expect(g.status().configError).toBeNull();
      expect(g.status().patternWarnings).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('per-tab URL tracking (2.B4)', () => {
  const PROTECTED = { protectedUrlPatterns: ['bank.test'] };

  it('keeps each tab URL apart', () => {
    const g = guard(PROTECTED);
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 1 }, 'fox_get_text');
    g.noteUrl({ url: 'https://news.test/' }, { tabId: 2 }, 'fox_get_text');
    expect(decision(g, 'fox_click', { tabId: 1 })).toBe('confirmation_required');
    expect(decision(g, 'fox_click', { tabId: 2 })).toBeNull();
    // Nothing is known about the active tab yet: left to the Extension.
    expect(decision(g, 'fox_click', {})).toBeNull();
  });

  it('commands without tabId track the active tab', () => {
    const g = guard(PROTECTED);
    g.noteUrl({ url: 'https://bank.test/' }, {}, 'fox_navigate');
    expect(g.urlFor()).toBe('https://bank.test/');
    expect(decision(g, 'fox_click', {})).toBe('confirmation_required');
    expect(decision(g, 'fox_click', { tabId: 7 })).toBeNull();
  });

  it('a background tab does not become the active one', () => {
    const g = guard();
    g.noteUrl({ url: 'https://a.test/' }, {}, 'fox_navigate');
    g.noteUrl({ url: 'https://b.test/', tab: { id: 9 } }, { active: false }, 'fox_create_tab');
    expect(g.urlFor()).toBe('https://a.test/');
    expect(g.urlFor(9)).toBe('https://b.test/');
  });

  // G-5: the new tab's URL is not recorded for the tab the tabId argument names.
  it('fox_navigate newTab with a tabId records the new tab, not the named one', () => {
    const g = guard();
    g.noteUrl({ url: 'https://a.test/' }, { tabId: 1 }, 'fox_get_text');
    g.noteUrl({ url: 'https://b.test/', tabId: 5 }, { tabId: 1, newTab: true }, 'fox_navigate');
    expect(g.urlFor(1)).toBe('https://a.test/');
    expect(g.urlFor(5)).toBe('https://b.test/');
    // Without a reported id the new tab stays unknown; tab 1 keeps its URL.
    g.noteUrl({ url: 'https://c.test/' }, { tabId: 1, newTab: true }, 'fox_navigate');
    expect(g.urlFor(1)).toBe('https://a.test/');
  });

  it('switch_tab makes the tab active; close_tab forgets it', () => {
    const g = guard();
    g.noteUrl({ url: 'https://c.test/' }, { tabId: 3 }, 'fox_switch_tab');
    expect(g.urlFor()).toBe('https://c.test/');
    g.noteUrl({}, { tabId: 3 }, 'fox_close_tab');
    expect(g.urlFor(3)).toBeNull();
    expect(g.urlFor()).toBeNull();
  });

  it('close_tab forgets the tab the backend reports closed (`closed`)', () => {
    const g = guard();
    g.noteUrl({ url: 'https://d.test/' }, { tabId: 4 }, 'fox_get_text');
    g.noteUrl({ success: true, closed: 4 }, { tabId: 4 }, 'fox_close_tab');
    expect(g.urlFor(4)).toBeNull();
  });

  it('`closed` wins over the tabId argument, and headless reports closedTabId', () => {
    const g = guard();
    g.noteUrl({ url: 'https://d.test/' }, { tabId: 4 }, 'fox_get_text');
    g.noteUrl({ url: 'https://e.test/' }, { tabId: 5 }, 'fox_get_text');
    // The backend closed another tab than the argument named: that one is forgotten.
    g.noteUrl({ success: true, closed: 5 }, { tabId: 4 }, 'fox_close_tab');
    expect(g.urlFor(5)).toBeNull();
    expect(g.urlFor(4)).toBe('https://d.test/');

    const h = guard();
    h.noteUrl({ url: 'https://f.test/' }, { tabId: 6 }, 'fox_get_text');
    h.noteUrl({ success: true, closedTabId: 6 }, {}, 'fox_close_tab');
    expect(h.urlFor(6)).toBeNull();
  });

  it('closing the active tab clears the active URL, closing another leaves it', () => {
    const g = guard();
    g.noteUrl({ url: 'https://active.test/' }, { tabId: 1 }, 'fox_switch_tab');
    g.noteUrl({ url: 'https://other.test/' }, { tabId: 2 }, 'fox_get_text');
    g.noteUrl({ success: true, closed: 2 }, { tabId: 2 }, 'fox_close_tab');
    expect(g.urlFor()).toBe('https://active.test/');
    g.noteUrl({ success: true, closedTabId: 1 }, {}, 'fox_close_tab');
    expect(g.urlFor()).toBeNull();
  });

  it('a get_tabs list refreshes every tab, and the active one when unambiguous', () => {
    const g = guard();
    g.noteUrl({
      tabs: [
        { id: 1, url: 'https://a.test/', active: false },
        { id: 2, url: 'https://b.test/', active: true },
      ],
    }, {}, 'fox_get_tabs');
    expect(g.urlFor(1)).toBe('https://a.test/');
    expect(g.urlFor()).toBe('https://b.test/');
  });

  // WP-G S-3: headless results carry no tab id.
  it('a result without a tab id keeps the known active tab id', () => {
    const g = guard(PROTECTED);
    g.noteUrl({ tabs: [{ id: 2, url: 'https://a.test/', active: true }] }, {}, 'fox_get_tabs');
    g.noteUrl({ url: 'https://b.test/' }, { url: 'https://b.test/' }, 'fox_navigate');
    expect(g.urlFor(2)).toBe('https://b.test/');
    // The active tab named by its id: still the tab later calls without tabId act on.
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 2, url: 'https://bank.test/' }, 'fox_navigate');
    expect(decision(g, 'fox_click', {})).toBe('confirmation_required');
  });

  it('a new tab without a reported id becomes active under no known id', () => {
    const g = guard();
    g.noteUrl({ tabs: [{ id: 2, url: 'https://a.test/', active: true }] }, {}, 'fox_get_tabs');
    g.noteUrl({ url: 'https://new.test/' }, { url: 'https://new.test/' }, 'fox_create_tab');
    expect(g.urlFor()).toBe('https://new.test/');
    expect(g.urlFor(2)).toBe('https://a.test/');
    g.noteUrl({ url: 'https://c.test/' }, { tabId: 2 }, 'fox_get_text');
    expect(g.urlFor()).toBe('https://new.test/');
  });

  // WP-G O-1: what a backend that reports the tab id at the top level gets.
  it('a top-level tabId in a result names the active tab', () => {
    const g = guard(PROTECTED);
    g.noteUrl({ url: 'https://a.test/', tabId: 1 }, { url: 'https://a.test/' }, 'fox_navigate');
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 1, url: 'https://bank.test/' }, 'fox_navigate');
    expect(decision(g, 'fox_click', {})).toBe('confirmation_required');
  });
});

describe('the reached URL and the tab URL against blocked/allowed lists (2.B3)', () => {
  it('withholds a result that ended on a blocked site', () => {
    const g = guard({ blockedUrlPatterns: ['blocked.test'] });
    const denial = g.checkReachedUrl('fox_click', {}, { url: 'https://www.blocked.test/landing' });
    expect(denial).toMatchObject({ safetyDecision: 'blocked_after_navigation', url: 'https://www.blocked.test/landing' });
    expect(g.checkReachedUrl('fox_click', {}, { url: 'https://fine.test/' })).toBeNull();
  });

  it('withholds a result outside the allowlist, using data.tab.url when there is no url', () => {
    const g = guard({ allowedUrlPatterns: ['example.test'] });
    expect(g.checkReachedUrl('fox_navigate', {}, { tab: { id: 1, url: 'https://elsewhere.test/' } })
      ?.safetyDecision).toBe('blocked_after_navigation');
    expect(g.checkReachedUrl('fox_navigate', {}, { url: 'about:blank' })).toBeNull();
  });

  it('refuses later commands on a tab known to be on a blocked site, but not leaving it', () => {
    const g = guard({ blockedUrlPatterns: ['blocked.test'] });
    g.noteUrl({ url: 'https://blocked.test/' }, { tabId: 4 }, 'fox_click');
    expect(decision(g, 'fox_get_text', { tabId: 4 })).toBe('blocked_url');
    expect(decision(g, 'fox_click', { tabId: 4 })).toBe('blocked_url');
    expect(decision(g, 'fox_navigate', { tabId: 4, url: 'https://fine.test/' })).toBeNull();
    expect(decision(g, 'fox_close_tab', { tabId: 4 })).toBeNull();
    expect(decision(g, 'fox_get_tabs', {})).toBeNull();
  });

  it('WP38 the pre-check refusals name the URL in url (details.url), like blocked_after_navigation', () => {
    const g = guard({ blockedUrlPatterns: ['blocked.test'], allowedUrlPatterns: ['fine.test', 'blocked.test'] });
    expect(g.check('fox_navigate', { url: 'https://blocked.test/x' }))
      .toMatchObject({ safetyDecision: 'blocked_url', url: 'https://blocked.test/x' });
    expect(g.check('fox_navigate', { url: 'https://other.test/' }))
      .toMatchObject({ safetyDecision: 'not_allowlisted', url: 'https://other.test/' });
    g.noteUrl({ url: 'https://blocked.test/tab' }, { tabId: 4 }, 'fox_click');
    expect(g.check('fox_click', { tabId: 4 }))
      .toMatchObject({ safetyDecision: 'blocked_url', url: 'https://blocked.test/tab' });
  });

  it('does nothing when the guard is disabled', () => {
    const g = guard({ enabled: false, blockedUrlPatterns: ['blocked.test'] });
    expect(g.checkReachedUrl('fox_click', {}, { url: 'https://blocked.test/' })).toBeNull();
  });
});

describe('confirmationFromBrowser', () => {
  it('names the safety.json pattern rather than the regex sent to the Extension', () => {
    const g = guard({ protectedUrlPatterns: ['bank.test'] });
    const c = g.confirmationFromBrowser('fox_click', { tabId: 5 }, 'https://bank.test/', undefined, '^https?...');
    expect(c.elicitation?.matchedPattern).toBe('bank.test');
    expect(g.urlFor(5)).toBe('https://bank.test/');
  });

  // WP-G P-2: the refused call closed nothing.
  it('a refused fox_close_tab leaves the tab and the active tab known', () => {
    const g = guard({ protectedUrlPatterns: ['bank.test'] });
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 2 }, 'fox_switch_tab');
    g.confirmationFromBrowser('fox_close_tab', { tabId: 2 }, 'https://bank.test/a', undefined, null);
    expect(g.urlFor(2)).toBe('https://bank.test/a');
    expect(g.urlFor()).toBe('https://bank.test/a');
  });
});

describe('review follow-ups', () => {
  it("fox_wait_for_url's url is not a navigation target: the tab URL is checked", () => {
    const g = guard({ blockedUrlPatterns: ['blocked.test'] });
    g.noteUrl({ url: 'https://blocked.test/' }, { tabId: 1 }, 'fox_click');
    expect(decision(g, 'fox_wait_for_url', { tabId: 1, url: 'https://fine.test/' })).toBe('blocked_url');
  });

  // WP-G P-1: only goto goes to its url (the call schema refuses the rest;
  // the guard does not rely on that).
  it("the url of fox_navigate back / forward / refresh is not a target: the tab URL is checked", () => {
    const g = guard({ protectedUrlPatterns: ['bank.test'], blockedUrlPatterns: ['blocked.test'] });
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 1 }, 'fox_click');
    g.noteUrl({ url: 'https://blocked.test/' }, { tabId: 2 }, 'fox_click');
    expect(decision(g, 'fox_navigate', { tabId: 1, action: 'refresh', url: 'https://fine.test/' }))
      .toBe('confirmation_required');
    expect(decision(g, 'fox_navigate', { tabId: 2, action: 'back', url: 'https://fine.test/' })).toBe('blocked_url');
  });

  it('targetUrlOf: the url a call goes to or opens', () => {
    const url = 'https://a.test/';
    expect(targetUrlOf('fox_navigate', { url })).toBe(url);
    expect(targetUrlOf('fox_navigate', { action: 'goto', url })).toBe(url);
    expect(targetUrlOf('fox_navigate', { action: 'forward', url })).toBeNull();
    expect(targetUrlOf('fox_create_tab', { url })).toBe(url);
    expect(targetUrlOf('fox_wait_for_url', { url })).toBeNull();
    expect(targetUrlOf('fox_navigate', { url: '' })).toBeNull();
  });

  // WP-G: a denial carries only the decisions that refuse.
  it('DenialDecision is the refusing part of AuditDecision', () => {
    expectTypeOf<DenialDecision>().toEqualTypeOf<
      'rate_limited' | 'blocked_scheme' | 'blocked_url' | 'not_allowlisted' | 'read_only' |
      'scripts_disabled' | 'confirmation_required' | 'out_of_scope' | 'invalid_url' |
      'blocked_after_navigation' | 'config_error'
    >();
  });

  it('the default protected list covers mychart portals on any host label', () => {
    const g = guard({ protectedUrlPatterns: DEFAULT_CONFIG.protectedUrlPatterns });
    expect(decision(g, 'fox_click', { tabId: 1, url: 'https://www.mychart.clinic.test/' }))
      .toBe('confirmation_required');
    expect(decision(g, 'fox_click', { tabId: 1, url: 'https://mychart.clinic.test/' }))
      .toBe('confirmation_required');
    expect(decision(g, 'fox_click', { tabId: 1, url: 'https://notmychart.clinic.test/' })).toBeNull();
  });
});

describe('the handler pipeline keeps the guard up to date (2.B3 / 2.B4)', () => {
  function handlerGuard(overrides: Partial<LoadedSafetyConfig> = {}): SafetyGuard {
    const g = guard(overrides);
    testGuard.current = g;
    return g;
  }

  /** Answer the next sendCommand() with `response`, without any browser. */
  function stubBrowser(response: Partial<BrowserResponse>): void {
    vi.spyOn(getConnectionManager(), 'sendCommand').mockImplementation(
      async (command) => ({ requestId: command.requestId, success: true, ...response }) as BrowserResponse,
    );
  }

  const details = (r: CallToolResult): Record<string, unknown> => {
    const block = r.content[1];
    return block && block.type === 'text' ? JSON.parse(block.text) as Record<string, unknown> : {};
  };

  afterEach(() => {
    vi.restoreAllMocks();
    testGuard.current = null;
  });

  it('forgets a closed tab even though fox_close_tab answers without data', async () => {
    const g = handlerGuard();
    g.noteUrl({ url: 'https://d.test/' }, { tabId: 4 }, 'fox_get_text');
    stubBrowser({ success: true }); // no `data` at all
    const result = await createToolHandler('fox_close_tab')({ tabId: 4 });
    expect(result.isError).toBeUndefined();
    expect(g.urlFor(4)).toBeNull();
  });

  it('records the URL a successful command reports', async () => {
    const g = handlerGuard();
    stubBrowser({ success: true, data: { url: 'https://landing.test/x' } });
    await createToolHandler('fox_click')({ tabId: 2, selector: '#a' });
    expect(g.urlFor(2)).toBe('https://landing.test/x');
  });

  it('withholds a result that ended on a blocked site and remembers where the tab is', async () => {
    const g = handlerGuard({ blockedUrlPatterns: ['blocked.test'] });
    stubBrowser({ success: true, data: { url: 'https://www.blocked.test/landing', text: 'secret' } });
    const result = await createToolHandler('fox_click')({ tabId: 3, selector: '#go' });
    expect(result.isError).toBe(true);
    // The reached URL is in details.url, as for the Extension's blocked_url refusals.
    expect(details(result)).toMatchObject({
      code: 'SAFETY_BLOCKED',
      decision: 'blocked_after_navigation',
      url: 'https://www.blocked.test/landing',
    });
    expect(JSON.stringify(result.content)).not.toContain('secret');
    // Noted first, so the pre-check refuses the next call on that tab.
    expect(g.urlFor(3)).toBe('https://www.blocked.test/landing');
    expect(decision(g, 'fox_get_text', { tabId: 3 })).toBe('blocked_url');
  });

  /** The audit log lines `run` adds (the log is under the isolated HOME). */
  async function auditLinesOf(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    const file = getAuditLogPath();
    const read = (): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '');
    const before = read();
    await run();
    return read().slice(before.length).split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  const decisions = (lines: Array<Record<string, unknown>>): unknown[] => lines.map((l) => l['decision']);

  // WP-G T-1: the guard's line is the only one for a call that ran; a
  // failure adds browser_error (not denied), and audit_log off means no line.
  it('audits a call that ran once, and a browser failure as browser_error', async () => {
    handlerGuard({ auditLog: true });
    stubBrowser({ success: true, data: { url: 'https://fine.test/' } });
    const ok = await auditLinesOf(() => createToolHandler('fox_click')({ tabId: 2, selector: '#a' }));
    expect(decisions(ok)).toEqual(['allowed']);

    stubBrowser({ success: false, error: 'Element not found' });
    const failed = await auditLinesOf(() => createToolHandler('fox_click')({ tabId: 2, selector: '#a' }));
    expect(decisions(failed)).toEqual(['allowed', 'browser_error']);
    expect(failed[1]).toMatchObject({ tool: 'fox_click', args: { tabId: 2, selector: '#a' } });
  });

  it('writes no audit line with audit_log off', async () => {
    handlerGuard({ auditLog: false });
    stubBrowser({ success: false, error: 'Element not found' });
    const lines = await auditLinesOf(() => createToolHandler('fox_click')({ selector: '#a' }));
    expect(lines).toEqual([]);
  });

  // WP-G P-3: refused before the guard, so neither counted nor audited as allowed.
  it('a password field is refused as denied, without using up the rate limit', async () => {
    const g = handlerGuard({ auditLog: true, maxActionsPerMinute: 10 });
    const send = vi.spyOn(getConnectionManager(), 'sendCommand');
    const lines = await auditLinesOf(
      () => createToolHandler('fox_type')({ selector: 'input[type=password]', text: 'x' }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(decisions(lines)).toEqual(['denied']);
    expect(g.status().actionsInLastMinute).toBe(0);
  });

  it('an invalid regex argument is refused without an audit line or a counted action', async () => {
    const g = handlerGuard({ auditLog: true, maxActionsPerMinute: 10 });
    const send = vi.spyOn(getConnectionManager(), 'sendCommand');
    let result: CallToolResult | undefined;
    const lines = await auditLinesOf(async () => {
      result = await createToolHandler('fox_get_tabs')({ urlPattern: '(' });
    });
    expect(result?.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
    expect(g.status().actionsInLastMinute).toBe(0);
  });

  // WP-G B-2: the fox_ prefix rule is checked against BROWSER_ACTIONS, so
  // every operation must reach a known browser action.
  it('every operation sends a browser action of BROWSER_ACTIONS', async () => {
    handlerGuard({ enabled: false });
    const sent: BrowserCommand[] = [];
    vi.spyOn(getConnectionManager(), 'sendCommand').mockImplementation(async (command) => {
      sent.push(command);
      return { requestId: command.requestId, success: true } as BrowserResponse;
    });
    // fox_set_value is also the name of a grouped public tool, whose call is parsed.
    const parsedArgs: Record<string, Record<string, unknown>> = { fox_set_value: { selector: '#a', value: 'v' } };
    for (const op of Object.keys(TOOL_SCHEMAS)) {
      await createToolHandler(op)(parsedArgs[op] ?? {});
    }
    const known = new Set<string>(BROWSER_ACTIONS);
    expect(sent.map((c) => c.action).filter((a) => !known.has(a))).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe('rate limit counts only calls that would run (2.B7)', () => {
  it('refused calls and fox_safety_status do not use up the budget', () => {
    const g = guard({ maxActionsPerMinute: 2, readOnly: true });
    for (let i = 0; i < 5; i++) {
      expect(decision(g, 'fox_click', {})).toBe('read_only');
      expect(decision(g, 'fox_safety_status', {})).toBeNull();
    }
    expect(decision(g, 'fox_screenshot', {})).toBeNull();
    expect(decision(g, 'fox_get_text', {})).toBeNull();
    expect(decision(g, 'fox_get_text', {})).toBe('rate_limited');
    expect(g.status().actionsInLastMinute).toBe(2);
  });
});

describe('call label (WP13: the name the caller used)', () => {
  it('names the called tool in messages and audits it with legacyTool for a deprecated name', () => {
    const g = guard({ readOnly: true, auditLog: true });
    const args = { tabId: 7 };
    const denial = g.check('fox_close_tab', args, 'stdio', null, {
      tool: 'fox_old_close', args: { id: 7 }, replacedBy: 'fox_tab',
    });
    expect(denial?.error).toMatch(/^fox_old_close refused/);
    const lines = fs.readFileSync(getAuditLogPath(), 'utf-8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      tool: 'fox_tab', legacyTool: 'fox_old_close', args: { id: 7 }, decision: 'read_only',
    });
  });
});
