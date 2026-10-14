import * as fs from 'node:fs';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BROWSER_ACTIONS, type BrowserCommand, type BrowserResponse } from '@inari-mcp/shared';
import { APPROVAL_POLICY, SafetyGuard, targetUrlOf, type DenialDecision } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, getAuditLogPath, type LoadedSafetyConfig } from '../src/safety/config.js';
import { createToolHandler } from '../src/tools/handlers.js';
import { answerFromElicitation } from '../src/tools/approval-flow.js';
import { callSchemaFor, resolveOperation } from '../src/tools/operations.js';
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
    ...overrides,
  });
}

const decision = (g: SafetyGuard, tool: string, args: Record<string, unknown>) =>
  g.check(tool, args)?.safetyDecision ?? null;

/** The URL the human would be asked about (undefined: no approval needed). */
const approvalUrl = (g: SafetyGuard, tool: string, args: Record<string, unknown>) =>
  g.check(tool, args)?.elicitation?.url;

// ---------------------------------------------------------------------------
// Decision #9: acting tools always ask; reads ask only on confirm_read_sites
// ---------------------------------------------------------------------------

/** Every operation, by what the guard must do with it (written out, not derived from the schemas). */
const ACTING: ReadonlyArray<[tool: string, args: Record<string, unknown>]> = [
  ['fox_click', { selector: '#a' }],
  ['fox_type', { text: 'x', selector: '#q' }],
  ['fox_type', { text: 'x', selector: '#q', pressEnter: true }],
  ['fox_set_value', { selector: '#v', value: '1' }],
  ['fox_select_option', { selector: 'select', value: 'a' }],
  ['fox_press_key', { key: 'Enter' }],
  ['fox_navigate', { action: 'back' }],
  ['fox_navigate', { action: 'forward' }],
  ['fox_navigate', { action: 'refresh' }],
  ['fox_navigate', { action: 'hard_refresh' }],
  ['fox_close_tab', { tabId: 1 }],
  ['fox_handle_dialog', { action: 'accept' }],
  // The page's own hover handlers run.
  ['fox_hover', { selector: '#h' }],
];
/** Acting tools whose `url` is the site they act on. */
const ACTING_ON_URL: ReadonlyArray<string> = ['fox_navigate', 'fox_create_tab', 'fox_open_in_container'];
const READING: ReadonlyArray<[tool: string, args: Record<string, unknown>]> = [
  ['fox_screenshot', {}],
  ['fox_screenshot', { scope: 'full_page' }],
  ['fox_screenshot', { scope: 'scroll_capture' }],
  ['fox_snapshot', {}],
  ['fox_get_elements', { selector: 'a' }],
  ['fox_get_text', {}],
  ['fox_find_text', { query: 'x' }],
  ['fox_get_page_info', {}],
];
const NOT_PAGE_READS: ReadonlyArray<[tool: string, args: Record<string, unknown>]> = [
  ['fox_screenshot', { scope: 'all_tabs' }],
  ['fox_get_tabs', {}],
  ['fox_list_containers', {}],
  ['fox_scroll', {}],
  ['fox_highlight', { selector: '#h' }],
  ['fox_switch_tab', { tabId: 1 }],
  ['fox_wait_for_element', { selector: '#w' }],
  ['fox_wait_for_network_idle', {}],
  ['fox_wait_for_navigation', {}],
  ['fox_wait_for_url', { url: 'https://other.test/' }],
  ['fox_request_approval', { message: 'm' }],
  ['fox_detect_captcha', {}],
  ['fox_safety_status', {}],
];

/** Pages the target tab may be on: any site, a local page, a blank tab. */
const PAGES = [
  'https://plain.example.test/',
  'https://bank.example.test/transfer',
  'http://127.0.0.1:8080/form.html',
  'file:///tmp/inari-test/page.html',
  'about:blank',
];

/** A guard that knows the active tab (and tab 1) is on `page`. */
function onPage(page: string, overrides: Partial<LoadedSafetyConfig> = {}): SafetyGuard {
  const g = guard(overrides);
  g.noteUrl({ tabs: [{ id: 1, url: page, active: true }] }, {}, 'fox_get_tabs');
  return g;
}

