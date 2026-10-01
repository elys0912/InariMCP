/**
 * The API token (~/.kitsune-mcp/api_token). Only the daemon creates it;
 * relays and the Native Host read it after the daemon has answered /health.
 * It never travels: both sides use it as the HMAC key (auth.ts).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { apiTokenPath } from './paths.js';

/**
 * Read the API token without creating it. Returns undefined when missing,
 * unreadable or empty.
 */
export function readApiTokenFile(tokenPath: string = apiTokenPath()): string | undefined {
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load or generate the API token (daemon only).
 *
 * - Reads `~/.kitsune-mcp/api_token` if it exists.
 * - Otherwise generates a 64-char hex token (crypto.randomBytes(32)) and
 *   persists it with mode 0o600 in a 0o700 directory.
 */
export function loadOrCreateApiToken(tokenPath: string = apiTokenPath()): string {
  const existing = readApiTokenFile(tokenPath);
  if (existing !== undefined) return existing;

  // Create the file exclusively ('wx'): when two daemons start at the same
  // moment, only one of them writes a token and the other reads it, so the
  // token on disk always matches the one the surviving daemon holds.
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tokenPath, token, { mode: 0o600, flag: 'wx' });
    process.stderr.write(`[KitsuneMCP] Generated new API token at ${tokenPath}\n`);
    return token;
  } catch (err: unknown) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
  }

  // Someone else created it: wait briefly for its content.
  for (let i = 0; i < 20; i++) {
    const other = readApiTokenFile(tokenPath);
    if (other !== undefined) return other;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  // Still empty (corrupt file): replace it.
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  process.stderr.write(`[KitsuneMCP] Replaced empty API token file at ${tokenPath}\n`);
  return token;
}
