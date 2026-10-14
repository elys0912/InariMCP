import { ENV, ENV_DEFAULTS } from '@inari-mcp/shared';

const TRUTHY_VALUES: readonly string[] = ['1', 'true', 'yes'];
const FALSY_VALUES: readonly string[] = ['0', 'false', 'no', 'off'];

/** `1`, `true` or `yes` (any case) — nothing else enables a flag (`0`, `false`, `off`, … do not). */
export function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_VALUES.includes(value.trim().toLowerCase());
}

/** `0`, `false`, `no` or `off` (any case). */
export function isFalsyEnv(value: string | undefined): boolean {
  return value !== undefined && FALSY_VALUES.includes(value.trim().toLowerCase());
}

/**
 * The raw FOX_HEADLESS value when it is neither enabling nor a known "off"
 * (e.g. `on`, `y`): it is treated as off, and the daemon says so in its log.
 */
export function unrecognizedHeadlessValue(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = resolveFoxEnv(env, ENV.FOX_HEADLESS);
  if (raw === undefined || isTruthyEnv(raw)) return undefined;
  return isFalsyEnv(raw) ? undefined : raw;
}

/**
 * The value of a FOX_* setting; a blank value (empty or white space only)
 * counts as unset, and a value is returned without surrounding white space
 * (a path such as FOX_EXECUTABLE is used as is). Every daemon setting is
 * read this way (safety/config.ts, utils/screenshot.ts, the doctor).
 */
export function resolveFoxEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Whether the headless (Playwright) backend is selected (FOX_HEADLESS). */
export function isHeadlessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(resolveFoxEnv(env, ENV.FOX_HEADLESS));
}

/** Startup timeout of the headless Firefox in ms (default ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT). */
export function headlessStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = resolveFoxEnv(env, ENV.FOX_HEADLESS_STARTUP_TIMEOUT);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT;
}
