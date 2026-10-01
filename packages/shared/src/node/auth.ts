/**
 * Challenge-response authentication between the daemon and its clients
 * (Native Host over WebSocket, relays and the Native Host over HTTP).
 *
 * Both sides hold the shared API token (~/.kitsune-mcp/api_token), but the
 * token itself never travels: each side proves it knows the token with
 * HMAC-SHA256 over fresh nonces. A program that grabbed the daemon's port
 * without the token (threat model 7.High "fake daemon") learns nothing it
 * could replay, and its answers fail the client's check.
 *
 * MAC input: `kitsune-hmac-v1 \n <label> \n <part> \n <part> …`. Labels keep
 * the uses apart (a health proof can never pass as a WS server proof).
 * Parts must not contain '\n'; nonces are validated hex, methods and paths
 * come from the HTTP parser.
 *
 *  WebSocket (ws-bridge.ts ⇔ native-host/src/ws-client.ts)
 *   1. daemon → host  { type: 'auth_challenge', protocol, nonce: S }
 *   2. host → daemon  { type: 'auth', protocol, nonce: C, mac: MAC('ws-client', S, C) }
 *   3. daemon → host  { type: 'auth_ok', mac: MAC('ws-server', S, C) }
 *      (the host accepts commands only after checking this MAC)
 *
 *  HTTP (http-bridge.ts ⇔ relay/daemon-client.ts, native-host server-launcher.ts)
 *   request headers   x-kitsune-timestamp: T, x-kitsune-nonce: N,
 *                     x-kitsune-signature: MAC('http-request', METHOD, PATH, T, N, sha256(body))
 *   response header   x-kitsune-signature: MAC('http-response', N, STATUS, sha256(body))
 *   The daemon rejects timestamps outside ±HTTP_SIGNATURE_WINDOW_MS and
 *   nonces it has already seen.
 *
 *  GET /health with x-kitsune-nonce: N adds `proof: MAC('health', N)`.
 *
 * Used by both sides through `@kitsune-mcp/shared/node`.
 */

import * as crypto from 'node:crypto';

/** Name of the scheme, sent in the WS handshake frames. */
export const AUTH_PROTOCOL = 'kitsune-hmac-v1';

/**
 * Daemon ⇔ client protocol version, reported by GET /health as `protocol`.
 * 2 = challenge-response authentication (1, implicit: plaintext token).
 * Clients refuse to talk to a daemon with another version.
 */
export const DAEMON_PROTOCOL_VERSION = 2;

export const MAC_LABEL = {
  wsClient: 'ws-client',
  wsServer: 'ws-server',
  httpRequest: 'http-request',
  httpResponse: 'http-response',
  health: 'health',
} as const;

export type MacLabel = (typeof MAC_LABEL)[keyof typeof MAC_LABEL];

export const AUTH_HEADER = {
  timestamp: 'x-kitsune-timestamp',
  nonce: 'x-kitsune-nonce',
  signature: 'x-kitsune-signature',
} as const;

/** Accepted clock difference for signed HTTP requests (same machine). */
export const HTTP_SIGNATURE_WINDOW_MS = 60_000;

/** Random bytes of a nonce (128 bits). */
const NONCE_BYTES = 16;
/** Bytes of an HMAC-SHA256. */
const MAC_BYTES = 32;
const NONCE_RE = new RegExp(`^[0-9a-f]{${NONCE_BYTES * 2}}$`);
const MAC_RE = new RegExp(`^[0-9a-f]{${MAC_BYTES * 2}}$`);

/** 128-bit random nonce, lowercase hex. */
export function newNonce(): string {
  return crypto.randomBytes(NONCE_BYTES).toString('hex');
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE_RE.test(value);
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** HMAC-SHA256 (hex) of `AUTH_PROTOCOL \n label \n parts…` keyed with the token. */
export function computeMac(token: string, label: MacLabel, ...parts: string[]): string {
  for (const part of parts) {
    if (part.includes('\n')) throw new Error('MAC input part contains a newline');
  }
  return crypto
    .createHmac('sha256', token)
    .update([AUTH_PROTOCOL, label, ...parts].join('\n'))
    .digest('hex');
}

/** Constant-time comparison of a received MAC with the expected one. */
export function macMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !MAC_RE.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

// ---------------------------------------------------------------------------
// HTTP helpers (client side)
// ---------------------------------------------------------------------------

export interface SignedRequest {
  headers: Record<string, string>;
  /** Needed to check the response signature. */
  nonce: string;
}

/** Headers that authenticate one HTTP request without sending the token. */
export function signRequest(
  token: string,
  method: string,
  urlPath: string,
  body: string | Buffer = '',
  now: number = Date.now(),
): SignedRequest {
  const nonce = newNonce();
  const timestamp = String(now);
  const signature = computeMac(
    token, MAC_LABEL.httpRequest, method.toUpperCase(), urlPath, timestamp, nonce, sha256Hex(body),
  );
  return {
    nonce,
    headers: {
      [AUTH_HEADER.timestamp]: timestamp,
      [AUTH_HEADER.nonce]: nonce,
      [AUTH_HEADER.signature]: signature,
    },
  };
}

/** Signature the daemon puts on its answer to a signed request. */
export function responseMac(token: string, nonce: string, status: number, body: string | Buffer): string {
  return computeMac(token, MAC_LABEL.httpResponse, nonce, String(status), sha256Hex(body));
}

/** True when the response really comes from a daemon holding the token. */
export function verifyResponse(
  token: string,
  nonce: string,
  status: number,
  body: string | Buffer,
  signatureHeader: unknown,
): boolean {
  return macMatches(signatureHeader, responseMac(token, nonce, status, body));
}
