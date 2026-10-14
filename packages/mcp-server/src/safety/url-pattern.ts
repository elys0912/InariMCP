/**
 * URL patterns of safety.json (blocked / allowed / protected_url_patterns).
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
 * Earlier releases treated every pattern as an unanchored regex over the raw
 * URL. Such legacy patterns keep working where possible:
 *   - simple ones are read as the equivalent host pattern: `paypal\.com`
 *     (host and subdomains), `\.gov(/|$)` (subdomains only),
 *     `^https://a\.example/` (that host only, as the anchor meant);
 *   - any other legacy regex keeps its old meaning in blocked/protected lists
 *     (over-matching errs on the safe side there), with a warning;
 *   - in the allowed list it is an error: an unanchored allowlist regex is
 *     exactly the bypass this module exists to close.
 *
 * Host and scheme compare case-insensitively (the URL parser lower-cases
 * them, IDN hosts become punycode). Each list errs towards refusing:
 *   - allowed: the path matches as written (case-sensitive, at a segment
 *     boundary: /admin does not cover /administrator);
 *   - blocked / protected: the path matches any continuation after
 *     percent-escapes are decoded, repeated slashes collapsed and case
 *     folded (/admin covers /ADMIN, //admin, /%61dmin, /admin;x, /administrator).
 */

import type { WireUrlRule } from '@inari-mcp/shared';

export type PatternListName = 'blocked' | 'allowed' | 'protected';

