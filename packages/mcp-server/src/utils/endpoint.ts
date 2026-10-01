/**
 * Where the shared daemon listens, the API token, and the daemon settings a
 * relay compares with the running daemon. Host / port / token resolution
 * lives in @kitsune-mcp/shared/node (also used by the Native Host).
 */

import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';
import { isElicitationApprovalEnabled } from '../safety/approval.js';
import {
  headlessStartupTimeoutMs,
  isFalsyEnv,
  isHeadlessEnabled,
  isTruthyEnv,
  resolveFoxEnv,
} from './headless-env.js';

// Host / ports, the API token: shared with the Native Host (@kitsune-mcp/shared/node).
export {
  isLoopbackHost,
  loadOrCreateApiToken,
  readApiTokenFile,
  resolveHost,
  resolveHttpPort,
  resolveWsPort,
} from '@kitsune-mcp/shared/node';

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
  LEGACY_ENV.CLAUDE_BROWSER_HEADLESS,
  LEGACY_ENV.CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT,
  LEGACY_ENV.CLAUDE_BROWSER_EXECUTABLE,
  LEGACY_ENV.CLAUDE_BROWSER_SCREENSHOTS_DIR,
  LEGACY_ENV.CLAUDE_BROWSER_SAFETY_CONFIG,
  LEGACY_ENV.CLAUDE_BROWSER_READ_ONLY,
  LEGACY_ENV.CLAUDE_BROWSER_ALLOW_SCRIPTS,
];

/** Settings compared between a session and the running daemon, by their FOX_* name. */
export const DAEMON_SETTINGS = [
  'FOX_HEADLESS',
  'FOX_HEADLESS_STARTUP_TIMEOUT',
  'FOX_EXECUTABLE',
  'FOX_SCREENSHOTS_DIR',
  'FOX_SAFETY_CONFIG',
  'FOX_READ_ONLY',
  'FOX_ALLOW_SCRIPTS',
  'FOX_APPROVAL_ELICITATION',
] as const;
export type DaemonSettingName = (typeof DAEMON_SETTINGS)[number];
/** What each setting amounts to, e.g. 'on' / 'off' or a resolved value; '' = default. */
export type EffectiveDaemonSettings = Record<DaemonSettingName, string>;

type Env = Record<string, string | undefined>;

/**
 * The effective value of every DAEMON_SETTINGS entry for `env`, so that
 * `FOX_HEADLESS=true`, `=1` and `CLAUDE_BROWSER_HEADLESS=yes` compare equal.
 * 'current' follows this version's parsing; 'legacy' follows how a daemon
 * without `effectiveSettings` in /daemon/info read its environment (FOX_ value
 * or else the old name; only `1` turns read-only on, only `0` turns scripts off).
 */
export function effectiveDaemonSettings(
  env: Env,
  rules: 'current' | 'legacy' = 'current',
): EffectiveDaemonSettings {
  const cur = rules === 'current';
  const pick = (fox: string, legacy: string): string | undefined =>
    // legacy: a raw `settings` from an old daemon holds '' for unset keys, which is "unset" here
    cur ? resolveFoxEnv(env, fox, legacy) : ((env[fox] || undefined) ?? (env[legacy] || undefined));
  const onOff = (v: boolean): string => (v ? 'on' : 'off');
  return {
    FOX_HEADLESS: onOff(cur ? isHeadlessEnabled(env) : Boolean(env[ENV.FOX_HEADLESS])),
    FOX_HEADLESS_STARTUP_TIMEOUT: String(
      cur
        ? headlessStartupTimeoutMs(env)
        : Number(env[ENV.FOX_HEADLESS_STARTUP_TIMEOUT]) || ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT,
    ),
    FOX_EXECUTABLE: pick(ENV.FOX_EXECUTABLE, LEGACY_ENV.CLAUDE_BROWSER_EXECUTABLE) ?? '',
    FOX_SCREENSHOTS_DIR: pick(ENV.FOX_SCREENSHOTS_DIR, LEGACY_ENV.CLAUDE_BROWSER_SCREENSHOTS_DIR) ?? '',
    FOX_SAFETY_CONFIG: pick(ENV.FOX_SAFETY_CONFIG, LEGACY_ENV.CLAUDE_BROWSER_SAFETY_CONFIG) ?? '',
    FOX_READ_ONLY: onOff(
      cur
        ? isTruthyEnv(pick(ENV.FOX_READ_ONLY, LEGACY_ENV.CLAUDE_BROWSER_READ_ONLY))
        : pick(ENV.FOX_READ_ONLY, LEGACY_ENV.CLAUDE_BROWSER_READ_ONLY) === '1',
    ),
    FOX_ALLOW_SCRIPTS: onOff(
      !(cur
        ? isFalsyEnv(pick(ENV.FOX_ALLOW_SCRIPTS, LEGACY_ENV.CLAUDE_BROWSER_ALLOW_SCRIPTS))
        : pick(ENV.FOX_ALLOW_SCRIPTS, LEGACY_ENV.CLAUDE_BROWSER_ALLOW_SCRIPTS) === '0'),
    ),
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
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') rawStrings[k] = v;
  } else if (!('effectiveSettings' in body)) {
    return null;
  }
  const fallback = effectiveDaemonSettings(rawStrings, 'legacy');
  const eff = body['effectiveSettings'];
  if (typeof eff !== 'object' || eff === null || Array.isArray(eff)) return fallback;
  const out = { ...fallback };
  for (const k of DAEMON_SETTINGS) {
    const v = (eff as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Current values of DAEMON_SETTING_KEYS ('' when unset). */
export function snapshotDaemonSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DAEMON_SETTING_KEYS) {
    out[key] = process.env[key] ?? '';
  }
  return out;
}
