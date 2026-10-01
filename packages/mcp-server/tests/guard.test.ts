import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafetyGuard } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, loadConfig, type LoadedSafetyConfig } from '../src/safety/config.js';

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

describe('loadConfig (2.B2)', () => {
  let dir: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-guard-'));
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function load(content: string | null): LoadedSafetyConfig {
    const file = path.join(dir, 'safety.json');
    if (content !== null) fs.writeFileSync(file, content);
    // Keep ~/.kitsune-mcp of the real home out of reach.
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('FOX_SAFETY_CONFIG', file);
    vi.stubEnv('FOX_READ_ONLY', '');
    vi.stubEnv('FOX_ALLOW_SCRIPTS', '');
    return loadConfig();
  }

  it.each([
    ['invalid JSON', '{ "read_only": true,'],
    ['not an object', '[]'],
    ['a schema violation', '{ "max_actions_per_minute": "many" }'],
  ])('reports %s as configError', (_label, content) => {
    const cfg = load(content);
    expect(cfg.configError).toBeTruthy();
    expect(new SafetyGuard({ ...cfg, auditLog: false }).check('fox_screenshot', {})?.safetyDecision)
      .toBe('config_error');
  });

  it('loads a valid file without configError', () => {
    const cfg = load('{ "read_only": true, "blocked_url_patterns": ["blocked.test"] }');
    expect(cfg.configError).toBeUndefined();
    expect(cfg.readOnly).toBe(true);
    expect(cfg.blockedUrlPatterns).toEqual(['blocked.test']);
  });

  it('writes the defaults when the file is missing', () => {
    const cfg = load(null);
    expect(cfg.configError).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'safety.json'))).toBe(true);
  });

  // Windows ignores the mode bits (see the WP2 note on 0o600 / 0o700).
  it.skipIf(process.platform === 'win32')('creates a missing config directory 0o700', () => {
    const file = path.join(dir, 'sub', 'safety.json');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    vi.stubEnv('FOX_SAFETY_CONFIG', file);
    loadConfig();
    expect(fs.statSync(path.join(dir, 'sub')).mode & 0o777).toBe(0o700);
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
    // TODO(test): `closed` differing from the tabId argument; headless closedTabId.
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
});

describe('the reached URL and the tab URL against blocked/allowed lists (2.B3)', () => {
  it('withholds a result that ended on a blocked site', () => {
    const g = guard({ blockedUrlPatterns: ['blocked.test'] });
    const denial = g.checkReachedUrl('fox_click', {}, { url: 'https://www.blocked.test/landing' });
    expect(denial?.safetyDecision).toBe('blocked_after_navigation');
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
});

describe('review follow-ups', () => {
  it("fox_wait_for_url's url is not a navigation target: the tab URL is checked", () => {
    const g = guard({ blockedUrlPatterns: ['blocked.test'] });
    g.noteUrl({ url: 'https://blocked.test/' }, { tabId: 1 }, 'fox_click');
    expect(decision(g, 'fox_wait_for_url', { tabId: 1, url: 'https://fine.test/' })).toBe('blocked_url');
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

// TODO(test): handlers.ts calls noteUrl() for data-less successes (fox_close_tab returns {success:true} only) — cover through createToolHandler with a fake browser.
// TODO(test): checkReachedUrl through createToolHandler: result withheld and the tab URL recorded.

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
