import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV_DEFAULTS } from '@inari-mcp/shared';
import { answerFromElicitation } from '../src/tools/approval-flow.js';
import { DAEMON_SETTING_KEYS } from '../src/utils/endpoint.js';
import {
  ApprovalStore,
  isElicitationApprovalEnabled,
  approvalTargetFor,
  canonicalJson,
  hashArgs,
  summarizeArgs,
  approvalDisplayUrl,
  SUMMARY_HIDDEN_CHARS_WARNING,
  SUMMARY_MAX,
  SUMMARY_VALUE_MAX,
  type ApprovalTarget,
} from '../src/safety/approval.js';
import { truncateCodePoints } from '../src/utils/text.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const ARGS = { selector: '#pay', tabId: 3 };
const TARGET: ApprovalTarget = { toolName: 'fox_click', site: 'pay.example.test', argsHash: hashArgs(ARGS) };
const INFO = { url: 'https://pay.example.test/checkout', matchedPattern: null, summary: 's' };

function issued(store: ApprovalStore, target = TARGET): string {
  const request = store.createRequest(target, INFO);
  const token = store.issueToken(request.id, 'browser');
  expect(token).not.toBeNull();
  return token!.token;
}

// approvalSiteOf itself: packages/shared/tests/approval-site.test.ts.
describe('approval target helpers', () => {
  it('hashArgs does not depend on key order, but on every value', () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashArgs({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs({ a: [1, 2] })).not.toBe(hashArgs({ a: [2, 1] }));
    expect(canonicalJson({ b: 1, a: undefined, c: 'x' })).toBe('{"b":1,"c":"x"}');
  });

  it('approvalTargetFor binds tool, site and argument hash', () => {
    expect(approvalTargetFor('fox_click', ARGS, 'https://pay.example.test/a')).toEqual(TARGET);
    expect(approvalTargetFor('fox_click', ARGS, '(target tab)')).toBeNull();
    expect(approvalTargetFor('fox_click', ARGS, null)).toBeNull();
  });

  it('summarizeArgs shows values in full and masks password', () => {
    const script = 'x'.repeat(SUMMARY_VALUE_MAX - 2); // the two quotes make it SUMMARY_VALUE_MAX
    const summary = summarizeArgs({ text: 'hello', password: 'secret', script });
    expect(summary).toContain('text: "hello"');
    expect(summary).toContain('password: ***');
    expect(summary).toContain(`script: "${script}"`);
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('…');
    expect(summarizeArgs({})).toBe('(no arguments)');
  });

  // A-KM-01: a cut summary let the human approve what they were not shown.
  it('summarizeArgs gives null instead of cutting a value or the whole summary', () => {
    expect(summarizeArgs({ script: 'x'.repeat(SUMMARY_VALUE_MAX - 1) })).toBeNull();
    // counted in UTF-16 units, as the popup clips: 80 emoji are 82 code points but 162 units
    expect(summarizeArgs({ text: '😀'.repeat(SUMMARY_VALUE_MAX / 2) })).toBeNull();
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) many[`k${String(i).padStart(2, '0')}`] = 'x'.repeat(50);
    expect(summarizeArgs(many)).toBeNull();
    // under both limits: shown whole
    const fits: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) fits[`k${i}`] = 'x'.repeat(70);
    const summary = summarizeArgs(fits);
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(summary).not.toContain('…');
  });

  // B-KM-01: bidi overrides, zero-width and tag characters, U+2028 / U+2029.
  it('summarizeArgs shows invisible and reordering characters as escapes, with a warning', () => {
    const summary = summarizeArgs({
      script: 'safe()\u202E;)(yenom_dnes',
      text: 'a\u2028b\u2029c\u200Bd\u{E0041}e',
    });
    expect(summary).not.toBeNull();
    expect(summary!.split('\n')[0]).toBe(SUMMARY_HIDDEN_CHARS_WARNING);
    expect(summary).toContain(String.raw`script: "safe()\u202E;)(yenom_dnes"`);
    expect(summary).toContain(String.raw`text: "a\u2028b\u2029c\u200Bd\u{E0041}e"`);
    expect(summary).not.toMatch(/[\u200B\u202E\u2028\u2029]|\uDB40/);
    // nested values and keys as well
    expect(summarizeArgs({ options: { note: '\u2066x' } })).toContain(String.raw`\u2066x`);
    expect(summarizeArgs({ ['k\u202E']: 1 })).toContain(String.raw`k\u202E: 1`);
    // plain text: no warning
    expect(summarizeArgs({ text: 'hello' })).toBe('text: "hello"');
  });

  it('approvalDisplayUrl escapes invisible characters of the URL', () => {
    expect(approvalDisplayUrl('https://pay.example.test/\u202Efdp.exe'))
      .toBe(String.raw`https://pay.example.test/\u202Efdp.exe`);
    expect(approvalDisplayUrl('https://pay.example.test/a')).toBe('https://pay.example.test/a');
  });
});

describe('truncateCodePoints', () => {
  it('counts code points and appends the ellipsis only when it cut', () => {
    expect(truncateCodePoints('abc', 3)).toBe('abc');
    expect(truncateCodePoints('abcd', 3)).toBe('abc…');
    expect(truncateCodePoints('😀😀😀', 3)).toBe('😀😀😀');
    expect(truncateCodePoints('😀😀😀😀', 3)).toBe('😀😀😀…');
    expect(truncateCodePoints('a😀b', 2, '')).toBe('a😀');
  });
});

