import { describe, expect, it } from 'vitest';
import {
  ApprovalStore,
  approvalTargetFor,
  canonicalJson,
  hashArgs,
  hostOf,
  summarizeArgs,
  type ApprovalTarget,
} from '../src/safety/approval.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const ARGS = { selector: '#pay', tabId: 3 };
const TARGET: ApprovalTarget = { toolName: 'fox_click', host: 'pay.example.test', argsHash: hashArgs(ARGS) };
const INFO = { protectedUrl: 'https://pay.example.test/checkout', matchedPattern: 'example\\.test', summary: 's' };

function issued(store: ApprovalStore, target = TARGET): string {
  const request = store.createRequest(target, INFO);
  const token = store.issueToken(request.id, 'browser');
  expect(token).not.toBeNull();
  return token!.token;
}

describe('approval target helpers', () => {
  it('hostOf: lower-case hostname, null for non-URLs', () => {
    expect(hostOf('https://Pay.Example.TEST:8443/x?y')).toBe('pay.example.test');
    expect(hostOf('about:blank')).toBeNull();
    expect(hostOf('(target tab)')).toBeNull();
    expect(hostOf('')).toBeNull();
    expect(hostOf(null)).toBeNull();
  });

  it('hashArgs does not depend on key order, but on every value', () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashArgs({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs({ a: [1, 2] })).not.toBe(hashArgs({ a: [2, 1] }));
    expect(canonicalJson({ b: 1, a: undefined, c: 'x' })).toBe('{"b":1,"c":"x"}');
  });

  it('approvalTargetFor binds tool, host and argument hash', () => {
    expect(approvalTargetFor('fox_click', ARGS, 'https://pay.example.test/a')).toEqual(TARGET);
    expect(approvalTargetFor('fox_click', ARGS, '(target tab)')).toBeNull();
  });

  it('summarizeArgs shows values, masks password, cuts long strings', () => {
    const summary = summarizeArgs({ text: 'hello', password: 'secret', script: 'x'.repeat(500) });
    expect(summary).toContain('text: "hello"');
    expect(summary).toContain('password: ***');
    expect(summary).not.toContain('secret');
    expect(summary.length).toBeLessThan(400);
    expect(summarizeArgs({})).toBe('(no arguments)');
  });
});

describe('ApprovalStore: tokens', () => {
  it('a token is accepted once for its target, then never again (single use)', () => {
    const store = new ApprovalStore();
    const token = issued(store);
    expect(token).toMatch(/^kat_[A-Za-z0-9_-]{43}$/);
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
    expect(store.consume('kat_' + 'A'.repeat(43), 'fox_click', TARGET.argsHash)).toBeNull();
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