describe('approval by tool class (decision #9)', () => {
  it('the tables cover every operation', () => {
    const listed = new Set([...ACTING, ...READING, ...NOT_PAGE_READS].map(([tool]) => tool).concat(ACTING_ON_URL));
    expect(listed).toEqual(new Set(Object.keys(TOOL_SCHEMAS)));
  });

  describe.each(PAGES)('target tab on %s', (page) => {
    it.each(ACTING)('%s %j asks the human for the tab\'s page', (tool, args) => {
      expect(onPage(page).check(tool, args)).toMatchObject({
        safetyDecision: 'confirmation_required',
        layer: 7,
        elicitation: { url: page, matchedPattern: null, toolName: tool },
      });
    });

    it.each([...READING, ...NOT_PAGE_READS])('%s %j runs without asking', (tool, args) => {
      expect(decision(onPage(page), tool, args)).toBeNull();
    });
  });

  it.each(ACTING_ON_URL)('%s asks the human for the URL it goes to or opens', (tool) => {
    const url = 'https://dest.example.test/a';
    const g = onPage('https://plain.example.test/');
    const args = tool === 'fox_open_in_container' ? { url, containerName: 'Work' } : { url };
    expect(g.check(tool, args)).toMatchObject({
      safetyDecision: 'confirmation_required',
      elicitation: { url, matchedPattern: null },
    });
  });

  it('a new tab without a URL is asked about as a blank tab', () => {
    expect(approvalUrl(guard(), 'fox_create_tab', {})).toBe('about:blank');
  });

  it('an acting tool on a tab the guard has not seen asks without a URL (cannot be approved yet)', () => {
    expect(guard().check('fox_click', { selector: '#a' })).toMatchObject({
      safetyDecision: 'confirmation_required',
      elicitation: { url: null },
    });
    expect(approvalUrl(onPage('https://plain.example.test/'), 'fox_click', { tabId: 9 })).toBeNull();
  });

  it('reads ask only on confirm_read_sites', () => {
    const policy = { confirmReadSites: ['bank.example.test'] };
    for (const [tool, args] of READING) {
      expect(onPage('https://bank.example.test/transfer', policy).check(tool, args), tool).toMatchObject({
        safetyDecision: 'confirmation_required',
        layer: 4,
        elicitation: { url: 'https://bank.example.test/transfer', matchedPattern: 'bank.example.test' },
      });
      expect(decision(onPage('https://online.bank.example.test/', policy), tool, args), tool)
        .toBe('confirmation_required');
      expect(decision(onPage('https://plain.example.test/', policy), tool, args), tool).toBeNull();
      expect(decision(onPage('https://bank.example.test.attacker.test/', policy), tool, args), tool).toBeNull();
      // The guard does not know the tab: left to the Extension (confirmReadUrlRules).
      expect(decision(guard(policy), tool, args), tool).toBeNull();
    }
    for (const [tool, args] of NOT_PAGE_READS) {
      expect(decision(onPage('https://bank.example.test/', policy), tool, args), tool).toBeNull();
    }
  });

  it('an acting tool on a confirm_read_sites site is asked about as an action (no pattern)', () => {
    expect(onPage('https://bank.example.test/', { confirmReadSites: ['bank.example.test'] })
      .check('fox_click', { selector: '#a' })?.elicitation).toMatchObject({ matchedPattern: null });
  });

  it('a blocked site is refused before any approval, for acting and reading tools', () => {
    const g = onPage('https://blocked.example.test/', { blockedUrlPatterns: ['blocked.example.test'] });
    for (const [tool, args] of [...ACTING.filter(([t]) => t !== 'fox_close_tab'), ...READING]) {
      expect(decision(g, tool, args), tool).toBe('blocked_url');
    }
    expect(decision(g, 'fox_navigate', { url: 'https://blocked.example.test/x' })).toBe('blocked_url');
    expect(decision(g, 'fox_create_tab', { url: 'https://blocked.example.test/x' })).toBe('blocked_url');
  });

  it('the public tools get the same decisions', () => {
    const call = (g: SafetyGuard, tool: string, raw: Record<string, unknown>) => {
      const { op, args, label } = resolveOperation(tool, callSchemaFor(tool)!.parse(raw) as Record<string, unknown>);
      return g.check(op, args, undefined, null, label)?.safetyDecision ?? null;
    };
    const g = onPage('https://plain.example.test/');
    const r = onPage('https://bank.example.test/', { confirmReadSites: ['bank.example.test'] });
    const cases: Array<[tool: string, args: Record<string, unknown>, plain: string | null, readSite: string | null]> = [
      ['fox_read', { mode: 'text' }, null, 'confirmation_required'],
      ['fox_read', { mode: 'info' }, null, 'confirmation_required'],
      ['fox_find', { by: 'selector', selector: 'a' }, null, 'confirmation_required'],
      ['fox_find', { by: 'text', text: 'x' }, null, 'confirmation_required'],
      ['fox_screenshot', {}, null, 'confirmation_required'],
      ['fox_tabs', { what: 'tabs' }, null, null],
      ['fox_wait', { for: 'element', selector: '#w' }, null, null],
      ['fox_interact', { action: 'scroll' }, null, null],
      ['fox_interact', { action: 'hover', selector: '#h' }, 'confirmation_required', 'confirmation_required'],
      ['fox_tab', { action: 'switch', tabId: 1 }, null, null],
      ['fox_safety_status', {}, null, null],
      ['fox_tab', { action: 'create', url: 'https://plain.example.test/' }, 'confirmation_required', 'confirmation_required'],
      ['fox_tab', { action: 'create', url: 'https://plain.example.test/', container: { name: 'Work' } },
        'confirmation_required', 'confirmation_required'],
      ['fox_tab', { action: 'close', tabId: 1 }, 'confirmation_required', 'confirmation_required'],
      ['fox_set_value', { kind: 'select', selector: 's', option: { value: 'a' } }, 'confirmation_required', 'confirmation_required'],
      ['fox_click', { selector: '#a' }, 'confirmation_required', 'confirmation_required'],
      ['fox_navigate', { url: 'https://plain.example.test/x' }, 'confirmation_required', 'confirmation_required'],
    ];
    for (const [tool, args, plain, readSite] of cases) {
      expect(call(g, tool, args), `${tool} ${JSON.stringify(args)}`).toBe(plain);
      expect(call(r, tool, args), `${tool} ${JSON.stringify(args)} on a confirm_read_sites site`).toBe(readSite);
    }
  });

  it('the default policy has no site lists and reports the fixed approval policy', () => {
    expect(DEFAULT_CONFIG.confirmReadSites).toEqual([]);
    expect(guard().status()).toMatchObject({ approvalPolicy: APPROVAL_POLICY, confirmReadSites: [] });
    expect(guard().status()).not.toHaveProperty('protectedUrlPatterns');
    expect(guard().status()).not.toHaveProperty('confirmProtectedActions');
  });
});

