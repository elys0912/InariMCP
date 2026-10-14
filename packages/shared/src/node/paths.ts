/**
 * Files under ~/.inari-mcp, shared by the daemon, the relays and the
 * Native Host. Resolved at call time (os.homedir()), so a changed HOME /
 * USERPROFILE — as in the tests — is honoured.
 *
 *   ~/.inari-mcp/
 *     api_token          written by the daemon only (token.ts)
 *     safety.json        safety policy (mcp-server safety/config.ts; FOX_SAFETY_CONFIG overrides)
 *     screenshots/       default FOX_SCREENSHOTS_DIR
 *     logs/daemon.log    stderr of a detached daemon (relay or Native Host started it)
 *     logs/native-host.log
 *     logs/audit.jsonl   SafetyGuard audit log
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** Mode of the directories created under ~/.inari-mcp (POSIX; ignored on Windows). */
export const PRIVATE_DIR_MODE = 0o700;
/** Mode of the files written there (api_token, logs). */
export const PRIVATE_FILE_MODE = 0o600;

export function dataDir(): string {
  return path.join(os.homedir(), '.inari-mcp');
}

export function apiTokenPath(): string {
  return path.join(dataDir(), 'api_token');
}

export function logsDir(): string {
  return path.join(dataDir(), 'logs');
}

export function daemonLogPath(): string {
  return path.join(logsDir(), 'daemon.log');
}

export function nativeHostLogPath(): string {
  return path.join(logsDir(), 'native-host.log');
}

export function auditLogPath(): string {
  return path.join(logsDir(), 'audit.jsonl');
}

export function defaultSafetyConfigPath(): string {
  return path.join(dataDir(), 'safety.json');
}

export function defaultScreenshotsDir(): string {
  return path.join(dataDir(), 'screenshots');
}

/** Longest stem kept from a caller-chosen screenshot filename. */
export const SCREENSHOT_STEM_MAX = 120;

/**
 * The usable stem of a caller-chosen screenshot filename: its base name
 * (after `/` or `\`) without an image extension (.png / .jpg / .jpeg /
 * .webp), characters other than A-Z a-z 0-9 . _ - replaced by `_`, leading
 * dots removed, cut to SCREENSHOT_STEM_MAX. Null when nothing usable
 * remains (the caller generates a name). The Native Host (Extension path)
 * and the headless backend name files this way, so the same `filename`
 * gives the same file on both.
 */
export function screenshotStem(requested: string | undefined): string | null {
  if (!requested) return null;
  const base = path.posix.basename(requested.replace(/\\/g, '/'));
  const withoutExt = base.replace(/\.(png|jpe?g|webp)$/i, '');
  const safe = withoutExt.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return safe === '' ? null : safe.slice(0, SCREENSHOT_STEM_MAX);
}
