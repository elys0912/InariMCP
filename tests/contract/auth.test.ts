/**
 * Contract: the daemon (mcp-server/src/transport/auth.ts) and the Native
 * Host (native-host/src/auth.ts) authenticate each other with the same MACs.
 *
 * Why it matters: the two packages cannot share the module (the Native Host
 * does not depend on mcp-server, and shared has no Node types), so the file
 * exists twice. If the copies drift, every handshake fails — or worse, one
 * side stops checking what the other proves.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as serverAuth from '../../packages/mcp-server/src/transport/auth.js';
import * as hostAuth from '../../packages/native-host/src/auth.js';

const TOKEN = 'a'.repeat(64);

function source(rel: string): string {
  return fs
    .readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
    .replace(/\r\n/g, '\n');
}

describe('auth.ts copies', () => {
  it('are identical', () => {
    expect(source('../../packages/native-host/src/auth.ts')).toBe(
      source('../../packages/mcp-server/src/transport/auth.ts'),
    );
  });

  it('agree on protocol constants', () => {
    expect(hostAuth.AUTH_PROTOCOL).toBe(serverAuth.AUTH_PROTOCOL);
    expect(hostAuth.DAEMON_PROTOCOL_VERSION).toBe(serverAuth.DAEMON_PROTOCOL_VERSION);
    expect(hostAuth.AUTH_HEADER).toEqual(serverAuth.AUTH_HEADER);
    expect(hostAuth.MAC_LABEL).toEqual(serverAuth.MAC_LABEL);
  });
});

describe('MACs', () => {
  const s = serverAuth.newNonce();
  const c = hostAuth.newNonce();

  it('are computed alike on both sides', () => {
    for (const label of Object.values(serverAuth.MAC_LABEL)) {
      expect(hostAuth.computeMac(TOKEN, label, s, c)).toBe(serverAuth.computeMac(TOKEN, label, s, c));
    }
  });

  it('differ per label, so one proof never passes as another', () => {
    const macs = Object.values(serverAuth.MAC_LABEL).map((l) => serverAuth.computeMac(TOKEN, l, s, c));
    expect(new Set(macs).size).toBe(macs.length);
  });

  it('depend on the token and on both nonces', () => {
    const base = serverAuth.computeMac(TOKEN, 'ws-client', s, c);
    expect(serverAuth.computeMac('b'.repeat(64), 'ws-client', s, c)).not.toBe(base);
    expect(serverAuth.computeMac(TOKEN, 'ws-client', serverAuth.newNonce(), c)).not.toBe(base);
    expect(serverAuth.computeMac(TOKEN, 'ws-client', s, serverAuth.newNonce())).not.toBe(base);
  });

  it('refuse parts containing a newline (field boundaries stay unambiguous)', () => {
    expect(() => serverAuth.computeMac(TOKEN, 'http-request', 'GET', '/a\n/b')).toThrow();
  });

  it('macMatches accepts only the exact 64-hex MAC', () => {
    const mac = serverAuth.computeMac(TOKEN, 'health', s);
    expect(serverAuth.macMatches(mac, mac)).toBe(true);
    expect(serverAuth.macMatches(mac.toUpperCase(), mac)).toBe(false);
    expect(serverAuth.macMatches(mac.slice(0, 63), mac)).toBe(false);
    expect(serverAuth.macMatches(undefined, mac)).toBe(false);
    expect(serverAuth.macMatches(TOKEN, mac)).toBe(false);
  });

  it('nonces are 128-bit hex and fresh', () => {
    expect(serverAuth.isNonce(s)).toBe(true);
    expect(serverAuth.isNonce('x'.repeat(32))).toBe(false);
    expect(serverAuth.newNonce()).not.toBe(serverAuth.newNonce());
  });
});

describe('signed HTTP exchange', () => {
  it('a response signed by one copy verifies with the other, and only for its own request', () => {
    const req = hostAuth.signRequest(TOKEN, 'GET', '/daemon/info');
    const body = '{"relays":1}';
    const sig = serverAuth.responseMac(TOKEN, req.nonce, 200, body);
    expect(hostAuth.verifyResponse(TOKEN, req.nonce, 200, body, sig)).toBe(true);
    expect(hostAuth.verifyResponse(TOKEN, req.nonce, 200, '{"relays":2}', sig)).toBe(false);
    expect(hostAuth.verifyResponse(TOKEN, req.nonce, 500, body, sig)).toBe(false);
    expect(hostAuth.verifyResponse(TOKEN, hostAuth.newNonce(), 200, body, sig)).toBe(false);
    expect(hostAuth.verifyResponse('b'.repeat(64), req.nonce, 200, body, sig)).toBe(false);
  });

  it('request headers never contain the token', () => {
    const req = serverAuth.signRequest(TOKEN, 'POST', '/mcp/call', '{}');
    expect(JSON.stringify(req.headers)).not.toContain(TOKEN);
  });
});
