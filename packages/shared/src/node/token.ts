/**
 * The API token (~/.inari-mcp/api_token). Only the daemon creates it;
 * relays and the Native Host read it after the daemon has answered /health.
 * It never travels: both sides use it as the HMAC key (auth.ts).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errnoCode } from '../util.js';
import { apiTokenPath, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './paths.js';

/** Random bytes of a new token (64 hex characters). */
const TOKEN_BYTES = 32;
/** How long to wait for another daemon's token content: TOKEN_WAIT_TRIES × TOKEN_WAIT_MS. */
const TOKEN_WAIT_TRIES = 20;
const TOKEN_WAIT_MS = 50;

/**
 * Read the token file: undefined when it does not exist or is empty. Any
 * other error (EACCES, EISDIR, ...) is thrown.
 */
function readTokenStrict(tokenPath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(tokenPath, 'utf-8');
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  const token = content.trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Read the API token without creating it (relays, the Native Host, doctor).
 * Returns undefined when missing, unreadable or empty: these callers report
 * "no token" and retry later instead of failing. The daemon uses
 * loadOrCreateApiToken, which throws on an unreadable file.
 */
export function readApiTokenFile(tokenPath: string = apiTokenPath()): string | undefined {
  try {
    return readTokenStrict(tokenPath);
  } catch {
    return undefined;
  }
}

/**
 * Load or generate the API token (daemon only).
 *
 * - Reads `~/.inari-mcp/api_token` if it exists.
 * - Otherwise generates a 64-char hex token (crypto.randomBytes(32)) and
 *   persists it with mode 0o600 in a 0o700 directory.
 * - Throws when the file exists but cannot be read (EACCES, EISDIR, ...) or
 *   stays empty: the daemon must not start with a token nobody else can read.
 */
export function loadOrCreateApiToken(tokenPath: string = apiTokenPath()): string {
  const existing = readTokenStrict(tokenPath);
  if (existing !== undefined) return existing;

  // Create the file exclusively ('wx'): when two daemons start at the same
  // moment, only one of them writes a token and the other reads it, so the
  // token on disk always matches the one the surviving daemon holds.
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.writeFileSync(tokenPath, token, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    process.stderr.write(`[InariMCP] Generated new API token at ${tokenPath}\n`);
    return token;
  } catch (err: unknown) {
    if (errnoCode(err) !== 'EEXIST') throw err;
  }

  // Someone else created it: wait briefly for its content.
  for (let i = 0; i < TOKEN_WAIT_TRIES; i++) {
    const other = readTokenStrict(tokenPath);
    if (other !== undefined) return other;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TOKEN_WAIT_MS);
  }

  // Still empty: either a corrupt file or a writer that is very slow. Do not
  // overwrite it (the other daemon may still write its own token, and the two
  // would then hold different tokens); let the user remove it.
  throw new Error(`API token file ${tokenPath} exists but is empty; delete it and start the daemon again`);
}
