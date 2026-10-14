import { describe, expect, it } from 'vitest';
import {
  MAC_LABEL,
  computeMac,
  isNonce,
  macMatches,
  newNonce,
  responseMac,
  signRequest,
  verifyResponse,
} from '@inari-mcp/shared/node';

const TOKEN = 'a'.repeat(64);

describe('shared/node auth', () => {
  it('MACs differ per label, so one proof never passes as another', () => {
    const s = newNonce();
    const c = newNonce();
    const macs = Object.values(MAC_LABEL).map((l) => computeMac(TOKEN, l, s, c));
    expect(new Set(macs).size).toBe(macs.length);
  });

  it('a signed response verifies only for its own request, body and token', () => {
    const req = signRequest(TOKEN, 'GET', '/daemon/info');
    expect(JSON.stringify(req.headers)).not.toContain(TOKEN);
    const sig = responseMac(TOKEN, req.nonce, 200, '{"relays":1}');
    expect(verifyResponse(TOKEN, req.nonce, 200, '{"relays":1}', sig)).toBe(true);
    expect(verifyResponse(TOKEN, req.nonce, 200, '{"relays":2}', sig)).toBe(false);
    expect(verifyResponse('b'.repeat(64), req.nonce, 200, '{"relays":1}', sig)).toBe(false);
  });

  it('macMatches accepts only the exact 64-char lowercase hex MAC', () => {
    const mac = computeMac(TOKEN, MAC_LABEL.health, newNonce());
    expect(macMatches(mac, mac)).toBe(true);
    for (const bad of [undefined, null, 42, '', mac.slice(0, 63), `${mac}0`, mac.toUpperCase(), `${mac.slice(0, 63)}g`, [mac]]) {
      expect(macMatches(bad, mac), String(bad)).toBe(false);
    }
    const other = `${mac.slice(0, 63)}${mac.endsWith('0') ? '1' : '0'}`;
    expect(macMatches(other, mac)).toBe(false);
  });

  it('a newline in any MAC part throws, so parts cannot be shifted across the separator', () => {
    expect(() => computeMac(TOKEN, MAC_LABEL.httpRequest, 'GET', '/a\n/b')).toThrow(/newline/);
    expect(() => signRequest(TOKEN, 'GET', '/x\ny')).toThrow(/newline/);
  });

  it('nonces are fresh 32-char lowercase hex; isNonce rejects anything else', () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(isNonce(a)).toBe(true);
    expect(newNonce()).not.toBe(a);
    for (const bad of [undefined, 1, '', a.slice(1), `${a}0`, a.toUpperCase(), `${a.slice(1)}z`]) {
      expect(isNonce(bad), String(bad)).toBe(false);
    }
  });
});
