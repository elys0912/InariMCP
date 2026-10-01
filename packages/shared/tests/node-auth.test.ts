import { describe, expect, it } from 'vitest';
import {
  MAC_LABEL,
  computeMac,
  newNonce,
  responseMac,
  signRequest,
  verifyResponse,
} from '@kitsune-mcp/shared/node';

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
  // TODO(test): macMatches rejects malformed MACs; newline in MAC parts throws; nonce format
});
