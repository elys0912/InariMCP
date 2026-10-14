import { describe, expect, it } from 'vitest';
import {
  DAEMON_PROTOCOL_VERSION,
  MAC_LABEL,
  computeMac,
  evaluateHealth,
  isUsable,
  newNonce,
  protocolText,
} from '@inari-mcp/shared/node';

const TOKEN = 'c'.repeat(64);

describe('evaluateHealth (4.A4)', () => {
  const nonce = newNonce();
  const good = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      status: 'ok',
      service: 'inari-mcp',
      version: '0.1.0',
      protocol: DAEMON_PROTOCOL_VERSION,
      proof: computeMac(TOKEN, MAC_LABEL.health, nonce),
      ...extra,
    });

  it('ok: our daemon, proof checked', () => {
    expect(evaluateHealth(200, good(), TOKEN, nonce)).toEqual({ kind: 'ok', version: '0.1.0' });
  });

  it('unverified: compatible, but no token to check the proof yet', () => {
    expect(evaluateHealth(200, good(), undefined, nonce).kind).toBe('unverified');
  });

  it('foreign: anything that merely contains "ok"', () => {
    expect(evaluateHealth(200, 'look, ok!', TOKEN, nonce).kind).toBe('foreign');
    expect(evaluateHealth(200, '{"status":"ok"}', TOKEN, nonce).kind).toBe('foreign');
    expect(evaluateHealth(200, '["ok"]', TOKEN, nonce).kind).toBe('foreign');
    expect(evaluateHealth(500, good(), TOKEN, nonce).kind).toBe('foreign');
  });

  it('incompatible: an older daemon without (or with another) protocol', () => {
    const old = JSON.stringify({ status: 'ok', service: 'inari-mcp', version: '0.0.9' });
    expect(evaluateHealth(200, old, TOKEN, nonce)).toEqual({ kind: 'incompatible', protocol: undefined, version: '0.0.9' });
    expect(evaluateHealth(200, good({ protocol: 99 }), TOKEN, nonce).kind).toBe('incompatible');
  });

  it('impostor: a proof that does not match our token / nonce', () => {
    expect(evaluateHealth(200, good({ proof: undefined }), TOKEN, nonce).kind).toBe('impostor');
    expect(evaluateHealth(200, good(), TOKEN, newNonce()).kind).toBe('impostor');
    expect(evaluateHealth(200, good(), 'd'.repeat(64), nonce).kind).toBe('impostor');
  });

  it('only ok / unverified are usable', () => {
    expect(isUsable({ kind: 'ok' })).toBe(true);
    expect(isUsable({ kind: 'unverified' })).toBe(true);
    for (const kind of ['down', 'foreign', 'impostor'] as const) expect(isUsable({ kind })).toBe(false);
    expect(isUsable({ kind: 'incompatible', protocol: 1 })).toBe(false);
  });
});

describe('protocolText', () => {
  it('shows a number or string protocol as is', () => {
    expect(protocolText(2)).toBe('2');
    expect(protocolText('3')).toBe('3');
  });

  it('shows a missing or non-primitive protocol as "1 or older"', () => {
    expect(protocolText(undefined)).toBe('1 or older');
    expect(protocolText({ major: 9 })).toBe('1 or older');
  });
});