describe('Layer 2-3 on the parsed target URL (2.B1)', () => {
  // confirmation_required: the URL passed the lists (an acting tool then asks the human).
  it('an allowlist entry does not admit look-alike hosts or URLs that merely mention it', () => {
    const g = guard({ allowedUrlPatterns: ['example\\.test'] });
    expect(decision(g, 'fox_navigate', { url: 'https://www.example.test/' })).toBe('confirmation_required');
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
    expect(decision(g, 'fox_create_tab', { url: 'about:blank' })).toBe('confirmation_required');
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
    expect(guard({ confirmReadSites: ['re:(unclosed'] }).status().configError).toContain('confirm_read_sites');
  });

  it('a legacy regex only warns', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const g = guard({ confirmReadSites: ['mychart\\.'] });
      expect(g.status().configError).toBeNull();
      expect(g.status().patternWarnings).toEqual([expect.stringMatching(/^confirm_read_sites 'mychart\\\.'/)]);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('per-tab URL tracking (2.B4): the page an approval is asked for', () => {
  it('keeps each tab URL apart', () => {
    const g = guard();
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 1 }, 'fox_get_text');
    g.noteUrl({ url: 'https://news.test/' }, { tabId: 2 }, 'fox_get_text');
    expect(approvalUrl(g, 'fox_click', { tabId: 1 })).toBe('https://bank.test/');
    expect(approvalUrl(g, 'fox_click', { tabId: 2 })).toBe('https://news.test/');
    // Nothing is known about the active tab yet.
    expect(approvalUrl(g, 'fox_click', {})).toBeNull();
  });

  it('commands without tabId track the active tab', () => {
    const g = guard();
    g.noteUrl({ url: 'https://bank.test/' }, {}, 'fox_navigate');
    expect(g.urlFor()).toBe('https://bank.test/');
    expect(approvalUrl(g, 'fox_click', {})).toBe('https://bank.test/');
    expect(approvalUrl(g, 'fox_click', { tabId: 7 })).toBeNull();
  });

  // Fs-09: such a page matches no URL pattern, and its approval could not name the site.
  it('refuses acting tools on a tab without a host, lets reading tools through, and asks on about: / file: pages', () => {
    const g = guard();
    const tabs = ['view-source:https://bank.test/', 'blob:https://bank.test/0b1c', 'data:text/html,<p>x</p>', 'about:blank', 'file:///tmp/a.html'];
    tabs.forEach((url, i) => g.noteUrl({ url }, { tabId: i + 1 }, 'fox_get_text'));
    const acting = tabs.map((_url, i) => decision(g, 'fox_click', { tabId: i + 1, selector: 'a' }));
    const reading = tabs.map((_url, i) => decision(g, 'fox_get_text', { tabId: i + 1 }));
    expect(acting).toEqual(['blocked_scheme', 'blocked_scheme', 'blocked_scheme', 'confirmation_required', 'confirmation_required']);
    expect(reading).toEqual([null, null, null, null, null]);
    expect(g.check('fox_click', { tabId: 1 })?.error).toMatch(/a page without a host/);
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

  // Only goto opens a new tab: back / forward / refresh act on the tab as it is.
  it.each(['back', 'forward', 'refresh'])('fox_navigate %s with newTab: true is approved for the page of the tab', (action) => {
    const g = guard();
    g.noteUrl({ url: 'https://a.test/' }, { tabId: 1 }, 'fox_get_text');
    expect(approvalUrl(g, 'fox_navigate', { tabId: 1, action, newTab: true })).toBe('https://a.test/');
  });

  it.each(['back', 'forward', 'refresh'])('fox_navigate %s with newTab: true records the URL for the tab it named', (action) => {
    const g = guard();
    g.noteUrl({ url: 'https://a.test/prev' }, { tabId: 1, action, newTab: true }, 'fox_navigate');
    expect(g.urlFor(1)).toBe('https://a.test/prev');
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
    const g = guard();
    g.noteUrl({ tabs: [{ id: 2, url: 'https://a.test/', active: true }] }, {}, 'fox_get_tabs');
    g.noteUrl({ url: 'https://b.test/' }, { url: 'https://b.test/' }, 'fox_navigate');
    expect(g.urlFor(2)).toBe('https://b.test/');
    // The active tab named by its id: still the tab later calls without tabId act on.
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 2, url: 'https://bank.test/' }, 'fox_navigate');
    expect(approvalUrl(g, 'fox_click', {})).toBe('https://bank.test/');
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
    const g = guard();
    g.noteUrl({ url: 'https://a.test/', tabId: 1 }, { url: 'https://a.test/' }, 'fox_navigate');
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 1, url: 'https://bank.test/' }, 'fox_navigate');
    expect(approvalUrl(g, 'fox_click', {})).toBe('https://bank.test/');
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
    // Leaving it is an acting call like any other: asked, not refused.
    expect(decision(g, 'fox_navigate', { tabId: 4, url: 'https://fine.test/' })).toBe('confirmation_required');
    expect(decision(g, 'fox_close_tab', { tabId: 4 })).toBe('confirmation_required');
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
  it('an acting tool: asked for the page the browser reports, without a pattern', () => {
    const g = guard();
    const c = g.confirmationFromBrowser('fox_click', { tabId: 5 }, { url: 'https://bank.test/' });
    expect(c).toMatchObject({ layer: 7, elicitation: { url: 'https://bank.test/', matchedPattern: null } });
    expect(g.urlFor(5)).toBe('https://bank.test/');
  });

  it('a read: names the confirm_read_sites entry', () => {
    const g = guard({ confirmReadSites: ['bank.test'] });
    const c = g.confirmationFromBrowser('fox_get_text', { tabId: 5 }, { url: 'https://bank.test/', matchedPattern: 'bank.test' });
    expect(c).toMatchObject({ layer: 4, elicitation: { url: 'https://bank.test/', matchedPattern: 'bank.test' } });
  });

  // WP-G P-2: the refused call closed nothing.
  it('a refused fox_close_tab leaves the tab and the active tab known', () => {
    const g = guard();
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 2 }, 'fox_switch_tab');
    g.confirmationFromBrowser('fox_close_tab', { tabId: 2 }, { url: 'https://bank.test/a' });
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
    const g = guard({ blockedUrlPatterns: ['blocked.test'] });
    g.noteUrl({ url: 'https://bank.test/' }, { tabId: 1 }, 'fox_click');
    g.noteUrl({ url: 'https://blocked.test/' }, { tabId: 2 }, 'fox_click');
    expect(approvalUrl(g, 'fox_navigate', { tabId: 1, action: 'refresh', url: 'https://fine.test/' }))
      .toBe('https://bank.test/');
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
      'confirmation_required' | 'out_of_scope' | 'invalid_url' |
      'blocked_after_navigation' | 'config_error' | 'paused'
    >();
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

  /** An acting call as the relay makes it: refused, approved by the human, retried with the token. */
  async function approvedCall(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const first = await createToolHandler(tool)(args);
    const requestId = (details(first)['approval'] as { requestId?: string } | undefined)?.requestId;
    if (requestId === undefined) throw new Error(`no approval request: ${JSON.stringify(first.content)}`);
    const reply = answerFromElicitation(requestId, true);
    return createToolHandler(tool)(args, { approvalToken: reply.approvalToken });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    testGuard.current = null;
  });

  it('forgets a closed tab even though fox_close_tab answers without data', async () => {
    const g = handlerGuard();
    g.noteUrl({ url: 'https://d.test/' }, { tabId: 4 }, 'fox_get_text');
    stubBrowser({ success: true }); // no `data` at all
    const result = await approvedCall('fox_tab', { action: 'close', tabId: 4 });
    expect(result.isError).toBeUndefined();
    expect(g.urlFor(4)).toBeNull();
  });

  it('records the URL a successful command reports', async () => {
    const g = handlerGuard();
    g.noteUrl({ url: 'https://start.test/' }, { tabId: 2 }, 'fox_get_text');
    stubBrowser({ success: true, data: { url: 'https://landing.test/x' } });
    await approvedCall('fox_click', { tabId: 2, selector: '#a' });
    expect(g.urlFor(2)).toBe('https://landing.test/x');
  });

  it('withholds a result that ended on a blocked site and remembers where the tab is', async () => {
    const g = handlerGuard({ blockedUrlPatterns: ['blocked.test'] });
    g.noteUrl({ url: 'https://start.test/' }, { tabId: 3 }, 'fox_get_text');
    stubBrowser({ success: true, data: { url: 'https://www.blocked.test/landing', text: 'secret' } });
    const result = await approvedCall('fox_click', { tabId: 3, selector: '#go' });
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

  it('an acting call on an unknown tab is not sent and cannot be approved yet', async () => {
    handlerGuard();
    const send = vi.spyOn(getConnectionManager(), 'sendCommand');
    const result = await createToolHandler('fox_click')({ tabId: 8, selector: '#a' });
    expect(send).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(details(result)).toMatchObject({ decision: 'confirmation_required', confirmationRequired: true });
    expect(details(result)).not.toHaveProperty('approval');
    expect(JSON.stringify(result.content)).toContain('Call fox_tabs');
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
    const ok = await auditLinesOf(() => createToolHandler('fox_screenshot')({ tabId: 2 }));
    expect(decisions(ok)).toEqual(['allowed']);

    stubBrowser({ success: false, error: 'Capture failed' });
    const failed = await auditLinesOf(() => createToolHandler('fox_screenshot')({ tabId: 2, scope: 'full_page' }));
    expect(decisions(failed)).toEqual(['allowed', 'browser_error']);
    expect(failed[1]).toMatchObject({ tool: 'fox_screenshot', args: { tabId: 2, scope: 'full_page' } });
  });

  it('audits an acting call as asked, approved and allowed by the human', async () => {
    const g = handlerGuard({ auditLog: true });
    g.noteUrl({ url: 'https://fine.test/' }, { tabId: 2 }, 'fox_get_text');
    stubBrowser({ success: true, data: { url: 'https://fine.test/' } });
    const lines = await auditLinesOf(() => approvedCall('fox_click', { tabId: 2, selector: '#a' }));
    expect(decisions(lines)).toEqual(['confirmation_required', 'approval_granted', 'allowed_by_human']);
  });

  it('writes no audit line with audit_log off', async () => {
    handlerGuard({ auditLog: false });
    stubBrowser({ success: false, error: 'Element not found' });
    const lines = await auditLinesOf(() => createToolHandler('fox_read')({ mode: 'text', selector: '#a' }));
    expect(lines).toEqual([]);
  });

  it('masks a secret in the url of an audit line, as in the url argument', async () => {
    const g = handlerGuard({ auditLog: true });
    const lines = await auditLinesOf(async () => {
      g.check('fox_navigate', { url: 'https://fine.test/cb?code=1#access_token=abc' });
      await Promise.resolve();
    });
    const masked = 'https://fine.test/cb?code=1#access_token=[MASKED]';
    expect(lines).toEqual([expect.objectContaining({ decision: 'confirmation_required', url: masked, args: { url: masked } })]);
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
      result = await createToolHandler('fox_tabs')({ what: 'tabs', urlPattern: '(' });
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
    const calls: Array<[tool: string, args: Record<string, unknown>]> = [
      ['fox_screenshot', {}], ['fox_snapshot', {}],
      ['fox_find', { by: 'selector', selector: 'a' }], ['fox_find', { by: 'text', text: 'x' }],
      ['fox_read', { mode: 'text' }], ['fox_read', { mode: 'info' }],
      ['fox_tabs', { what: 'tabs' }], ['fox_tabs', { what: 'containers' }],
      ['fox_navigate', { url: 'https://a.test/' }], ['fox_click', {}], ['fox_type', { text: 'x' }],
      ['fox_press_key', { key: 'a' }], ['fox_set_value', { selector: '#a', value: 'v' }],
      ['fox_set_value', { kind: 'select', selector: '#s', option: { value: 'a' } }],
      ['fox_interact', { action: 'hover', selector: '#a' }], ['fox_interact', { action: 'scroll' }],
      ['fox_interact', { action: 'highlight', selector: '#a' }],
      ['fox_tab', { action: 'create' }],
      ['fox_tab', { action: 'create', url: 'https://a.test/', container: { name: 'W' } }],
      ['fox_tab', { action: 'close', tabId: 1 }], ['fox_tab', { action: 'switch', tabId: 1 }],
      ['fox_wait', { for: 'element', selector: '#a' }], ['fox_wait', { for: 'network_idle' }],
      ['fox_wait', { for: 'navigation' }], ['fox_wait', { for: 'url', url: 'https://a.test/' }],
      ['fox_handle_dialog', { action: 'accept' }], ['fox_request_approval', { message: 'm' }],
      ['fox_detect_captcha', {}], ['fox_safety_status', {}],
    ];
    const parsed = calls.map(([tool, raw]) => [tool, callSchemaFor(tool)!.parse(raw) as Record<string, unknown>] as const);
    const ops = new Set(parsed.map(([tool, args]) => resolveOperation(tool, args).op));
    expect(ops).toEqual(new Set(Object.keys(TOOL_SCHEMAS)));
    for (const [tool, args] of parsed) await createToolHandler(tool)(args);
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

  it('a call waiting for approval does not use up the budget', () => {
    const g = guard({ maxActionsPerMinute: 1 });
    g.noteUrl({ url: 'https://a.test/' }, {}, 'fox_get_text');
    expect(decision(g, 'fox_click', {})).toBe('confirmation_required');
    expect(g.status().actionsInLastMinute).toBe(0);
  });
});

describe('call label (the name the caller used)', () => {
  it('names the called tool and its arguments in messages and the audit log, not the operation', () => {
    const g = guard({ readOnly: true, auditLog: true });
    const denial = g.check('fox_close_tab', { tabId: 7 }, 'stdio', null, {
      tool: 'fox_tab', args: { action: 'close', tabId: 7 },
    });
    expect(denial?.error).toMatch(/^fox_tab refused/);
    const lines = fs.readFileSync(getAuditLogPath(), 'utf-8').trim().split('\n');
    const line = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({ tool: 'fox_tab', args: { action: 'close', tabId: 7 }, decision: 'read_only' });
    expect(line).not.toHaveProperty('legacyTool');
  });
});
