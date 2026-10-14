/**
 * URL patterns of safety.json (blocked_url_patterns / allowed_url_patterns /
 * confirm_read_sites).
 *
 * A pattern is matched against the parsed URL, never against the raw string,
 * so `example.com.attacker.net`, `https://example.com@attacker.net/` or a
 * query string that mentions a host cannot satisfy it.
 *
 * Forms:
 *   host           `example.com`         the host and every subdomain
 *   subdomains     `*.example.com`       subdomains only
 *   host + path    `example.com/admin`   ... whose path starts with /admin
 *                                        (`example.com/*` = any path)
 *   scheme         `https://example.com` ... over that scheme only
 *   port           `example.com:8443`    ... on that port only (a URL without
 *                                        a port has its scheme's default:
 *                                        `example.com:443` = https://example.com/)
 *   IPv6           `[::1]`               the address, in brackets
 *   regex          `re:<regex>`          must match the whole (case-insensitive)
 *                                        normalised URL: scheme://host[:port]
 *                                        /path?query#hash, lower-case host, no
 *                                        userinfo. Always anchored as
 *                                        ^(?:<regex>)$ in every list, so
 *                                        `re:example\.com` does not match
 *                                        https://example.com.attacker.net/;
 *                                        end it with `.*` for "starts with".
 *
 * Anything else is an error in every list: a bare regex (`paypal\.com`) is
 * no pattern, since an unanchored regex over the URL is exactly the bypass
 * this module exists to close.
 *
 * Host and scheme compare case-insensitively (the URL parser lower-cases
 * them, IDN hosts become punycode). Each list errs towards refusing:
 *   - allowed: the path matches as written (case-sensitive, at a segment
 *     boundary: /admin does not cover /administrator);
 *   - blocked / confirm-read: the path matches any continuation after
 *     percent-escapes are decoded, repeated slashes collapsed and case
 *     folded (/admin covers /ADMIN, //admin, /%61dmin, /admin;x, /administrator).
 */

import type { WireUrlRule } from '@inari-mcp/shared';

export type PatternListName = 'blocked' | 'allowed' | 'confirmRead';

/** The safety.json key of each list (messages). */
export const PATTERN_LIST_KEYS: { readonly [K in PatternListName]: string } = {
  blocked: 'blocked_url_patterns',
  allowed: 'allowed_url_patterns',
  confirmRead: 'confirm_read_sites',
};

export interface UrlPattern {
  /** The pattern as written in safety.json. */
  readonly source: string;
  readonly kind: 'host' | 'regex';
  test(url: string): boolean;
  /**
   * The same pattern as a URL rule for the Extension (BrowserCommand
   * `confirmReadUrlRules` / `blockedUrlRules` / `allowedUrlRules`), which
   * matches it like test() (extension/src/url-rule.ts, contract test
   * tests/contract/url-rule.test.ts).
   */
  readonly wire: WireUrlRule;
}

export interface PatternIssue {
  pattern: string;
  message: string;
  /** true: the pattern cannot be used and the policy must fail closed. */
  fatal: boolean;
}

export interface CompiledPatterns {
  patterns: UrlPattern[];
  issues: PatternIssue[];
}

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

export interface NormalizedUrl {
  url: URL;
  /** Lower-case, no trailing dot. '' for URLs without a host (about:blank). */
  hostname: string;
  /** scheme://host[:port]/path?query#hash without userinfo. */
  normalized: string;
  hasUserinfo: boolean;
}

export function normalizeUrl(raw: string): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/\.$/, '');
  const hasUserinfo = url.username !== '' || url.password !== '';
  const normalized = url.host
    ? `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}${url.hash}`
    : url.href;
  return { url, hostname, normalized, hasUserinfo };
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21,
};

