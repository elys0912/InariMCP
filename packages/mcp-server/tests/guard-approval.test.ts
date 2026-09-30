import { describe, expect, it } from 'vitest';
import { SafetyGuard } from '../src/safety/guard.js';
import { DEFAULT_CONFIG, type SafetyConfig } from '../src/safety/config.js';
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

  it('never lifts other denials (read-only, scripts off, blocklist, scheme)', () => {
    const click = { selector: '#go' };
    const ro = guard({ readOnly: true });
    ro.noteUrl({ url: PROTECTED });
    expect(ro.check('fox_click', click, undefined, grantFor('fox_click', click)))
      .toMatchObject({ safetyDecision: 'read_only' });

    const script = { script: '1' };
    const noScripts = guard({ allowScriptExecution: false });
    noScripts.noteUrl({ url: PROTECTED });
    expect(noScripts.check('fox_execute_script', script, undefined, grantFor('fox_execute_script', script)))
      .toMatchObject({ safetyDecision: 'scripts_disabled' });

    const nav = { url: PROTECTED };
    expect(
      guard({ blockedUrlPatterns: ['transfer'] }).check('fox_navigate', nav, undefined, grantFor('fox_navigate', nav)),
    ).toMatchObject({ safetyDecision: 'blocked_url' });

    const js = { url: 'javascript:alert(1)' };
    expect(guard().check('fox_navigate', js, undefined, grantFor('fox_navigate', js)))
      .toMatchObject({ safetyDecision: 'blocked_scheme' });
  });
});

describe('grantCoversDenial', () => {
  const denial = {
    success: false as const,
    safetyDecision: 'confirmation_required',
    error: 'x',
    confirmationRequired: true as const,
    elicitation: { protectedUrl: PROTECTED, matchedPattern: 'p', toolName: 'fox_click' },
  };

  it('needs a grant, a confirmation_required denial and the same host', () => {
    const grant = grantFor('fox_click', {});
    expect(grantCoversDenial(denial, grant)).toBe(true);
    expect(grantCoversDenial(denial, null)).toBe(false);
    expect(grantCoversDenial(null, grant)).toBe(false);
    expect(grantCoversDenial({ ...denial, safetyDecision: 'read_only' }, grant)).toBe(false);
    expect(grantCoversDenial(denial, grantFor('fox_click', {}, 'bank.example.test.evil.test'))).toBe(false);
    expect(
      grantCoversDenial({ ...denial, elicitation: { ...denial.elicitation, protectedUrl: '(target tab)' } }, grant),
    ).toBe(false);
  });
});
