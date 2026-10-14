import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAYER, SafetyGuard, type SafetyDenial } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, getAuditLogPath, type SafetyConfig } from '../src/safety/config.js';
import { grantCoversDenial, hashArgs, type ApprovalGrant } from '../src/safety/approval.js';

const PROTECTED = 'https://bank.example.test/transfer';

function guard(overrides: Partial<SafetyConfig> = {}): SafetyGuard {
  return new SafetyGuard({
    ...DEFAULT_CONFIG,
    auditLog: false,
    maxActionsPerMinute: 0,
    protectedUrlPatterns: ['bank\\.example\\.test'],
    containerScope: { enabled: false, containerName: 'Agent' },
    ...overrides,
  });
}

function grantFor(toolName: string, args: Record<string, unknown>, host = 'bank.example.test'): ApprovalGrant {
  return { target: { toolName, host, argsHash: hashArgs(args) }, via: 'browser', requestId: 'r1' };
}

describe('SafetyGuard.check with an approval grant', () => {
  it('without a grant, an acting tool on a protected URL needs confirmation', () => {
    const args = { url: PROTECTED };
    expect(guard().check('fox_navigate', args)).toMatchObject({
      safetyDecision: 'confirmation_required',
      elicitation: { protectedUrl: PROTECTED, toolName: 'fox_navigate' },
    });
  });

  it('a grant for the protected host lets exactly that call through', () => {
    const args = { url: PROTECTED };
    expect(guard().check('fox_navigate', args, undefined, grantFor('fox_navigate', args))).toBeNull();
  });

  it('a grant for another host does not', () => {
    const args = { url: PROTECTED };
    expect(
      guard().check('fox_navigate', args, undefined, grantFor('fox_navigate', args, 'other.example.test')),
    ).toMatchObject({ safetyDecision: 'confirmation_required' });
  });

  it('covers the last-seen URL (tools without url) and single-tab screenshots', () => {
    const g = guard();
    g.noteUrl({ url: PROTECTED });
    const click = { selector: '#go' };
    expect(g.check('fox_click', click)).toMatchObject({ safetyDecision: 'confirmation_required' });
    expect(g.check('fox_click', click, undefined, grantFor('fox_click', click))).toBeNull();

    const shot = { scope: 'viewport' };
    expect(g.check('fox_screenshot', shot)).toMatchObject({ safetyDecision: 'confirmation_required' });
    expect(g.check('fox_screenshot', shot, undefined, grantFor('fox_screenshot', shot))).toBeNull();
  });

  it('never lifts other denials (read-only, blocklist, scheme)', () => {
    const click = { selector: '#go' };
    const ro = guard({ readOnly: true });
    ro.noteUrl({ url: PROTECTED });
    expect(ro.check('fox_click', click, undefined, grantFor('fox_click', click)))
      .toMatchObject({ safetyDecision: 'read_only' });

    const nav = { url: PROTECTED };
    expect(
      guard({ blockedUrlPatterns: ['bank.example.test/transfer'] }).check('fox_navigate', nav, undefined, grantFor('fox_navigate', nav)),
    ).toMatchObject({ safetyDecision: 'blocked_url' });

    const js = { url: 'javascript:alert(1)' };
    expect(guard().check('fox_navigate', js, undefined, grantFor('fox_navigate', js)))
      .toMatchObject({ safetyDecision: 'blocked_scheme' });
  });

  // WP-G P-4: allowed_by_human only for a call the grant let through.
  it('audits allowed_by_human only when the grant lifted the confirmation', () => {
    const lastDecision = (): unknown =>
      JSON.parse(fs.readFileSync(getAuditLogPath(), 'utf-8').trim().split('\n').at(-1)!)['decision'];
    const g = guard({ auditLog: true });

    const toProtected = { url: PROTECTED };
    expect(g.check('fox_navigate', toProtected, undefined, grantFor('fox_navigate', toProtected))).toBeNull();
    expect(lastDecision()).toBe('allowed_by_human');

    // Nothing to lift: an ordinary allowed call.
    const toPlain = { url: 'https://plain.example.test/' };
    expect(g.check('fox_navigate', toPlain, undefined, grantFor('fox_navigate', toPlain))).toBeNull();
    expect(lastDecision()).toBe('allowed');
  });
});

describe('grantCoversDenial', () => {
  const elicitation = { protectedUrl: PROTECTED, matchedPattern: 'p', toolName: 'fox_click' };
  const denial: SafetyDenial = {
    success: false,
    safetyDecision: 'confirmation_required',
    layer: LAYER.protected,
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
      grantCoversDenial({ ...denial, elicitation: { ...elicitation, protectedUrl: '(target tab)' } }, grant),
    ).toBe(false);
  });
});
