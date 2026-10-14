/**
 * Where the shared daemon listens. The daemon (to bind), the relays and the
 * Native Host (to reach it) resolve the same env vars the same way:
 *
 *   FOX_HOST       default 127.0.0.1
 *   FOX_HTTP_PORT  default 8785
 *   FOX_WS_PORT    default 8786
 *
 * An empty or blank value counts as unset (the default applies); a set value
 * is used without its surrounding blanks. A port must be an integer in
 * 1..65535; anything else falls back to the default (reported through
 * `onInvalid` when given).
 *
 * The host is taken through resolveDaemonHost() on both ends, which refuses
 * a FOX_HOST that is not a loopback address.
 */

import * as net from 'node:net';

import { ENV, ENV_DEFAULTS, MAX_PORT } from '../constants.js';

type Env = Record<string, string | undefined>;

/** Called when a port variable is set but unusable. */
export type InvalidPortHandler = (name: string, raw: string, fallback: number) => void;

function portOf(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= MAX_PORT ? n : undefined;
}

/** `raw` without surrounding blanks, or undefined when that leaves nothing. */
function nonBlank(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function parsePort(raw: string | undefined, fallback: number): number {
  const value = nonBlank(raw);
  if (value === undefined) return fallback;
  return portOf(value) ?? fallback;
}

function resolvePortVar(
  name: string,
  fallback: number,
  env: Env,
  onInvalid: InvalidPortHandler | undefined,
): number {
  const raw = nonBlank(env[name]);
  if (raw === undefined) return fallback;
  const port = portOf(raw);
  if (port === undefined) onInvalid?.(name, raw, fallback);
  return port ?? fallback;
}

/**
 * FOX_HOST, trimmed and unchecked: only through resolveDaemonHost(), which
 * refuses one that is not loopback. An empty or blank value counts as unset,
 * so `FOX_HOST=` (or `FOX_HOST=' '`) is the default: it must not become `''`,
 * which binds every interface, nor `' '`, which no socket accepts.
 */
function resolveHost(env: Env): string {
  return nonBlank(env[ENV.FOX_HOST]) ?? ENV_DEFAULTS.FOX_HOST;
}

export function resolveHttpPort(onInvalid?: InvalidPortHandler, env: Env = process.env): number {
  return resolvePortVar(ENV.FOX_HTTP_PORT, ENV_DEFAULTS.FOX_HTTP_PORT, env, onInvalid);
}

export function resolveWsPort(onInvalid?: InvalidPortHandler, env: Env = process.env): number {
  return resolvePortVar(ENV.FOX_WS_PORT, ENV_DEFAULTS.FOX_WS_PORT, env, onInvalid);
}

/**
 * 127.0.0.0/8 mapped into IPv6, as the WHATWG URL parser writes it
 * (`::ffff:127.0.0.1` → `::ffff:7f00:1`).
 */
const IPV4_MAPPED_LOOPBACK_RE = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/;

/** An IPv6 address in the one spelling of the WHATWG URL parser (`0:0:0:0:0:0:0:1` → `::1`), or null. */
function canonicalIPv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * True for addresses only this machine can reach: `localhost`, an IPv4
 * address in 127.0.0.0/8, and the IPv6 `::1` or 127.0.0.0/8 mapped into
 * IPv6 (`::ffff:127.0.0.1`), in any spelling of the address. A name that
 * only looks like one (`127.999.0.1`, `127.1`) is no IP address: it would
 * go to the name resolver, so it is refused. Anything else, 0.0.0.0 in
 * particular, exposes the daemon's ports to the network.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost') return true;

  switch (net.isIP(h)) {
    case 4:
      return h.startsWith('127.');
    case 6: {
      const canonical = canonicalIPv6(h);
      return canonical === '::1' || (canonical !== null && IPV4_MAPPED_LOOPBACK_RE.test(canonical));
    }
    default:
      return false;
  }
}

/**
 * FOX_HOST (resolveHost) for every process on the daemon link: the daemon
 * binds it, the Native Host and the relays connect to it. The link is plain
 * HTTP and WebSocket and carries page content and tool arguments, so a
 * host that is not a loopback address (isLoopbackHost) throws instead of
 * being used.
 */
export function resolveDaemonHost(env: Env = process.env): string {
  const host = resolveHost(env);
  if (!isLoopbackHost(host)) {
    throw new Error(
      `${ENV.FOX_HOST}=${host} is not a loopback address (127.0.0.0/8, ::1, localhost). ` +
      'The daemon serves plain HTTP and WebSocket and is reached on this machine only: ' +
      `unset ${ENV.FOX_HOST} or set it to 127.0.0.1.`,
    );
  }
  return host;
}