describe('ApprovalStore: tokens', () => {
  it('a token is accepted once for its target, then never again (single use)', () => {
    const store = new ApprovalStore();
    const token = issued(store);
    expect(token).toMatch(/^iat_[A-Za-z0-9_-]{43}$/);
    const grant = store.consume(token, 'fox_click', TARGET.argsHash);
    expect(grant).toMatchObject({ target: TARGET, via: 'browser' });
    expect(store.consume(token, 'fox_click', TARGET.argsHash)).toBeNull();
  });

  it('an expired token is refused', () => {
    const c = clock();
    const store = new ApprovalStore({ now: c.now, tokenTtlMs: 60_000 });
    const token = issued(store);
    c.advance(60_000);
    expect(store.consume(token, 'fox_click', TARGET.argsHash)).toBeNull();
  });

  it('a token for another tool or other arguments is refused and burnt', () => {
    const store = new ApprovalStore();
    const t1 = issued(store);
    expect(store.consume(t1, 'fox_type', TARGET.argsHash)).toBeNull();
    // burnt: the right target no longer works either
    expect(store.consume(t1, 'fox_click', TARGET.argsHash)).toBeNull();

    const t2 = issued(store);
    expect(store.consume(t2, 'fox_click', hashArgs({ ...ARGS, selector: '#other' }))).toBeNull();
    expect(store.consume(t2, 'fox_click', TARGET.argsHash)).toBeNull();
  });

  it('unknown or malformed tokens are refused', () => {
    const store = new ApprovalStore();
    issued(store);
    expect(store.consume('iat_' + 'A'.repeat(43), 'fox_click', TARGET.argsHash)).toBeNull();
    expect(store.consume('', 'fox_click', TARGET.argsHash)).toBeNull();
    expect(store.consume('not-a-token', 'fox_click', TARGET.argsHash)).toBeNull();
  });
});

describe('ApprovalStore: requests', () => {
  it('a request yields at most one token', () => {
    const store = new ApprovalStore();
    const request = store.createRequest(TARGET, INFO);
    expect(store.issueToken(request.id, 'elicitation')).not.toBeNull();
    expect(store.issueToken(request.id, 'elicitation')).toBeNull();
  });

  it('an expired request can no longer be approved', () => {
    const c = clock();
    const store = new ApprovalStore({ now: c.now, requestTtlMs: 120_000 });
    const request = store.createRequest(TARGET, INFO);
    expect(request.expiresAt).toBe(c.now() + 120_000);
    c.advance(120_000);
    expect(store.getRequest(request.id)).toBeUndefined();
    expect(store.issueToken(request.id, 'browser')).toBeNull();
  });

  it('a closed (declined) request can no longer be approved', () => {
    const store = new ApprovalStore();
    const request = store.createRequest(TARGET, INFO);
    store.closeRequest(request.id);
    expect(store.issueToken(request.id, 'browser')).toBeNull();
  });

  it('keeps at most maxPending open requests (oldest dropped)', () => {
    const store = new ApprovalStore({ maxPending: 2 });
    const a = store.createRequest(TARGET, INFO);
    const b = store.createRequest(TARGET, INFO);
    const c = store.createRequest(TARGET, INFO);
    expect(store.getRequest(a.id)).toBeUndefined();
    expect(store.getRequest(b.id)).toBeDefined();
    expect(store.getRequest(c.id)).toBeDefined();
    expect(store.pendingCount).toBe(2);
  });
});

describe('FOX_APPROVAL_ELICITATION', () => {
  // answerFromElicitation audits through the guard singleton: keep it off
  // the real ~/.inari-mcp (no audit log, temp safety.json).
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-elicit-'));
    const file = path.join(dir, 'safety.json');
    fs.writeFileSync(file, JSON.stringify({ audit_log: false }));
    process.env['FOX_SAFETY_CONFIG'] = file;
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults to ENV_DEFAULTS.FOX_APPROVAL_ELICITATION (currently on)', () => {
    expect(ENV_DEFAULTS.FOX_APPROVAL_ELICITATION).toBe(true);
    expect(isElicitationApprovalEnabled({})).toBe(ENV_DEFAULTS.FOX_APPROVAL_ELICITATION);
    expect(isElicitationApprovalEnabled({ FOX_APPROVAL_ELICITATION: '  ' })).toBe(ENV_DEFAULTS.FOX_APPROVAL_ELICITATION);
  });

  it.each(['0', 'false', 'FALSE', 'off', 'No'])('%s turns it off', (v) => {
    expect(isElicitationApprovalEnabled({ FOX_APPROVAL_ELICITATION: v })).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes'])('%s turns it on', (v) => {
    expect(isElicitationApprovalEnabled({ FOX_APPROVAL_ELICITATION: v })).toBe(true);
  });

  it('when off, the daemon refuses elicitation answers and issues no token', () => {
    const store = new ApprovalStore();
    const request = store.createRequest(TARGET, INFO);
    const off = answerFromElicitation(request.id, true, 'relay:r1', store, { FOX_APPROVAL_ELICITATION: '0' });
    expect(off).toMatchObject({ success: false, approved: false, reason: 'elicitation_disabled' });
    expect(off.approvalToken).toBeUndefined();
    // The request stays open for the popup.
    expect(store.getRequest(request.id)).toBeDefined();
    const on = answerFromElicitation(request.id, true, 'relay:r1', store, { FOX_APPROVAL_ELICITATION: '1' });
    expect(on).toMatchObject({ success: true, approved: true });
  });

  it('is a daemon setting (reported when a session differs from the running daemon)', () => {
    expect(DAEMON_SETTING_KEYS).toContain('FOX_APPROVAL_ELICITATION');
  });
});
