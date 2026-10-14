/**
 * Where the shared daemon listens, the API token, and the daemon settings a
 * relay compares with the running daemon. Host / port / token resolution
 * lives in @inari-mcp/shared/node (also used by the Native Host).
 */

import { ENV, ENV_DEFAULTS, isRecord } from '@inari-mcp/shared';
import { isElicitationApprovalEnabled } from '../safety/approval.js';
import {
  headlessStartupTimeoutMs,
  isHeadlessEnabled,
  isTruthyEnv,
  resolveFoxEnv,
} from './headless-env.js';

// Host / ports, the API token: shared with the Native Host (@inari-mcp/shared/node).
export {
  isLoopbackHost,
  loadOrCreateApiToken,
  readApiTokenFile,
  resolveHost,
  resolveHttpPort,
  resolveWsPort,
} from '@inari-mcp/shared/node';

/** HTTP header a relay uses to identify itself to the daemon (audit log, idle tracking). */
export const RELAY_ID_HEADER = 'x-inari-relay';

/**
 * Largest request body the daemon reads (1 MiB, generous for any JSON
 * payload); a larger one is answered 413. Here rather than in the HTTP
 * bridge so the relay can name the limit without loading the transports.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

/** Relay IDs: 1-32 characters of A-Z, a-z, 0-9, `_` and `-` (relays send shortId()); anything else is ignored. */
export function isValidRelayId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

/** Settings compared between a session and the running daemon, by their FOX_* name. */
export const DAEMON_SETTINGS = [
  'FOX_HEADLESS',
  'FOX_HEADLESS_STARTUP_TIMEOUT',
  'FOX_EXECUTABLE',
  'FOX_SCREENSHOTS_DIR',
  'FOX_SAFETY_CONFIG',
  'FOX_READ_ONLY',
  'FOX_APPROVAL_ELICITATION',
] as const;
export type DaemonSettingName = (typeof DAEMON_SETTINGS)[number];

/**
 * Environment variables that configure the daemon (safety policy, backend,
 * screenshot directory): every DAEMON_SETTINGS name. They are read by the
 * daemon process only: a relay passes its own values on when it spawns the
 * daemon, and warns when an already-running daemon was started with
 * different values.
 */
export const DAEMON_SETTING_KEYS: readonly string[] = DAEMON_SETTINGS.map((name) => ENV[name]);
/** What each setting amounts to, e.g. 'on' / 'off' or a resolved value; '' = default. */
export type EffectiveDaemonSettings = Record<DaemonSettingName, string>;

type Env = Record<string, string | undefined>;

/**
 * The effective value of every DAEMON_SETTINGS entry for `env`, so that
 * `FOX_HEADLESS=true`, `=1` and `=yes` compare equal.
 * 'current' follows this version's parsing; 'legacy' follows how a daemon
 * without `effectiveSettings` in /daemon/info read its environment (only `1`
 * turns read-only on).
 */
export function effectiveDaemonSettings(
  env: Env,
  rules: 'current' | 'legacy' = 'current',
): EffectiveDaemonSettings {
  const cur = rules === 'current';
  const pick = (key: string): string | undefined =>
    // legacy: a raw `settings` from an old daemon holds '' for unset keys, which is "unset" here
    cur ? resolveFoxEnv(env, key) : (env[key] || undefined);
  const onOff = (v: boolean): string => (v ? 'on' : 'off');
  return {
    FOX_HEADLESS: onOff(cur ? isHeadlessEnabled(env) : Boolean(env[ENV.FOX_HEADLESS])),
    FOX_HEADLESS_STARTUP_TIMEOUT: String(
      cur
        ? headlessStartupTimeoutMs(env)
        : Number(env[ENV.FOX_HEADLESS_STARTUP_TIMEOUT]) || ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT,
    ),
    FOX_EXECUTABLE: pick(ENV.FOX_EXECUTABLE) ?? '',
    FOX_SCREENSHOTS_DIR: pick(ENV.FOX_SCREENSHOTS_DIR) ?? '',
    FOX_SAFETY_CONFIG: pick(ENV.FOX_SAFETY_CONFIG) ?? '',
    FOX_READ_ONLY: onOff(cur ? isTruthyEnv(pick(ENV.FOX_READ_ONLY)) : pick(ENV.FOX_READ_ONLY) === '1'),
    FOX_APPROVAL_ELICITATION: onOff(isElicitationApprovalEnabled(env)),
  };
}

/** One line per setting that differs, e.g. "FOX_READ_ONLY: this session 'on', daemon 'off'". */
export function diffDaemonSettings(
  mine: EffectiveDaemonSettings,
  theirs: EffectiveDaemonSettings,
): string[] {
  const show = (v: string): string => (v === '' ? '(default)' : v);
  return DAEMON_SETTINGS.filter((k) => mine[k] !== theirs[k]).map(
    (k) => `${k}: this session '${show(mine[k])}', daemon '${show(theirs[k])}'`,
  );
}

/** The daemon's effective settings from a /daemon/info body; older daemons only sent raw `settings`. */
export function daemonSettingsFromInfo(body: Record<string, unknown>): EffectiveDaemonSettings | null {
  const raw = body['settings'];
  const rawStrings: Env = {};
  if (isRecord(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') rawStrings[k] = v;
  } else if (!('effectiveSettings' in body)) {
    return null;
  }
  const fallback = effectiveDaemonSettings(rawStrings, 'legacy');
  const eff = body['effectiveSettings'];
  if (!isRecord(eff)) return fallback;
  const out = { ...fallback };
  for (const k of DAEMON_SETTINGS) {
    const v = eff[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * How a session's settings compare with those of the running daemon, the one
 * rule shared by the relay (DaemonClient.checkSettings) and the doctor:
 * effective values, so `true` and `1` agree.
 *
 * @param sessionEnv the environment the session would start a daemon with
 * @param info       the body of the daemon's GET /daemon/info
 * @returns one line per differing setting (empty when they agree); null when
 *          `info` carries no settings (unknown, not "equal")
 */
export function compareDaemonSettings(sessionEnv: Env, info: Record<string, unknown>): string[] | null {
  const theirs = daemonSettingsFromInfo(info);
  if (theirs === null) return null;
  return diffDaemonSettings(effectiveDaemonSettings(sessionEnv), theirs);
}

/** Current values of DAEMON_SETTING_KEYS ('' when unset). */
export function snapshotDaemonSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DAEMON_SETTING_KEYS) {
    out[key] = process.env[key] ?? '';
  }
  return out;
}
