import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAYER, SafetyGuard, type SafetyDenial } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, getAuditLogPath, type SafetyConfig } from '../src/safety/config.js';
import { grantCoversDenial, hashArgs, type ApprovalGrant } from '../src/safety/approval.js';

const SITE = 'https://bank.example.test/transfer';

function guard(overrides: Partial<SafetyConfig> = {}): SafetyGuard {
  return new SafetyGuard({
    ...DEFAULT_CONFIG,
    auditLog: false,
    maxActionsPerMinute: 0,
    containerScope: { enabled: false, containerName: 'Agent' },
    ...overrides,
  });
}

function grantFor(toolName: string, args: Record<string, unknown>, site = 'bank.example.test'): ApprovalGrant {
  return { target: { toolName, site, argsHash: hashArgs(args) }, via: 'browser', requestId: 'r1' };
}

describe('SafetyGuard.check with an approval grant', () => {
  it('without a grant, an acting tool needs confirmation', () => {
    const args = { url: SITE };
    expect(guard().check('fox_navigate', args)).toMatchObject({
      safetyDecision: 'confirmation_required',
      elicitation: { url: SITE, matchedPattern: null, toolName: 'fox_navigate' },
    });
  });

  it('a grant for the site lets exactly that call through', () => {
    const args = { url: SITE };
    expect(guard().check('fox_navigate', args, { grant: grantFor('fox_navigate', args) })).toBeNull();
  });

  it('a grant for another host does not', () => {
    const args = { url: SITE };
    expect(
      guard().check('fox_navigate', args, { grant: grantFor('fox_navigate', args, 'other.example.test') }),
    ).toMatchObject({ safetyDecision: 'confirmation_required' });
  });

  it('covers the last-seen URL (tools without url) and reads of a confirm_read_sites site', () => {
    const g = guard({ confirmReadSites: ['bank.example.test'] });
    g.noteUrl({ url: SITE });
    const click = { selector: '#go' };
    expect(g.check('fox_click', click)).toMatchObject({ safetyDecision: 'confirmation_required' });
    expect(g.check('fox_click', click, { grant: grantFor('fox_click', click) })).toBeNull();

    const shot = { scope: 'viewport' };
    expect(g.check('fox_screenshot', shot)).toMatchObject({ safetyDecision: 'confirmation_required' });
    expect(g.check('fox_screenshot', shot, { grant: grantFor('fox_screenshot', shot) })).toBeNull();
  });

  it('never lifts other denials (read-only, blocklist, scheme)', () => {
    const click = { selector: '#go' };
    const ro = guard({ readOnly: true });
    ro.noteUrl({ url: SITE });
    expect(ro.check('fox_click', click, { grant: grantFor('fox_click', click) }))
      .toMatchObject({ safetyDecision: 'read_only' });

    const nav = { url: SITE };
    expect(
      guard({ blockedUrlPatterns: ['bank.example.test/transfer'] }).check('fox_navigate', nav, { grant: grantFor('fox_navigate', nav) }),
    ).toMatchObject({ safetyDecision: 'blocked_url' });

    const js = { url: 'javascript:alert(1)' };
    expect(guard().check('fox_navigate', js, { grant: grantFor('fox_navigate', js) }))
      .toMatchObject({ safetyDecision: 'blocked_scheme' });
  });

  // WP-G P-4: allowed_by_human only for a call the grant let through.
  it('audits allowed_by_human only when the grant lifted the confirmation', () => {
    const lastDecision = (): unknown =>
      JSON.parse(fs.readFileSync(getAuditLogPath(), 'utf-8').trim().split('\n').at(-1)!)['decision'];
    const g = guard({ auditLog: true });

    const nav = { url: SITE };
    expect(g.check('fox_navigate', nav, { grant: grantFor('fox_navigate', nav) })).toBeNull();
    expect(lastDecision()).toBe('allowed_by_human');

    // Nothing to lift: a read that needs no approval stays an ordinary allowed call.
    g.noteUrl({ url: SITE });
    const read = {};
    expect(g.check('fox_get_text', read, { grant: grantFor('fox_get_text', read) })).toBeNull();
    expect(lastDecision()).toBe('allowed');
  });

  it('a local page or a new blank tab is approved by its scheme', () => {
    const g = guard();
    g.noteUrl({ url: 'file:///tmp/inari-test/page.html' });
    const click = { selector: '#go' };
    expect(g.check('fox_click', click, { grant: grantFor('fox_click', click, 'file:') })).toBeNull();
    expect(g.check('fox_click', click, { grant: grantFor('fox_click', click, 'bank.example.test') }))
      .toMatchObject({ safetyDecision: 'confirmation_required' });
    expect(guard().check('fox_create_tab', {}, { grant: grantFor('fox_create_tab', {}, 'about:') })).toBeNull();
  });

  it('a call on a tab the guard does not know cannot be lifted by any grant', () => {
    const click = { selector: '#go' };
    expect(guard().check('fox_click', click, { grant: grantFor('fox_click', click) }))
      .toMatchObject({ safetyDecision: 'confirmation_required', elicitation: { url: null } });
  });
});

describe('grantCoversDenial', () => {
  const elicitation = { url: SITE, matchedPattern: null, toolName: 'fox_click' };
  const denial: SafetyDenial = {
    success: false,
    safetyDecision: 'confirmation_required',
    layer: LAYER.approval,
    error: 'x',
    confirmationRequired: true,
    elicitation,
  };

  it('needs a grant, a confirmation_required denial and the same host', () => {
    const grant = grantFor('fox_click', {});
    expect(grantCoversDenial(denial, grant)).toBe(true);
    expect(grantCoversDenial(denial, null)).toBe(false);
    expect(grantCoversDenial(null, grant)).toBe(false);
    expect(grantCoversDenial({ ...denial, safetyDecision: 'read_only' }, grant)).toBe(false);
    expect(grantCoversDenial(denial, grantFor('fox_click', {}, 'bank.example.test.evil.test'))).toBe(false);
    expect(
      grantCoversDenial({ ...denial, elicitation: { ...elicitation, url: '(target tab)' } }, grant),
    ).toBe(false);
    expect(grantCoversDenial({ ...denial, elicitation: { ...elicitation, url: null } }, grant)).toBe(false);
  });
});
