/**
 * Where the shared daemon listens, and the API token that authenticates to it. Used by the daemon itself (to bind) and
 * by the relay (to reach it), so both resolve the same env vars the same way.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return fallback;
}

export function resolveHttpPort(): number {
  return parsePort(
    process.env[ENV.FOX_HTTP_PORT] ?? process.env[LEGACY_ENV.CLAUDE_BROWSER_HTTP_PORT],
    ENV_DEFAULTS.FOX_HTTP_PORT,
  );
}

export function resolveWsPort(): number {
  return parsePort(
    process.env[ENV.FOX_WS_PORT] ?? process.env[LEGACY_ENV.CLAUDE_BROWSER_WS_PORT],
    ENV_DEFAULTS.FOX_WS_PORT,
  );
}

export function resolveHost(): string {
  return (
    process.env[ENV.FOX_HOST] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HOST] ??
    ENV_DEFAULTS.FOX_HOST
  );
}

/**
 * True for addresses only this machine can reach (127.0.0.0/8, ::1,
 * localhost). Anything else — 0.0.0.0 in particular — exposes the daemon's
 * ports to the network.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || h === '::ffff:127.0.0.1';
}

/** HTTP header a relay uses to identify itself to the daemon (audit log, idle tracking). */
export const RELAY_ID_HEADER = 'x-kitsune-relay';

/** Relay IDs are short random hex strings; anything else is ignored. */
export function isValidRelayId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

/**
 * Environment variables that configure the daemon (safety policy, backend,
 * screenshot directory). They are read by the daemon process only: a relay
 * passes its own values on when it spawns the daemon, and warns when an
 * already-running daemon was started with different values.
 */
export const DAEMON_SETTING_KEYS: readonly string[] = [
  ENV.FOX_HEADLESS,
  ENV.FOX_HEADLESS_STARTUP_TIMEOUT,
  ENV.FOX_EXECUTABLE,
  ENV.FOX_SCREENSHOTS_DIR,
  ENV.FOX_SAFETY_CONFIG,
  ENV.FOX_READ_ONLY,
  ENV.FOX_ALLOW_SCRIPTS,
  ENV.FOX_APPROVAL_ELICITATION,
  LEGACY_ENV.CLAUDE_BROWSER_EXECUTABLE,
  LEGACY_ENV.CLAUDE_BROWSER_SCREENSHOTS_DIR,
  LEGACY_ENV.CLAUDE_BROWSER_SAFETY_CONFIG,
  LEGACY_ENV.CLAUDE_BROWSER_READ_ONLY,
  LEGACY_ENV.CLAUDE_BROWSER_ALLOW_SCRIPTS,
];

/** Current values of DAEMON_SETTING_KEYS ('' when unset). */
export function snapshotDaemonSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DAEMON_SETTING_KEYS) {
    out[key] = process.env[key] ?? '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// API token management (only the daemon creates it; relays and the
// Native Host read it after the daemon has answered /health)
// ---------------------------------------------------------------------------

function getTokenPath(): string {
  return path.join(os.homedir(), '.kitsune-mcp', 'api_token');
}

/**
 * Load or generate the API token.
 *
 * - Reads from `~/.kitsune-mcp/api_token` if it exists.
 * - Otherwise generates a 64-char hex token via crypto.randomBytes(32)
 *   and persists it.
 */
export function loadOrCreateApiToken(): string {
  const tokenPath = getTokenPath();

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

/**
 * Read the API token without creating it (relays must not generate one:
 * only the daemon does). Returns undefined when missing or empty.
 */
export function readApiTokenFile(tokenPath: string = getTokenPath()): string | undefined {
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
