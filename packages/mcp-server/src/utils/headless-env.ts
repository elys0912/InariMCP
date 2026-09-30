import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';

/** `1`, `true` or `yes` (any case) — nothing else enables a flag (`0`, `false`, `off`, … do not). */
export function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

/** The first non-empty value of FOX_* or its legacy CLAUDE_BROWSER_* name. */
function resolve(env: NodeJS.ProcessEnv, foxKey: string, legacyKey: string): string | undefined {
  for (const key of [foxKey, legacyKey]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * Whether the headless (Playwright) backend is selected. The legacy name
 * CLAUDE_BROWSER_HEADLESS is still read, like every other legacy setting.
 */
export function isHeadlessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(resolve(env, ENV.FOX_HEADLESS, LEGACY_ENV.CLAUDE_BROWSER_HEADLESS));
}

/** Startup timeout of the headless Firefox in ms (default ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT). */
export function headlessStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = resolve(
    env,
    ENV.FOX_HEADLESS_STARTUP_TIMEOUT,
    LEGACY_ENV.CLAUDE_BROWSER_HEADLESS_STARTUP_TIMEOUT,
  );
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ENV_DEFAULTS.FOX_HEADLESS_STARTUP_TIMEOUT;
}
