/**
 * Where the shared daemon listens. The daemon (to bind), the relays and the
 * Native Host (to reach it) resolve the same env vars the same way:
 *
 *   FOX_HOST      / CLAUDE_BROWSER_HOST       default 127.0.0.1
 *   FOX_HTTP_PORT / CLAUDE_BROWSER_HTTP_PORT  default 8765
 *   FOX_WS_PORT   / CLAUDE_BROWSER_WS_PORT    default 8766
 *
 * An empty value counts as unset (the legacy name, then the default, apply).
 * A port must be an integer in 1..65535; anything else falls back to the
 * default (reported through `onInvalid` when given).
 */

import { ENV, ENV_DEFAULTS, LEGACY_ENV, MAX_PORT } from '../constants.js';

type Env = Record<string, string | undefined>;

/** Called when a port variable is set but unusable. */
export type InvalidPortHandler = (name: string, raw: string, fallback: number) => void;

function portOf(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT ? n : undefined;
}

export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  return portOf(raw) ?? fallback;
}

/**
 * The first of `names` that is set to a non-empty value. An empty value
 * counts as unset, so `FOX_HOST=` falls through to the legacy name and then
 * to the default (it must not become `''`, which binds every interface).
 */
function pick(env: Env, ...names: string[]): { name: string; raw: string } | undefined {
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined && raw !== '') return { name, raw };
  }
  return undefined;
}

function resolvePortVar(
  fox: string,
  legacy: string,
  fallback: number,
  env: Env,
  onInvalid: InvalidPortHandler | undefined,
): number {
  const found = pick(env, fox, legacy);
  if (found === undefined) return fallback;
  const port = portOf(found.raw);
  if (port === undefined) onInvalid?.(found.name, found.raw, fallback);
  return port ?? fallback;
}

export function resolveHost(env: Env = process.env): string {
  return pick(env, ENV.FOX_HOST, LEGACY_ENV.CLAUDE_BROWSER_HOST)?.raw ?? ENV_DEFAULTS.FOX_HOST;
}

export function resolveHttpPort(onInvalid?: InvalidPortHandler, env: Env = process.env): number {
  return resolvePortVar(ENV.FOX_HTTP_PORT, LEGACY_ENV.CLAUDE_BROWSER_HTTP_PORT, ENV_DEFAULTS.FOX_HTTP_PORT, env, onInvalid);
}

export function resolveWsPort(onInvalid?: InvalidPortHandler, env: Env = process.env): number {
  return resolvePortVar(ENV.FOX_WS_PORT, LEGACY_ENV.CLAUDE_BROWSER_WS_PORT, ENV_DEFAULTS.FOX_WS_PORT, env, onInvalid);
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
