/**
 * The tests that drive a real headless Firefox (contract-firefox,
 * mcp-server-firefox) are skipped when Firefox cannot be launched. On CI, or
 * with KITSUNE_REQUIRE_FIREFOX set (`npm run test:firefox` sets it), that
 * would hide every regression they cover, so there a launch failure fails the
 * run instead.
 */

/** Set by `npm run test:firefox`; any CI may set it too, whether or not it sets `CI`. */
export const REQUIRE_FIREFOX_ENV = 'KITSUNE_REQUIRE_FIREFOX';

/** Set to anything but empty, `0` or `false` (any case). */
function isSet(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** `CI` is set to anything but empty, `0` or `false`. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSet(env['CI']);
}

/** The real-browser tests must run: on CI, or with KITSUNE_REQUIRE_FIREFOX set. */
export function requiresFirefox(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCi(env) || isSet(env[REQUIRE_FIREFOX_ENV]);
}

/**
 * What to do when Firefox could not be launched: throw when the tests must
 * run (requiresFirefox), else return (the caller marks the real-browser tests
 * to be skipped).
 */
export function skipOrFailWithoutFirefox(err: unknown, env: NodeJS.ProcessEnv = process.env): void {
  if (!requiresFirefox(env)) return;
  const reason = err instanceof Error ? err.message : String(err);
  const why = isCi(env) ? 'CI is set' : `${REQUIRE_FIREFOX_ENV} is set`;
  throw new Error(`Firefox could not be launched, and ${why}, so the real-browser tests must run: ${reason}`);
}
