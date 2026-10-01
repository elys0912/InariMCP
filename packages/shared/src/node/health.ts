/**
 * Judging a GET /health answer — the same rules for the daemon (singleton
 * check), the relays, the Native Host and `doctor`.
 *
 * A KitsuneMCP daemon answers 200 with JSON `{ status: 'ok', service:
 * 'kitsune-mcp', protocol, version, … }`, plus `proof` (MAC over the
 * x-kitsune-nonce header, auth.ts) when asked.
 */

import { isRecord } from '../util.js';
import { DAEMON_PROTOCOL_VERSION, MAC_LABEL, computeMac, macMatches } from './auth.js';

export const HEALTH_SERVICE = 'kitsune-mcp';

/**
 * What answered GET /health:
 *  down         nothing (connection refused, timeout) — decided by the caller
 *  foreign      something that is not a KitsuneMCP daemon
 *  incompatible a KitsuneMCP daemon of another protocol (an older build)
 *  impostor     claims to be the daemon but cannot prove it holds the token
 *  unverified   a compatible daemon; no token yet to check its proof
 *  ok           a compatible daemon that proved it holds our token
 */
export type HealthVerdict =
  | { kind: 'down' }
  | { kind: 'foreign' }
  | { kind: 'incompatible'; protocol: unknown; version?: string }
  | { kind: 'impostor' }
  | { kind: 'unverified'; version?: string }
  | { kind: 'ok'; version?: string };

function parse(body: unknown): unknown {
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString());
    } catch {
      return undefined;
    }
  }
  return body;
}

/**
 * The /health body when it comes from a KitsuneMCP daemon (any protocol),
 * else undefined. `body` may be raw text / bytes or already parsed JSON.
 */
export function kitsuneHealth(statusCode: number | undefined, body: unknown): Record<string, unknown> | undefined {
  if (statusCode !== 200) return undefined;
  const health = parse(body);
  if (!isRecord(health) || health['status'] !== 'ok' || health['service'] !== HEALTH_SERVICE) return undefined;
  return health;
}

/** Classify a /health answer: strict JSON, protocol, and the nonce proof when we have a token. */
export function evaluateHealth(
  statusCode: number | undefined,
  body: unknown,
  token: string | undefined,
  nonce: string,
): HealthVerdict {
  const health = kitsuneHealth(statusCode, body);
  if (health === undefined) return { kind: 'foreign' };

  const version = typeof health['version'] === 'string' ? health['version'] : undefined;
  const withVersion = version === undefined ? {} : { version };
  if (health['protocol'] !== DAEMON_PROTOCOL_VERSION) {
    return { kind: 'incompatible', protocol: health['protocol'], ...withVersion };
  }
  if (token === undefined) return { kind: 'unverified', ...withVersion };
  if (!macMatches(health['proof'], computeMac(token, MAC_LABEL.health, nonce))) return { kind: 'impostor' };
  return { kind: 'ok', ...withVersion };
}

/** A daemon we can use: compatible, and not caught failing its proof. */
export function isUsable(verdict: HealthVerdict): boolean {
  return verdict.kind === 'ok' || verdict.kind === 'unverified';
}