/** The URL's port, or its scheme's default (the parser drops a default port); null if none. */
function effectivePort(url: URL): number | null {
  if (url.port !== '') return Number(url.port);
  return DEFAULT_PORTS[url.protocol] ?? null;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

// scheme, `*.`, host (a name, or an IPv6 address in brackets: a ':' inside
// tells it from a regex character class), `:port` (validated below), path.
const HOST_FORM_RE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?(\[[^\s/\]]*:[^\s/\]]*\]|[^\s/?#:@*\\^$()[\]{}|+]+)(?::([^\s/?#]*))?(\/[^\s]*)?$/i;

/** `example.com` → 'example.com' (punycode, lower-case) or null if not a host. */
function canonicalHost(host: string): string | null {
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  try {
    const parsed = new URL(`http://${host}/`);
    // Anything the parser moved out of the host (port, path) means not a host.
    if (parsed.port || parsed.pathname !== '/') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

interface HostSpec {
  scheme: string | null;
  /** 'tree': the host and its subdomains; 'sub': subdomains only; 'exact': the host only. */
  hosts: 'tree' | 'sub' | 'exact';
  host: string;
  /** Required port (a URL without one has its scheme's default), or null for any. */
  port: number | null;
  /** Path prefix, or null for any path. */
  path: string | null;
}

/** Whether hostname `h` is one of the hosts a spec covers, by `hosts`. */
const HOST_MATCHES: { readonly [K in HostSpec['hosts']]: (h: string, host: string) => boolean } = {
  exact: (h, host) => h === host,
  sub: (h, host) => h.endsWith(`.${host}`),
  tree: (h, host) => h === host || h.endsWith(`.${host}`),
};

/** Why a host-form pattern is unusable, or a spec. */
type ParseResult = HostSpec | { error: string } | null;

/** Whether a part of a host pattern is unusable (it carries the reason). */
function isProblem(part: number | string | null | { error: string }): part is { error: string } {
  return part !== null && typeof part === 'object';
}

/** The `:port` of a host pattern: null when there is none, else a port number (1-65535) or why not. */
function parsePort(raw: string | undefined): number | null | { error: string } {
  if (raw === undefined) return null;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  if (port < 1 || port > 65535) return { error: `'${raw}' is not a valid port (1-65535)` };
  return port;
}

/** The path of a host pattern: null for any path, else the prefix to compare, or why it cannot be used. */
function parsePath(raw: string | undefined): string | null | { error: string } {
  if (raw === undefined) return null;
  // The path is compared with the URL's path only, which never holds a query
  // or fragment: such a pattern would match nothing. `%3F` / `%23` are refused
  // too, since blocked / confirm-read paths are compared decoded and the wire
  // rule must not carry a `?` / `#` (the Extension refuses such a rule).
  if (/[?#]|%3f|%23/i.test(raw)) {
    return {
      error:
        "'?', '#' (or %3F, %23) cannot appear in a path: patterns compare the URL path only, " +
        'not the query or fragment. Drop them, or use "re:" for a whole-URL match',
    };
  }
  // A trailing `/*` is the usual way to write "any path below".
  const path = raw.endsWith('/*') ? raw.slice(0, -1) : raw;
  if (path.includes('*')) {
    return { error: "'*' in a path is only supported as a trailing '/*'" };
  }
  return path === '/' ? null : path;
}

function parseHostForm(s: string): ParseResult {
  const m = HOST_FORM_RE.exec(s);
  if (!m) return null;
  const ipv6 = m[3].startsWith('[');
  const host = canonicalHost(m[3]);
  if (host === null) return ipv6 ? { error: `'${m[3]}' is not a valid IPv6 address` } : null;
  if (ipv6 && m[2] !== undefined) return { error: "'*.' cannot precede an IP address" };
  const port = parsePort(m[4]);
  if (isProblem(port)) return port;
  const path = parsePath(m[5]);
  if (isProblem(path)) return path;
  return {
    scheme: m[1] ? m[1].toLowerCase() : null,
    hosts: m[2] !== undefined ? 'sub' : 'tree',
    host,
    port,
    path,
  };
}

/**
 * Path as compared by blocked / confirm-read entries: percent-escapes decoded,
 * repeated slashes collapsed, lower case, so `/%61dmin`, `//admin` and
 * `/ADMIN` all read as `/admin`.
 */
function loosePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed escapes: compare as written.
  }
  return p.replace(/\/{2,}/g, '/').toLowerCase();
}

function hostPattern(source: string, spec: HostSpec, list: PatternListName): UrlPattern {
  // Each list errs towards refusing: an allowed entry matches its path
  // exactly (case-sensitive, at a segment boundary); a blocked or confirm-read
  // entry matches any path that starts with it once normalised.
  const strictPath = list === 'allowed';
  const path = spec.path;
  const wantPath = path === null ? null : strictPath ? path : loosePath(path);
  const pathBoundary = strictPath && path !== null && !path.endsWith('/');

  const test = (raw: string): boolean => {
    const n = normalizeUrl(raw);
    if (n === null || n.hostname === '') return false;
    if (spec.scheme !== null && n.url.protocol !== `${spec.scheme}:`) return false;
    if (!HOST_MATCHES[spec.hosts](n.hostname, spec.host)) return false;
    if (spec.port !== null && effectivePort(n.url) !== spec.port) return false;
    if (wantPath === null) return true;
    const actual = strictPath ? n.url.pathname : loosePath(n.url.pathname);
    if (!actual.startsWith(wantPath)) return false;
    return !pathBoundary || actual.length === wantPath.length || actual[wantPath.length] === '/';
  };

  const wire: WireUrlRule = {
    kind: 'host',
    source,
    scheme: spec.scheme,
    hosts: spec.hosts,
    host: spec.host,
    port: spec.port,
    path: wantPath,
    pathMatch: strictPath ? 'strict' : 'loose',
  };

  return { source, kind: 'host', test, wire };
}

/**
 * `re:` source -> a regex that must match the whole URL: ^(?:inner)$, where a
 * leading `^` and an unescaped trailing `$` already written are dropped
 * (without the m flag anchors are idempotent; this only avoids doubling them).
 */
function anchorRegex(src: string): string {
  let inner = src.startsWith('^') ? src.slice(1) : src;
  if (inner.endsWith('$')) {
    let backslashes = 0;
    for (let i = inner.length - 2; i >= 0 && inner[i] === '\\'; i--) backslashes++;
    if (backslashes % 2 === 0) inner = inner.slice(0, -1);
  }
  return `^(?:${inner})$`;
}

function regexPattern(source: string, regexSource: string, list: PatternListName): UrlPattern | { error: string } {
  let re: RegExp;
  try {
    re = new RegExp(regexSource, 'i');
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    source,
    kind: 'regex',
    // Allowed: the normalised URL only. Blocked / confirm-read: either form
    // (over-matching errs on the safe side there).
    test: (raw: string) => {
      const n = normalizeUrl(raw);
      if (n === null) return list !== 'allowed' && re.test(raw);
      return re.test(n.normalized) || (list !== 'allowed' && re.test(raw));
    },
    wire: { kind: 'regex', source, re: regexSource, matchRaw: list !== 'allowed' },
  };
}

/** One entry of a list, compiled: its pattern (none when it is unusable) and its issues. */
interface CompiledEntry {
  pattern?: UrlPattern;
  issues: PatternIssue[];
}

function fatalEntry(source: string, message: string): CompiledEntry {
  return { issues: [{ pattern: source, message, fatal: true }] };
}

/** A `re:` entry: always a whole-URL match, in every list. */
function compileRegexEntry(source: string, regex: string, list: PatternListName): CompiledEntry {
  const compiled = regexPattern(source, anchorRegex(regex), list);
  if ('error' in compiled) return fatalEntry(source, `invalid regex: ${compiled.error}`);
  return { pattern: compiled, issues: [] };
}

/**
 * A dot-less name written as a host pattern (any case, with or without a
 * scheme, port or path) is easily mistaken for "any URL containing it":
 * warned about in the blocked and confirm-read lists.
 */
function singleLabelWarnings(source: string, spec: HostSpec, list: PatternListName): PatternIssue[] {
  const singleLabel = !spec.host.includes('.') && !spec.host.startsWith('[') && spec.hosts === 'tree';
  if (list === 'allowed' || !singleLabel) return [];
  return [{
    pattern: source,
    message:
      `matches only the host '${spec.host}' and its subdomains ` +
      `(e.g. www.${spec.host}), not '${spec.host}.com' or other names containing it`,
    fatal: false,
  }];
}

const NOT_A_PATTERN_MESSAGE =
  'not a host pattern (e.g. "example.com", "*.example.com", "example.com/path"); ' +
  'a bare regex could match unintended URLs. ' +
  'Rewrite it as a host pattern, or as "re:https://example\\.com/.*" (re: matches the whole URL)';

function compileEntry(source: string, list: PatternListName): CompiledEntry {
  const s = source.trim();
  if (s === '') return fatalEntry(source, 'empty pattern');
  if (s.startsWith('re:')) return compileRegexEntry(source, s.slice(3), list);

  const spec = parseHostForm(s);
  if (spec === null) return fatalEntry(source, NOT_A_PATTERN_MESSAGE);
  if ('error' in spec) return fatalEntry(source, spec.error);
  return { pattern: hostPattern(source, spec, list), issues: singleLabelWarnings(source, spec, list) };
}

export function compileUrlPatterns(
  sources: readonly string[],
  list: PatternListName,
): CompiledPatterns {
  const patterns: UrlPattern[] = [];
  const issues: PatternIssue[] = [];
  for (const source of sources) {
    const entry = compileEntry(source, list);
    if (entry.pattern !== undefined) patterns.push(entry.pattern);
    issues.push(...entry.issues);
  }
  return { patterns, issues };
}