export interface UrlPattern {
  /** The pattern as written in safety.json. */
  readonly source: string;
  readonly kind: 'host' | 'regex' | 'legacy';
  test(url: string): boolean;
  /**
   * The same pattern as a URL rule for the Extension (BrowserCommand
   * `protectedUrlRules` / `blockedUrlRules` / `allowedUrlRules`), which
   * matches it like test() (extension/src/url-rule.ts, contract test
   * tests/contract/url-rule.test.ts).
   */
  readonly wire: WireUrlRule;
  /**
   * Legacy: equivalent regex source for Extension builds that only know
   * `protectedUrlPatterns` and test `new RegExp(source, 'i')` against the
   * raw tab URL (percent-escapes not decoded).
   */
  readonly wireSource: string;
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
// tells it from a regex character class), `:port` (validated below, so that
// a bad one is an error rather than a legacy regex), path.
const HOST_FORM_RE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?(\[[^\s/\]]*:[^\s/\]]*\]|[^\s/?#:@*\\^$()[\]{}|+]+)(?::([^\s/?#]*))?(\/[^\s]*)?$/i;

const REGEX_META_RE = /[\\^$()[\]{}|+?*]/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

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

/** The same in wireSource: what may precede the host. */
const SUBDOMAIN_RE: { readonly [K in HostSpec['hosts']]: string } = {
  exact: '',
  sub: '(?:[^/?#@]+\\.)',
  tree: '(?:[^/?#@]+\\.)?',
};

/** Why a host-form pattern is unusable, or a spec. */
type ParseResult = HostSpec | { error: string } | null;

function parseHostForm(s: string): ParseResult {
  const m = HOST_FORM_RE.exec(s);
  if (!m) return null;
  const ipv6 = m[3]!.startsWith('[');
  const host = canonicalHost(m[3]!);
  if (host === null) return ipv6 ? { error: `'${m[3]}' is not a valid IPv6 address` } : null;
  if (ipv6 && m[2] !== undefined) return { error: "'*.' cannot precede an IP address" };
  let port: number | null = null;
  if (m[4] !== undefined) {
    // `localhost:\d+` and the like are legacy regexes, not a port.
    if (!/^\d+$/.test(m[4]) && REGEX_META_RE.test(s)) return null;
    port = /^\d{1,5}$/.test(m[4]) ? Number(m[4]) : 0;
    if (port < 1 || port > 65535) return { error: `'${m[4]}' is not a valid port (1-65535)` };
  }
  let path: string | null = m[5] ?? null;
  // The path is compared with the URL's path only, which never holds a query
  // or fragment: such a pattern would match nothing. `%3F` / `%23` are refused
  // too, since blocked / protected paths are compared decoded and the wire
  // rule must not carry a `?` / `#` (the Extension refuses such a rule).
  if (path !== null && /[?#]|%3f|%23/i.test(path)) {
    return {
      error:
        "'?', '#' (or %3F, %23) cannot appear in a path: patterns compare the URL path only, " +
        'not the query or fragment. Drop them, or use "re:" for a whole-URL match',
    };
  }
  // A trailing `/*` is the usual way to write "any path below".
  if (path !== null && path.endsWith('/*')) path = path.slice(0, -1);
  if (path !== null && path.includes('*')) {
    return { error: "'*' in a path is only supported as a trailing '/*'" };
  }
  if (path === '/') path = null;
  return {
    scheme: m[1] ? m[1].toLowerCase() : null,
    hosts: m[2] !== undefined ? 'sub' : 'tree',
    host,
    port,
    path,
  };
}

/**
 * Read a legacy regex as a host pattern when that keeps its intent:
 * `\.` → `.`, `\/` → `/`, a trailing `(/|$)`, a leading `^https?://`
 * (then the host is exact, as the anchor meant) and a leading `\.` (then
 * subdomains only, as the old "any host ending in .x") are understood.
 */
function convertLegacy(s: string): HostSpec | null {
  let t = s;
  let scheme: string | null = null;
  const anchored = /^\^(https?)(\?)?:\\?\/\\?\//i.exec(t);
  if (anchored) {
    scheme = anchored[2] ? null : anchored[1]!.toLowerCase();
    t = t.slice(anchored[0].length);
  }
  t = t.replace(/\((?:\/\|\$|\$\|\/)\)$/, '');
  t = t.replace(/\\([./-])/g, '$1');
  let subdomainsOnly = false;
  if (!anchored && t.startsWith('.')) {
    t = t.slice(1);
    subdomainsOnly = true;
  }
  if (REGEX_META_RE.test(t)) return null;
  const spec = parseHostForm(t);
  if (spec === null || 'error' in spec) return null;
  return {
    ...spec,
    scheme: spec.scheme ?? scheme,
    hosts: anchored ? 'exact' : subdomainsOnly ? 'sub' : spec.hosts,
  };
}

/**
 * Path as compared by blocked/protected entries: percent-escapes decoded,
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
  // exactly (case-sensitive, at a segment boundary); a blocked or protected
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

  const scheme = spec.scheme !== null ? escapeRegex(spec.scheme) : '[a-z][a-z0-9+.-]*';
  const sub = SUBDOMAIN_RE[spec.hosts];
  let tail: string;
  if (wantPath === null) {
    tail = '(?:[/?#]|$)';
  } else {
    // Repeated slashes as in loosePath(); percent-escapes cannot be decoded
    // in a regex and are matched as written.
    const pathRe = wantPath.split('/').map(escapeRegex).join('\\/+');
    tail = pathRe + (pathBoundary ? '(?:[/?#]|$)' : '');
  }
  // A default port does not appear in the URL, so it is optional here (with
  // no scheme in the pattern this also lets e.g. :443 match http://…/, which
  // errs on the safe side for the lists this legacy form serves).
  const port =
    spec.port === null ? '(?::\\d+)?'
      : Object.values(DEFAULT_PORTS).includes(spec.port) ? `(?::${spec.port})?`
        : `:${spec.port}`;
  const wireSource =
    `^${scheme}:\\/\\/(?:[^/?#]*@)?${sub}${escapeRegex(spec.host)}\\.?${port}${tail}`;

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

  return { source, kind: 'host', test, wire, wireSource };
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

function regexPattern(
  source: string,
  regexSource: string,
  kind: 'regex' | 'legacy',
  list: PatternListName,
): UrlPattern | { error: string } {
  let re: RegExp;
  try {
    re = new RegExp(regexSource, 'i');
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    source,
    kind,
    // Allowed: the normalised URL only. Blocked / protected: either form
    // (the Extension tests the raw tab URL with wireSource).
    test: (raw: string) => {
      const n = normalizeUrl(raw);
      if (n === null) return list !== 'allowed' && re.test(raw);
      return re.test(n.normalized) || (list !== 'allowed' && re.test(raw));
    },
    wire: { kind: 'regex', source, re: regexSource, matchRaw: list !== 'allowed' },
    wireSource: regexSource,
  };
}

export function compileUrlPatterns(
  sources: readonly string[],
  list: PatternListName,
): CompiledPatterns {
  const patterns: UrlPattern[] = [];
  const issues: PatternIssue[] = [];

  for (const source of sources) {
    const s = source.trim();
    if (s === '') {
      issues.push({ pattern: source, message: 'empty pattern', fatal: true });
      continue;
    }

    if (s.startsWith('re:')) {
      // Always a whole-URL match, in every list (the legacy branch below
      // keeps its old unanchored meaning).
      const compiled = regexPattern(source, anchorRegex(s.slice(3)), 'regex', list);
      if ('error' in compiled) {
        issues.push({ pattern: source, message: `invalid regex: ${compiled.error}`, fatal: true });
      } else {
        patterns.push(compiled);
      }
      continue;
    }

    const parsed = parseHostForm(s);
    if (parsed !== null && 'error' in parsed) {
      issues.push({ pattern: source, message: parsed.error, fatal: true });
      continue;
    }
    const spec = parsed ?? (REGEX_META_RE.test(s) ? convertLegacy(s) : null);
    if (spec !== null) {
      patterns.push(hostPattern(source, spec, list));
      // A dot-less name written as a host pattern (any case, with or without
      // a scheme, port or path; not a converted legacy regex) is easily
      // mistaken for "any URL containing it".
      if (
        list !== 'allowed' && parsed !== null && !spec.host.includes('.') && !spec.host.startsWith('[') &&
        spec.hosts === 'tree'
      ) {
        issues.push({
          pattern: source,
          message:
            `matches only the host '${spec.host}' and its subdomains ` +
            `(e.g. www.${spec.host}), not '${spec.host}.com' or other names containing it`,
          fatal: false,
        });
      }
      continue;
    }

    if (list === 'allowed') {
      issues.push({
        pattern: source,
        message:
          'not a host pattern (e.g. "example.com", "*.example.com", "example.com/path"); ' +
          'an allowlist entry that is a bare regex could match unintended URLs. ' +
          'Rewrite it as a host pattern, or as "re:https://example\\.com/.*" (re: matches the whole URL)',
        fatal: true,
      });
      continue;
    }

    const legacy = regexPattern(source, s, 'legacy', list);
    if ('error' in legacy) {
      issues.push({ pattern: source, message: `invalid pattern: ${legacy.error}`, fatal: true });
      continue;
    }
    patterns.push(legacy);
    issues.push({
      pattern: source,
      message:
        'legacy regex, matched anywhere in the URL; rewrite it as a host pattern ' +
        'or as "re:" (which matches the whole URL)',
      fatal: false,
    });
  }

  return { patterns, issues };
}
